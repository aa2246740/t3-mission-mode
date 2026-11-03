import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const root = fs.mkdtempSync(
  path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-a6b-legacy-"),
);
for (const bound of [false, true])
  test("Resume actual hook throw bound=" + bound, async () => {
    const dir = path.join(root, "bound-" + bound);
    fs.mkdirSync(dir);
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
      "--no-gpg-sign",
      "-qm",
      "fixture",
    ]);
    k.proposeMission(dir, { title: "Legacy resume", repoPath: dir, features: [{ id: "f1" }] });
    k.approveMissionPlan(dir);
    await k.startMissionRun(dir);
    if (bound) {
      let s = k.loadState(dir);
      k.bindFeatureDispatch(dir, {
        runId: s.activeWorker.runId,
        featureId: "f1",
        expectedRevision: s.revision,
        taskId: "original-task",
        childThreadId: "original-child",
        runtimeTransport: "t3-delegate-task",
      });
    }
    const s = k.loadState(dir);
    s.status = "paused";
    s.pausedAt = "legacy-pause";
    for (const row of [s.activeWorker, s.sessions[0]]) {
      row.status = "paused";
      delete row.dispatchPending;
      delete row.runtimeTransport;
      delete row.delegatedBy;
    }
    k.saveState(dir, s);
    let calls = 0;
    const hud = await createHandlerHud({
      missionDir: dir,
      runtimeAdapter: {
        resumeWorker: async () => {
          calls++;
          throw new Error("R6 actual legacy Resume hook failure");
        },
      },
    });
    let response;
    try {
      response = await hud.post("resume");
    } finally {
      await hud.close();
    }
    fs.writeFileSync(
      path.join(root, "bound-" + bound + ".json"),
      JSON.stringify({ response, calls, before: s, after: k.loadState(dir) }, null, 2),
    );
    assert.equal(calls, 1);
    assert.equal(
      response.status,
      500,
      "Actual hook exception must stay 500 even when the journal wraps its unknown outcome",
    );
    assert.equal(k.loadState(dir).status, "paused");
  });
