import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const receipt = {
  accepted: true,
  taskId: "private-task",
  childThreadId: "private-thread",
  runtimeTransport: "t3-delegate-task",
};
const journal = (dir) =>
  fs
    .readdirSync(k.getMissionPaths(dir).baseDir)
    .filter((name) => /^dispatch-.*\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(k.getMissionPaths(dir).baseDir, name))));
async function fixture(t, op) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a5-transport-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, {
    title: "Private transport failure",
    repoPath: dir,
    features: [{ id: "f1" }],
  });
  if (op !== "dispatch") {
    k.approveMissionPlan(dir);
    await k.startMissionRun(dir, {}, { runFeature: async () => receipt });
  }
  if (op === "resume") {
    const state = k.loadState(dir);
    state.status = "paused";
    state.activeWorker.status = "paused";
    state.sessions[0].status = "paused";
    state.pauseEpoch = 1;
    k.saveState(dir, state);
  }
  return dir;
}
for (const op of ["dispatch", "pause", "resume"])
  test("A5 default CLI lost " + op + " reply retains its original unknown claim", async (t) => {
    const dir = await fixture(t, op),
      calls = path.join(dir, "calls.jsonl"),
      shim = path.join(dir, "private-failure.mjs");
    fs.writeFileSync(
      shim,
      `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'call\\n');process.stderr.write('Private reply lost after possible acceptance');process.exit(1);`,
    );
    const old = [process.env.T3_ACP_MCP_NODE, process.env.T3_ACP_MCP_ENTRYPOINT];
    process.env.T3_ACP_MCP_NODE = process.execPath;
    process.env.T3_ACP_MCP_ENTRYPOINT = shim;
    let hud;
    try {
      hud = await createHandlerHud({ missionDir: dir });
      const action = op === "dispatch" ? "approve" : op;
      await hud.post(action, { commandId: "first" });
      await hud.post(action, { commandId: "second" });
      assert.equal(
        fs.readFileSync(calls, "utf8").trim().split("\n").length,
        1,
        "A transport error does not prove that the child rejected the operation",
      );
      const state = k.loadState(dir);
      if (op === "dispatch") {
        assert.equal(journal(dir)[0].phase, "inflight");
        assert.equal(state.activeWorker.taskId, undefined);
      }
      if (op === "pause") {
        assert.equal(state.status, "paused");
        assert.equal(state.activeWorker.status, "running");
        assert.equal(state.pauseControl.phase, "unknown");
      }
      if (op === "resume") {
        assert.equal(state.status, "paused");
        assert.equal(state.activeWorker.status, "paused");
      }
    } finally {
      await hud?.close();
      for (const [i, key] of ["T3_ACP_MCP_NODE", "T3_ACP_MCP_ENTRYPOINT"].entries())
        old[i] === undefined ? delete process.env[key] : (process.env[key] = old[i]);
    }
  });
for (const ambiguous of [false, true])
  test(
    "A5 thrown nonacceptance tag keeps positive evidence fenced ambiguous=" + ambiguous,
    async (t) => {
      const dir = await fixture(t, "dispatch");
      k.approveMissionPlan(dir);
      let calls = 0;
      const adapter = {
        runFeature: async () => {
          calls++;
          throw Object.assign(new Error("Private transport rejection"), {
            dispatchOutcome: "rejected",
            ...(ambiguous ? { accepted: true, taskId: "possibly-accepted" } : {}),
          });
        },
      };
      await assert.rejects(() => k.startMissionRun(dir, {}, adapter));
      assert.equal(journal(dir)[0].phase, "inflight");
      await assert.rejects(() => k.startMissionRun(dir, {}, adapter));
      assert.equal(calls, 1);
    },
  );
for (const container of ["root", "response", "delegation", "structuredContent", "content"])
  test("A5 plain isError without nonacceptance proof stays fenced in " + container, async (t) => {
    const dir = await fixture(t, "dispatch");
    k.approveMissionPlan(dir);
    let calls = 0;
    const inner = { isError: true, message: "The reply failed after a possible acceptance" };
    const raw =
      container === "root"
        ? inner
        : container === "content"
          ? { content: [{ type: "text", text: JSON.stringify(inner) }] }
          : { [container]: inner };
    const adapter = {
      runFeature: async () => {
        calls++;
        return raw;
      },
    };
    await assert.rejects(() => k.startMissionRun(dir, {}, adapter));
    assert.equal(journal(dir)[0].phase, "inflight");
    await assert.rejects(() => k.startMissionRun(dir, {}, adapter));
    assert.equal(calls, 1);
  });
