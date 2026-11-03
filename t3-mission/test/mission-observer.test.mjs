import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kernel from "../kernel/index.mjs";
import { createMissionHudServer } from "../hud/server.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { bounded, createHandlerHud, saveContractEvidence } from "./hud-handler-fixture.mjs";

async function fixture(t, { legacy = false, paused = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-observer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  kernel.proposeMission(dir, {
    repoPath: dir,
    title: "Already approved real mission",
    milestones: [{ id: "m1", title: "M1" }],
    features: [{ id: "f1", title: "Existing work", milestoneId: "m1" }],
    modelSettings: {
      worker: {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: { reasoningEffort: "high" },
      },
    },
  });
  kernel.approveMissionPlan(dir);
  await kernel.startMissionRun(dir);
  const state = kernel.loadState(dir);
  if (legacy) state.missionId = "mission-uninitialized";
  if (paused) {
    state.status = "paused";
    state.pausedAt = "2026-10-22T11:35:03.641Z";
    state.activeWorker.status = "paused";
    state.sessions[0].status = "paused";
  }
  kernel.saveState(dir, state);
  return { dir, state };
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
const receipt = {
  taskId: "node:delegated-task:real",
  childThreadId: "thread:delegated-task:real",
  runtimeTransport: "t3-delegate-task",
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "high" },
};
async function bind(dir, state, extra = {}) {
  return callMissionTool(
    "BindFeatureDispatch",
    {
      missionDir: dir,
      featureId: "f1",
      runId: state.activeWorker.runId,
      expectedRevision: state.revision,
      ...receipt,
      ...extra,
    },
    {
      dispatchAdapter: {
        runFeature() {
          assert.fail("binding must never dispatch");
        },
        resumeWorker() {
          assert.fail("binding must never resume");
        },
      },
    },
  );
}

test("HUD observation preserves a live external or pending run byte-for-byte", async (t) => {
  const { dir, state } = await fixture(t);
  for (const attached of [false, true]) {
    const s = kernel.loadState(dir);
    if (attached) Object.assign(s.activeWorker, receipt);
    kernel.saveState(dir, s);
    const before = bytes(dir);
    const hud = await createMissionHudServer({ missionDir: dir });
    try {
      const snap = await (await fetch(`${hud.url}/api/mission/state`)).json();
      assert.equal(snap.state.status, "running");
      assert.equal(snap.state.activeWorker.runId, state.activeWorker.runId);
      assert.deepEqual(bytes(dir), before);
    } finally {
      await hud.close();
    }
  }
});

test("HUD honors explicit initialization in a legacy placeholder-ID mission without rewriting it", async (t) => {
  const { dir, state } = await fixture(t, { legacy: true, paused: true });
  const before = bytes(dir);
  const hud = await createMissionHudServer({ missionDir: dir });
  try {
    const snap = await (await fetch(`${hud.url}/api/mission/state`)).json();
    assert.equal(snap.initialized, true);
    assert.equal(snap.state.title, state.title);
    assert.equal(snap.state.revision, state.revision);
    assert.equal(snap.state.activeWorker.runId, state.activeWorker.runId);
    assert.deepEqual(bytes(dir), before);
    const r = await fetch(`${hud.url}/api/mission/model-slots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(kernel.loadState(dir).initialized, true);
    assert.equal(kernel.loadState(dir).activeWorker.runId, state.activeWorker.runId);
    assert.equal(kernel.loadState(dir).missionId, "mission-uninitialized");
  } finally {
    await hud.close();
  }
});

test("BindFeatureDispatch attaches one accepted task to all run records and preserves user pause", async (t) => {
  const { dir, state } = await fixture(t, { paused: true });
  await bind(dir, state);
  const after = kernel.loadState(dir);
  assert.equal(after.status, "paused");
  assert.equal(after.pausedAt, state.pausedAt);
  assert.equal(after.activeWorker.runId, state.activeWorker.runId);
  assert.equal(after.sessions.length, 1);
  for (const record of [
    after.activeWorker,
    after.sessions[0],
    kernel.loadFeaturesDoc(dir).features[0],
  ]) {
    assert.equal(record.taskId, receipt.taskId);
    assert.equal(record.childThreadId, receipt.childThreadId);
    assert.equal(record.runtimeTransport, "t3-delegate-task");
    assert.equal(record.dispatchPending, undefined);
  }
  assert.equal(kernel.readProgressLog(dir).at(-1).type, "feature_dispatch_bound");
  const saved = bytes(dir);
  await bind(dir, state);
  assert.deepEqual(bytes(dir), saved, "identical replay must be write-free");
});

test("BindFeatureDispatch rejects stale runs, stale revisions, invalid receipts and conflicting IDs without writes", async (t) => {
  const { dir, state } = await fixture(t, { paused: true });
  for (const override of [
    { runId: "different" },
    { featureId: "different" },
    { expectedRevision: state.revision + 1 },
    { taskId: "" },
    { childThreadId: "" },
    { runtimeTransport: "orchestrator-pending" },
    { providerInstanceId: "wrong" },
    { target: { model: "wrong" } },
    { options: { reasoningEffort: "max" } },
    { workerNumber: 999 },
  ]) {
    const saved = bytes(dir);
    await assert.rejects(() => bind(dir, state, override));
    assert.deepEqual(bytes(dir), saved);
  }
  await bind(dir, state);
  const saved = bytes(dir);
  await assert.rejects(() => bind(dir, kernel.loadState(dir), { taskId: "other-task" }));
  assert.deepEqual(bytes(dir), saved);
});

test("An absent Mission cannot be initialized by Pause", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-observer-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hud = await createMissionHudServer({ missionDir: dir });
  try {
    const res = await fetch(`${hud.url}/api/mission/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "MISSION_NOT_INITIALIZED");
    assert.equal(fs.existsSync(kernel.getMissionPaths(dir).statePath), false);
  } finally {
    await hud.close();
  }
});

test("Attached-worker resume needs confirmed transport success and preserves failure bytes", async (t) => {
  const { dir, state } = await fixture(t, { paused: true });
  await bind(dir, state);
  for (const response of [
    null,
    {},
    { ok: false },
    { accepted: false },
    { resumed: true, response: { accepted: false } },
    { dispatchPending: true },
  ]) {
    const paused = kernel.loadState(dir);
    paused.pauseEpoch = (paused.pauseEpoch ?? 0) + 1;
    kernel.saveState(dir, paused);
    const before = bytes(dir);
    const result = await kernel.startMissionRun(dir, {}, { resumeWorker: async () => response });
    assert.equal(result.resumed, false);
    assert.deepEqual(bytes(dir), before);
  }
  const before = bytes(dir);
  assert.equal((await kernel.startMissionRun(dir)).code, "NO_T3_TRANSPORT");
  assert.deepEqual(bytes(dir), before);
  const nextPause = kernel.loadState(dir);
  nextPause.pauseEpoch = (nextPause.pauseEpoch ?? 0) + 1;
  kernel.saveState(dir, nextPause);
  const result = await kernel.startMissionRun(
    dir,
    {},
    {
      resumeWorker: async () => ({
        resumed: true,
        taskId: receipt.taskId,
        childThreadId: receipt.childThreadId,
      }),
    },
  );
  assert.equal(result.status, "running");
  assert.equal(result.activeWorker.runId, state.activeWorker.runId);
});

test("HUD refuses empty or rejected resume confirmations without changing files", async (t) => {
  const { dir, state } = await fixture(t, { paused: true });
  await bind(dir, state);
  for (const result of [
    null,
    {},
    { accepted: false },
    { resumed: true, response: { ok: false } },
  ]) {
    const before = bytes(dir);
    const hud = await createMissionHudServer({
      missionDir: dir,
      dispatchAdapter: { resumeWorker: async () => result },
    });
    try {
      const r = await fetch(`${hud.url}/api/mission/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 409);
      assert.deepEqual(bytes(dir), before);
    } finally {
      await hud.close();
    }
  }
});

test("Binding removes legacy redispatch markers but preserves unrelated resume intent", async (t) => {
  const { dir, state } = await fixture(t);
  for (const record of [state.activeWorker, state.sessions[0]]) {
    record.delegatedBy = "hud-default-runtime";
    record.resumePending = true;
  }
  kernel.saveState(dir, state);
  await bind(dir, state);
  const bound = kernel.loadState(dir);
  assert.equal(bound.activeWorker.delegatedBy, undefined);
  assert.equal(bound.activeWorker.resumePending, true);
  const before = bytes(dir);
  await assert.rejects(() =>
    bind(dir, bound, { providerInstanceId: "wrong", target: { providerInstanceId: "codex" } }),
  );
  assert.deepEqual(bytes(dir), before);
});

async function lifecycleFixture(t) {
  const { dir, state } = await fixture(t, { paused: true });
  const settings = kernel.loadModelSettings(dir);
  kernel.saveModelSettings(dir, { ...settings, skipScrutiny: true, skipUserTesting: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Mission regression",
    "-c",
    "user.email=regression@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);
  await bind(dir, state);
  return { dir, state: kernel.loadState(dir) };
}
async function postAction(hud, action) {
  if (hud.post) return hud.post(action);
  const response = await fetch(`${hud.url}/api/mission/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(4000),
  });
  return { status: response.status, body: await response.json() };
}
function finishFixture(dir, worker) {
  return kernel.endFeatureRun(dir, {
    runId: worker.runId,
    featureId: worker.featureId,
    successState: "success",
    validatorsPassed: true,
    handoff: {
      whatWasImplemented:
        "The isolated fixture finished its original work and verified the expected result without starting an external task.",
    },
  });
}

test("HTTP lifecycle hooks cannot resurrect a finished run or roll back its history", async (t) => {
  for (const action of ["resume", "pause"]) {
    for (const outcome of ["confirmed", "unconfirmed", "rejected", "throws"]) {
      const { dir } = await lifecycleFixture(t);
      let finished;
      const hook = async (worker) => {
        finishFixture(dir, worker);
        finished = bytes(dir);
        if (outcome === "throws") throw new Error("fixture failure after completion");
        if (outcome === "rejected") return { ok: false, accepted: false, paused: false };
        if (outcome === "confirmed")
          return action === "resume" ? { resumed: true } : { paused: true };
      };
      const hud = await createMissionHudServer({
        missionDir: dir,
        dispatchAdapter: { [action === "resume" ? "resumeWorker" : "pauseWorker"]: hook },
      });
      try {
        const response = await postAction(hud, action);
        assert.equal(response.status, outcome === "throws" ? 500 : 409);
        assert.equal(kernel.loadState(dir).status, "completed");
        assert.equal(kernel.loadState(dir).activeWorker, null);
        assert.equal(kernel.loadFeaturesDoc(dir).features[0].status, "completed");
        assert.deepEqual(bytes(dir), finished);
      } finally {
        await hud.close();
      }
    }
  }
});

for (const transport of ["HTTP", "handler"])
  test(`a new ${transport} Pause wins over every in-flight resume outcome without losing its logs`, async (t) => {
    for (const outcome of ["confirmed", "unconfirmed", "rejected", "throws"])
      await t.test(outcome, async (t) => {
        const { dir } = await lifecycleFixture(t);
        let enter, release;
        const entered = new Promise((resolve) => {
          enter = resolve;
        });
        const pendingRuntime = new Promise((resolve) => {
          release = resolve;
        });
        const pauseCalls = [];
        let resumes = 0;
        const hud = await (transport === "handler" ? createHandlerHud : createMissionHudServer)({
          missionDir: dir,
          dispatchAdapter: {
            runFeature: async () =>
              assert.fail("An attached resume must not delegate another child"),
            resumeWorker: async () => {
              resumes++;
              enter();
              await pendingRuntime;
              if (outcome === "throws") throw new Error("fixture transport failure");
              if (outcome === "confirmed")
                return { resumed: true, childRunId: "observer-child-run" };
              if (outcome === "rejected") return { accepted: false, code: "PROVIDER_BUSY" };
            },
            pauseWorker: async (worker) => {
              pauseCalls.push(structuredClone(worker));
              return { paused: true };
            },
            pauseMission: async () => ({ paused: true }),
          },
        });
        let pending;
        try {
          pending = postAction(hud, "resume");
          await bounded(entered);
          const paused = await postAction(hud, "pause");
          assert.equal(paused.status, 200);
          assert.equal(pauseCalls.length, 1);
          const owner = kernel.loadState(dir);
          owner.ownerDecision = "keep latest user Pause";
          owner.activeWorker.ownerNote = "keep worker note";
          owner.sessions[0].ownerNote = "keep session note";
          owner.revision++;
          kernel.saveState(dir, owner);
          const saved = bytes(dir);
          const featureDoc = kernel.loadFeaturesDoc(dir);
          const logs = kernel.readProgressLog(dir);
          assert.equal(logs.at(-2).type, "mission_paused");
          assert.equal(logs.at(-1).type, "worker_paused");
          release();
          const resumed = await pending;
          saveContractEvidence(`observer-${transport}-${outcome}`, {
            outcome,
            transport,
            resumes,
            pauseCalls,
            response: resumed,
            owner,
            final: kernel.loadState(dir),
            saved,
            actual: bytes(dir),
          });
          assert.equal(resumed.status, outcome === "throws" ? 500 : 409);
          assert.equal(kernel.loadState(dir).status, "paused");
          assert.equal(kernel.loadState(dir).pausedAt, paused.body.state.pausedAt);
          assert.equal(resumes, 1);
          assert.equal(bytes(dir).modelSettingsPath, saved.modelSettingsPath);
          assert.equal(bytes(dir).progressLogPath, saved.progressLogPath);
          assert.deepEqual(kernel.readProgressLog(dir), logs);
          if (outcome === "confirmed") {
            const identity = {
              taskId: receipt.taskId,
              childThreadId: receipt.childThreadId,
              childRunId: "observer-child-run",
              clientRequestId: owner.activeWorker.clientRequestId,
              runtimeTransport: "t3-delegate-task",
            };
            const slot = {
              slot: "worker",
              providerInstanceId: "codex",
              model: "gpt-6.1-sol",
              options: { reasoningEffort: "high" },
            };
            assert.equal(
              pauseCalls.length,
              2,
              "Pause the child once more after the accepted resume",
            );
            assert.deepEqual(pauseCalls[1], { ...owner.activeWorker, ...identity, ...slot });
            assert.deepEqual(kernel.loadState(dir), {
              ...owner,
              revision: owner.revision + 1,
              activeWorker: { ...owner.activeWorker, ...identity, ...slot },
              sessions: [{ ...owner.sessions[0], ...identity, ...slot }],
            });
            assert.deepEqual(kernel.loadFeaturesDoc(dir), {
              ...featureDoc,
              features: [
                {
                  ...featureDoc.features[0],
                  ...identity,
                  ...slot,
                  target: {
                    providerInstanceId: "codex",
                    model: "gpt-6.1-sol",
                    options: { reasoningEffort: "high" },
                  },
                },
              ],
            });
          } else {
            assert.deepEqual(
              bytes(dir),
              saved,
              "Unconfirmed, rejected and thrown resumes preserve every owner byte",
            );
            assert.equal(pauseCalls.length, 1, "Only the explicit user Pause controls the child");
          }
        } finally {
          release();
          await pending?.catch(() => {});
          await hud.close();
        }
      });
  });

test("complete accepted receipts clean legacy markers under a revision fence before write-free replay", async (t) => {
  const { dir } = await lifecycleFixture(t);
  const before = kernel.loadState(dir);
  before.activeWorker.delegatedBy = "hud-default-runtime";
  before.sessions[0].delegatedBy = "hud-default-runtime";
  kernel.saveState(dir, before);
  const stale = bytes(dir);
  await assert.rejects(() => bind(dir, { ...before, revision: before.revision - 1 }), {
    code: "STALE_DISPATCH_BINDING",
  });
  assert.deepEqual(bytes(dir), stale);
  await bind(dir, before);
  const clean = kernel.loadState(dir);
  assert.equal(clean.revision, before.revision + 1);
  assert.equal(clean.activeWorker.delegatedBy, undefined);
  assert.equal(clean.sessions[0].delegatedBy, undefined);
  assert.equal(clean.status, "paused");
  const saved = bytes(dir);
  await bind(dir, before);
  assert.deepEqual(bytes(dir), saved);
});

test("accepted task identity takes precedence over stale dispatch and legacy markers in runner and HTTP", async (t) => {
  for (const entry of ["runner", "http"])
    for (const marker of ["hud-default-runtime", "bridge-cli-subprocess"]) {
      const { dir } = await lifecycleFixture(t);
      const state = kernel.loadState(dir);
      Object.assign(state.activeWorker, {
        delegatedBy: marker,
        runtimeTransport: marker,
        dispatchPending: true,
      });
      kernel.saveState(dir, state);
      const saved = bytes(dir);
      let resumes = 0;
      const adapter = {
        runFeature: async () => {
          assert.fail("accepted child must never be dispatched again");
        },
        resumeWorker: async () => {
          resumes++;
          return { accepted: false, code: "PROVIDER_BUSY" };
        },
      };
      if (entry === "runner") {
        const result = await kernel.startMissionRun(dir, {}, adapter);
        assert.equal(result.resumed, false);
      } else {
        const hud = await createMissionHudServer({ missionDir: dir, dispatchAdapter: adapter });
        try {
          const result = await postAction(hud, "resume");
          assert.equal(result.status, 409);
        } finally {
          await hud.close();
        }
      }
      assert.equal(resumes, 1);
      assert.equal(kernel.loadState(dir).activeWorker.taskId, receipt.taskId);
      assert.deepEqual(bytes(dir), saved);
    }
});
