import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const root = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-a6b-"));
function seed(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  k.proposeMission(dir, { title: name, repoPath: dir, features: [{ id: "f1" }] });
  return dir;
}
const snapshot = (dir) => ({
  state: k.loadState(dir),
  features: k.loadFeaturesDoc(dir),
  journals: inspectDispatchRecords(dir),
});
for (const hook of ["runFeature", "startMissionRun", "onCommand"])
  test("A6b thrown approve hook " + hook, async () => {
    const dir = seed("throws-" + hook);
    let calls = 0;
    const invoke = async () => {
      calls++;
      throw new Error("R6 actual hook failure");
    };
    const hud = await createHandlerHud({
      missionDir: dir,
      ...(hook === "onCommand" ? { onCommand: invoke } : { runtimeAdapter: { [hook]: invoke } }),
    });
    let response;
    try {
      response = await hud.post("approve");
    } finally {
      await hud.close();
    }
    fs.writeFileSync(
      path.join(root, "throws-" + hook + ".json"),
      JSON.stringify({ response, calls, after: snapshot(dir) }, null, 2),
    );
    assert.equal(
      response.status,
      500,
      "Contract 6 requires every actual thrown hook error to remain a 500",
    );
    assert.equal(calls, 1);
  });
for (const existing of [false, true])
  test("A6b bare pending projects all records existing=" + existing, async () => {
    const dir = seed("pending-" + existing);
    if (existing) {
      k.approveMissionPlan(dir);
      await k.startMissionRun(dir);
    }
    const hud = await createHandlerHud({
      missionDir: dir,
      runtimeAdapter: {
        runFeature: async () => ({
          dispatchPending: true,
          runtimeTransport: "orchestrator-pending",
        }),
      },
    });
    let response;
    try {
      response = await hud.post("approve");
    } finally {
      await hud.close();
    }
    const after = snapshot(dir);
    fs.writeFileSync(
      path.join(root, "pending-" + existing + ".json"),
      JSON.stringify({ response, after }, null, 2),
    );
    assert.equal(response.status, 200);
    assert.equal(after.journals[0].phase, "retryable");
    for (const row of [
      after.state.activeWorker,
      after.state.sessions.at(-1),
      after.features.features[0],
    ]) {
      assert.equal(row.dispatchPending, true);
      assert.equal(row.runtimeTransport, "orchestrator-pending");
      for (const key of ["taskId", "childThreadId", "childRunId", "workerPid", "daemonStateFile"])
        assert.equal(Object.hasOwn(row, key), false);
    }
  });
