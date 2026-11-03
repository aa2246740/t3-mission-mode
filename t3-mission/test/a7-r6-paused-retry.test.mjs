import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
const root = fs.mkdtempSync(
  path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-paused-retry-"),
);
test("A legitimate retry accepted during a user Pause is not consumed as its old refusal", async () => {
  const dir = path.join(root, "mission");
  fs.mkdirSync(dir);
  const now = 1793000000000;
  k.proposeMission(dir, {
    title: "Paused retry",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
  });
  k.approveMissionPlan(dir);
  const timer = (await k.missionTick(dir, { now })).action;
  const first = (
    await k.missionTick(dir, {
      now,
      observations: [
        { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
      ],
    })
  ).action;
  applyAutopilotCommand(dir, "pause");
  const rejected = (
    await k.missionTick(dir, {
      now,
      observations: [
        {
          type: "dispatch",
          runId: first.runId,
          featureId: first.featureId,
          intentId: first.intentId,
          response: { accepted: false, code: "PROVIDER_BUSY" },
        },
      ],
    })
  ).action;
  const afterRefusal = { state: k.loadState(dir), records: inspectDispatchRecords(dir) };
  applyAutopilotCommand(dir, "resume");
  let retryCalls = 0;
  const retried = await k.startMissionRun(
    dir,
    {},
    {
      runFeature: async () => {
        retryCalls++;
        return {
          accepted: true,
          taskId: "actually-accepted-task",
          childThreadId: "actually-accepted-child",
          runtimeTransport: "t3-delegate-task",
        };
      },
    },
  );
  const afterAccepted = { state: k.loadState(dir), records: inspectDispatchRecords(dir) };
  const next = (await k.missionTick(dir, { now })).action;
  const afterDeadline = (await k.missionTick(dir, { now: now + 86400000 })).action;
  fs.writeFileSync(
    path.join(root, "sequence.json"),
    JSON.stringify(
      {
        first,
        rejected,
        afterRefusal,
        retryCalls,
        retried,
        afterAccepted,
        next,
        afterDeadline,
        state: k.loadState(dir),
        records: inspectDispatchRecords(dir),
      },
      null,
      2,
    ),
  );
  assert.equal(retryCalls, 1);
  assert.equal(afterRefusal.records[0].phase, "retryable");
  assert.equal(afterAccepted.records[0].phase, "accepted");
  assert.notEqual(
    afterDeadline.type,
    "dispatch",
    "A subsequent successful permitted retry must override the prior unstarted failure before any new attempt",
  );
  assert.equal(k.loadState(dir).activeWorker.runId, first.runId);
});
