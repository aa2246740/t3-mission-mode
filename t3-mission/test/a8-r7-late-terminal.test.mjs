import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController } from "../kernel/autopilot-store.mjs";

const root = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? process.env.TMPDIR, "a8-r7-"));
const now = 1793000000000;
const dump = (name, data) =>
  fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify(data, null, 2));
const snapshot = (d) => ({
  state: k.loadState(d),
  features: k.loadFeaturesDoc(d),
  records: inspectDispatchRecords(d),
  ledger: readController(d, k.loadState(d).missionId),
});
const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
const obs = (a, response, extra = {}) => ({
  type: "dispatch",
  runId: a.runId,
  featureId: a.featureId,
  intentId: a.intentId,
  response,
  ...extra,
});
async function boot(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: name,
    repoPath: d,
    autopilot: true,
    ownerThreadId: "original-owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", title: "Original title", milestoneId: "m1" }],
  });
  k.approveMissionPlan(d);
  const timer = await tick(d);
  const a = await tick(d, [
    { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
  ]);
  return { d, a };
}
function freshTick(d, observations = [], time = now) {
  return JSON.parse(
    cp.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify(await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))));`,
        d,
        JSON.stringify({ observations, now: time }),
      ],
      { encoding: "utf8" },
    ),
  ).action;
}
test("Late accepted execution has a supported reconciliation path after user decisions", async () => {
  const { d, a } = await boot("late-reconcile");
  const refused = await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  const afterRefused = snapshot(d);
  const late = await tick(
    d,
    [
      obs(a, {
        accepted: true,
        taskId: "old-task",
        childThreadId: "old-child",
        runtimeTransport: "t3-delegate-task",
      }),
    ],
    now + 1,
  );
  const afterLate = snapshot(d);
  const children = {
    type: "children",
    runId: a.runId,
    featureId: a.featureId,
    intentId: a.intentId,
    response: {
      threads: [
        {
          taskId: "old-task",
          childThreadId: "old-child",
          parentThreadId: "original-owner",
          clientRequestId: a.intentId,
        },
      ],
    },
  };
  const reconciled = await tick(d, [children], now + 2);
  const envelope = {
    version: 1,
    featureId: a.featureId,
    runId: a.runId,
    status: "failure",
    summary:
      "The original private task is now terminal and has explicitly stopped without any product changes or remaining work.",
    tests: [],
    discoveredIssues: [],
    whatWasLeftUndone: [],
    commit: null,
    branch: null,
  };
  const terminalObservation = {
    type: "task_status",
    featureId: a.featureId,
    runId: a.runId,
    taskId: "old-task",
    response: {
      taskId: "old-task",
      childThreadId: "old-child",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      summary: "```mission-result\n" + JSON.stringify(envelope) + "\n```",
    },
  };
  const afterTerminal = await tick(d, [terminalObservation], now + 3);
  applyAutopilotCommand(d, "pause");
  applyAutopilotCommand(d, "resume");
  const resumed = await tick(d, [], now + 86400000);
  const old = k.loadState(d);
  k.rejectMissionPlan(d, "Reapprove after reconciling the old task");
  k.proposeMission(d, { ...old, features: k.loadFeaturesDoc(d).features });
  k.approveMissionPlan(d);
  const reapproved = freshTick(d, [], now + 172800000);
  dump("late-reconcile", {
    a,
    refused,
    afterRefused,
    late,
    afterLate,
    reconciled,
    terminalObservation,
    afterTerminal,
    resumed,
    reapproved,
    final: snapshot(d),
  });
  assert.equal(late.type, "poll");
  assert.equal(late.reconciliation, true);
  assert.notEqual(
    reapproved.reason,
    "DISPATCH_LATE_EXECUTION_EVIDENCE",
    "After explicit reconciliation and a fresh valid approval the durable error needs a supported clearing transition",
  );
});
