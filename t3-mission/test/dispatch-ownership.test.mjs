import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as kernel from "../kernel/index.mjs";
import { createMissionHudServer } from "../hud/server.mjs";
import { resumeWorker } from "../bridge/t3-adapter.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-ownership-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
    "--no-gpg-sign",
  ]);
  kernel.proposeMission(dir, {
    repoPath: dir,
    title: "Ownership fixture",
    milestones: [{ id: "m1", title: "M1" }],
    features: [{ id: "f1", title: "F1", milestoneId: "m1" }],
    modelSettings: { skipScrutiny: true, skipUserTesting: true },
  });
  kernel.approveMissionPlan(dir);
  return dir;
}
function receipt(dir) {
  const s = kernel.loadState(dir);
  return {
    featureId: "f1",
    runId: s.activeWorker.runId,
    expectedRevision: s.revision,
    taskId: "accepted-task",
    childThreadId: "accepted-thread",
    runtimeTransport: "t3-delegate-task",
  };
}
function bytes(dir) {
  const p = kernel.getMissionPaths(dir);
  return Object.fromEntries(
    ["statePath", "featuresPath", "modelSettingsPath", "progressLogPath"].map((k) => [
      k,
      fs.readFileSync(p[k], "utf8"),
    ]),
  );
}
async function post(hud, action) {
  const res = await fetch(`${hud.url}/api/mission/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker: { reasoningEffort: "max" } }),
    signal: AbortSignal.timeout(4000),
  });
  return { status: res.status, body: await res.json() };
}

for (const entry of ["runner", "http"])
  test(`Committed Bind state EIO recovers before ${entry} can create another worker`, async (t) => {
    const dir = fixture(t);
    await kernel.startMissionRun(dir);
    const state = kernel.loadState(dir);
    state.status = "paused";
    state.activeWorker.status = "paused";
    state.sessions[0].status = "paused";
    kernel.saveState(dir, state);
    const input = receipt(dir),
      original = fs.renameSync,
      target = kernel.getMissionPaths(dir).statePath;
    let failed = false;
    fs.renameSync = function (a, b, ...rest) {
      if (!failed && String(b) === target) {
        failed = true;
        const e = new Error("owned one-shot EIO");
        e.code = "EIO";
        throw e;
      }
      return original.call(this, a, b, ...rest);
    };
    try {
      assert.throws(() => kernel.bindFeatureDispatch(dir, input), { code: "EIO" });
    } finally {
      fs.renameSync = original;
    }
    assert.equal(failed, true);
    const recovered = kernel.readMissionSnapshot(dir);
    for (const row of [
      recovered.state.activeWorker,
      recovered.state.sessions[0],
      recovered.featuresDoc.features[0],
    ]) {
      assert.equal(row.taskId, input.taskId);
      assert.equal(row.childThreadId, input.childThreadId);
    }
    const runId = recovered.state.activeWorker.runId;
    let dispatchCalls = 0,
      resumeCalls = 0;
    const adapter = {
      runFeature: async () => {
        dispatchCalls++;
        return { taskId: "duplicate", childThreadId: "duplicate" };
      },
      resumeWorker: async () => {
        resumeCalls++;
        return { resumed: true };
      },
    };
    if (entry === "http") {
      const hud = await createMissionHudServer({
        missionDir: dir,
        port: 0,
        dispatchAdapter: adapter,
      });
      try {
        const r = await post(hud, "resume");
        assert.equal(r.status, 200);
        assert.equal(r.body.state.activeWorker.runId, runId);
      } finally {
        await hud.close();
      }
    } else {
      const r = await kernel.startMissionRun(dir, {}, adapter);
      assert.equal(r.activeWorker.runId, runId);
    }
    assert.equal(dispatchCalls, 0);
    assert.equal(resumeCalls, 1);
    const complete = bytes(dir);
    kernel.bindFeatureDispatch(dir, input);
    assert.deepEqual(bytes(dir), complete);
    assert.equal(kernel.loadState(dir).sessions.length, 1);
  });

for (const via of ["kernel", "MCP"])
  for (const initial of [false, true])
    for (const outcome of ["throws", "pending", "conflicting-result"])
      test(`A Bind committed inside ${via} ${initial ? "initial" : "pending"} dispatch survives ${outcome}`, async (t) => {
        const dir = fixture(t);
        if (!initial) await kernel.startMissionRun(dir);
        let committed,
          calls = 0;
        const adapter = {
          runFeature: async () => {
            calls++;
            kernel.bindFeatureDispatch(dir, receipt(dir));
            committed = bytes(dir);
            if (outcome === "throws") throw new Error("callback failed after accepted Bind");
            if (outcome === "pending") return { dispatchPending: true };
            return { taskId: "conflicting-task", childThreadId: "conflicting-thread" };
          },
        };
        const invoke = () =>
          via === "MCP"
            ? callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: adapter })
            : kernel.startMissionRun(dir, {}, adapter);
        if (outcome === "throws") await assert.rejects(invoke, /callback failed/);
        else await invoke();
        assert.ok(committed);
        assert.deepEqual(bytes(dir), committed);
        await invoke();
        assert.equal(calls, 1);
        assert.deepEqual(bytes(dir), committed);
      });

for (const action of ["approve", "reject", "model-slots"])
  for (const throws of [false, true])
    test(`${action} preserves a hook's completed run${throws ? " after hook failure" : ""}`, async (t) => {
      const dir = fixture(t);
      await kernel.startMissionRun(dir);
      kernel.bindFeatureDispatch(dir, receipt(dir));
      let committed;
      const hud = await createMissionHudServer({
        missionDir: dir,
        port: 0,
        dispatchAdapter: {
          runFeature: async () => assert.fail("accepted task must not be delegated"),
        },
        onCommand: async (e) => {
          if (e.type !== action) return;
          const w = kernel.loadState(dir).activeWorker;
          kernel.endFeatureRun(dir, {
            runId: w.runId,
            featureId: w.featureId,
            successState: "success",
            validatorsPassed: true,
            handoff: {
              whatWasImplemented:
                "Completed the original accepted private fixture task and verified the final state without starting another task.",
            },
          });
          committed = bytes(dir);
          if (throws) throw new Error("hook failed after legitimate completion");
        },
      });
      try {
        const r = await post(hud, action);
        assert.equal(r.status, throws ? 500 : 409);
        assert.ok(committed);
        assert.deepEqual(bytes(dir), committed);
        assert.equal(kernel.loadState(dir).status, "completed");
      } finally {
        await hud.close();
      }
    });

test("An accepted task without a child thread never delegates from resumeWorker", async () => {
  let calls = 0;
  const result = await resumeWorker(
    {
      activeWorker: { taskId: "accepted-existing-task", featureId: "f1" },
      preflight: { canResume: true, hasConflicts: false, path: "/private/tmp" },
    },
    {
      transportClient: async () => {
        calls++;
        return { taskId: "duplicate", childThreadId: "duplicate" };
      },
    },
  );
  assert.equal(result.resumed, false);
  assert.equal(result.code, "DISPATCH_BINDING_REQUIRED");
  assert.equal(calls, 0);
});
