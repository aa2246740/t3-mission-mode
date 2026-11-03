import { finish as finishA10 } from "./fixtures/a10-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
const now = 1793000000000;
const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
function fresh(d, observations = [], time = now) {
  return JSON.parse(
    cp.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))).action));`,
        d,
        JSON.stringify({ observations, now: time }),
      ],
      { encoding: "utf8" },
    ),
  );
}
const obs = (a, response, type = "dispatch") => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  response,
});
const ledger = (d) => readController(d, k.loadState(d).missionId);
async function boot() {
  const d = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a8-late-"));
  k.proposeMission(d, {
    title: "Late task",
    repoPath: d,
    autopilot: true,
    pauseMode: "let_finish",
    ownerThreadId: "owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", maxAttempts: 3 }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
    integration: { branch: "main", auto: true },
  });
  k.approveMissionPlan(d);
  const t = await tick(d),
    a = await tick(d, [
      { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
    ]);
  assert.equal((await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })])).type, "sleep");
  return { d, a, oldSession: JSON.stringify(k.loadState(d).sessions[0]) };
}
function status(a, kind, summary = "", pending = false) {
  return {
    type: "task_status",
    featureId: a.featureId,
    runId: a.runId,
    taskId: "old-task",
    response: {
      taskId: "old-task",
      childThreadId: "old-child",
      status: kind,
      workState: pending
        ? "waiting_for_children"
        : kind === "running"
          ? "working"
          : "result_available",
      hasPendingChildRuns: pending,
      ...(pending ? { pendingChildRuns: ["pending-child"] } : {}),
      summary,
    },
  };
}
function envelope(a, success = false) {
  return {
    version: 1,
    featureId: a.featureId,
    runId: a.runId,
    status: success ? "success" : "failure",
    summary:
      "The original late task has stopped and this complete result records the actual work and tests without changing the consumed session.",
    tests: success ? [{ command: "private-check", status: "passed" }] : [],
    discoveredIssues: [],
    whatWasLeftUndone: [],
    commit: success ? "abcdef1234567" : null,
    branch: success ? "feature/original" : null,
  };
}
const fence = (a) => obs(a, { accepted: true, taskId: "old-task", childThreadId: "old-child" });
const rows = [
  ["valid-failure", "completed", "valid"],
  ["valid-success", "completed", "success"],
  ["invalid-completed", "completed", "invalid"],
  ["failed", "failed", ""],
  ["cancelled", "cancelled", ""],
  ["interrupted", "interrupted", ""],
];
for (const [name, kind, result] of rows)
  for (const mode of ["same-process", "fresh-node"])
    test(`A8 late terminal ${name} ${mode}`, async () => {
      const { d, a, oldSession } = await boot(),
        run = mode === "fresh-node" ? fresh : tick;
      assert.equal((await run(d, [fence(a)])).type, "poll");
      assert.equal(
        ledger(d).dispatchReconciliations[a.intentId].code,
        "DISPATCH_LATE_EXECUTION_EVIDENCE",
      );
      assert.equal((await run(d, [status(a, "running")])).type, "poll");
      const body =
        result === "invalid"
          ? "unparseable"
          : result
            ? "```mission-result\n" + JSON.stringify(envelope(a, result === "success")) + "\n```"
            : "";
      await run(d, [status(a, kind, body)]);
      const records = Object.values(ledger(d).dispatchResolutions ?? {});
      assert.equal(records.length, 1);
      const resolution = records[0];
      assert.equal(resolution.terminalStatus, kind);
      assert.equal(resolution.intentId, a.intentId);
      assert.equal(resolution.refusalEvidenceIds.length, 1);
      assert.ok(resolution.acceptedEvidenceIds.length);
      assert.ok(ledger(d).dispatchReconciliations[a.intentId].resolutionId);
      assert.equal(ledger(d).features.f1.providerErrors, 1);
      assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
      assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
      assert.equal(k.loadState(d).lateResultAdoptions, undefined);
      assert.equal(ledger(d).lateResults, undefined);
      if (result === "success" || result === "valid") assert.equal(resolution.result.raw, body);
      if (result === "invalid")
        assert.equal(resolution.validationError.code, "INVALID_MISSION_RESULT");
      const action = await run(d, [], now + 1000);
      assert.equal(action.type, "dispatch");
      assert.equal(action.attempt, 2);
      assert.notEqual(action.intentId, a.intentId);
      await finishA10(d, action, now + 2000);
      assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
      assert.equal(Object.keys(ledger(d).dispatchResolutions).length, 1);
    });
for (const mode of ["same-process", "fresh-node"])
  test(`A8 late pending children, pause and reapproval ${mode}`, async () => {
    const { d, a, oldSession } = await boot(),
      run = mode === "fresh-node" ? fresh : tick;
    await run(d, [fence(a)]);
    assert.equal((await run(d, [status(a, "completed", "", true)])).type, "poll");
    assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
    applyAutopilotCommand(d, "pause");
    applyAutopilotCommand(d, "resume");
    assert.equal((await run(d)).type, "poll");
    const old = k.loadState(d);
    k.rejectMissionPlan(d, "Reapprove without pretending that the late task stopped");
    k.proposeMission(d, { ...old, features: k.loadFeaturesDoc(d).features });
    k.approveMissionPlan(d);
    assert.equal((await run(d, [], now + 100000)).type, "poll");
    assert.ok(
      ledger(d).dispatchReconciliations[a.intentId] &&
        !ledger(d).dispatchReconciliations[a.intentId].resolutionId,
    );
    assert.equal(inspectDispatchRecords(d).length, 1);
    assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
    assert.equal((await run(d, [status(a, "cancelled")], now + 100001)).type, "dispatch");
    assert.ok(ledger(d).dispatchReconciliations[a.intentId].resolutionId);
    assert.equal(Object.values(ledger(d).dispatchResolutions)[0].terminalStatus, "cancelled");
  });
for (const count of [0, 2])
  test(`A8 late recovery ${count} matches has an explicit recovery gate`, async () => {
    const { d, a, oldSession } = await boot();
    await tick(d, [fence(a)]);
    const children = (n) =>
      obs(
        a,
        {
          threads: Array.from({ length: n }, (_, i) => ({
            taskId: i ? "other-task" : "old-task",
            childThreadId: i ? "other-child" : "old-child",
            parentThreadId: "owner",
            clientRequestId: a.intentId,
          })),
        },
        "children",
      );
    const action = fresh(d, [children(count)]);
    assert.equal(action.type, "wait_user");
    assert.equal(action.reason, "DISPATCH_RECOVERY_AMBIGUOUS");
    assert.ok(
      ledger(d).dispatchReconciliations[a.intentId] &&
        !ledger(d).dispatchReconciliations[a.intentId].resolutionId,
    );
    assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
    assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
    if (count === 0) {
      assert.equal(fresh(d, [children(1)]).type, "poll");
      assert.equal(fresh(d, [status(a, "failed")], now + 1000).type, "dispatch");
      assert.ok(ledger(d).dispatchReconciliations[a.intentId].resolutionId);
    }
  });
test("A8 late conflicting identity cannot be cleared by reapproval", async () => {
  const { d, a, oldSession } = await boot();
  await tick(d, [fence(a)]);
  const action = fresh(d, [
    obs(a, { accepted: true, taskId: "foreign-task", childThreadId: "foreign-child" }),
  ]);
  assert.equal(action.type, "wait_user");
  assert.equal(action.reason, "DISPATCH_RECEIPT_CONFLICT");
  assert.ok(
    ledger(d).dispatchReconciliations[a.intentId] &&
      !ledger(d).dispatchReconciliations[a.intentId].resolutionId,
  );
  assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
  assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
});

test("A8 user conflict resolution requires terminal proof for every identity", async () => {
  const { d, a, oldSession } = await boot();
  await tick(d, [fence(a)]);
  await tick(d, [
    obs(a, { accepted: true, taskId: "foreign-task", childThreadId: "foreign-child" }),
  ]);
  const original = status(a, "cancelled"),
    other = {
      ...status(a, "failed"),
      taskId: "foreign-task",
      response: {
        ...status(a, "failed").response,
        taskId: "foreign-task",
        childThreadId: "foreign-child",
      },
    };
  await tick(d, [original, other]);
  const { readObservations } = await import("../kernel/autopilot-store.mjs");
  const ids = readObservations(d)
    .filter((row) => row.observation.type === "task_status")
    .map((row) => row.id);
  const input = {
    intentId: a.intentId,
    selectedTaskId: "old-task",
    selectedChildThreadId: "old-child",
    terminalObservationIds: ids,
    userConfirmed: true,
    reason:
      "The user selected the original task after confirming both conflicting executions stopped.",
  };
  assert.throws(() => k.resolveDispatchEvidence(d, { ...input, userConfirmed: false }), {
    code: "DISPATCH_RESOLUTION_APPROVAL_REQUIRED",
  });
  assert.throws(
    () =>
      k.resolveDispatchEvidence(d, {
        ...input,
        terminalObservationIds: [
          ids.find(
            (id) =>
              readObservations(d).find((row) => row.id === id).observation.taskId === "old-task",
          ),
        ],
      }),
    { code: "DISPATCH_RESOLUTION_UNSETTLED" },
  );
  assert.ok(
    ledger(d).dispatchReconciliations[a.intentId] &&
      !ledger(d).dispatchReconciliations[a.intentId].resolutionId,
  );
  const resolved = await k.missionTick(d, { dispatchResolution: input, now: now + 1000 });
  assert.equal(resolved.action.type, "dispatch");
  assert.ok(ledger(d).dispatchReconciliations[a.intentId].resolutionId);
  assert.equal(Object.values(ledger(d).dispatchResolutions)[0].kind, "user_reconciled_conflict");
  assert.equal(JSON.stringify(k.loadState(d).sessions[0]), oldSession);
  assert.equal(fresh(d, [], now + 1000).type, "recover_dispatch");
});
