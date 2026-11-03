import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kernel from "../kernel/index.mjs";
import {
  archiveObservation,
  readController,
  readObservations,
} from "../kernel/autopilot-store.mjs";

// Regression (strict bounded-guard path, normal entry only):
// 1. The bounded once timer is configured through missionTick's timerMaxWakeups
//    entry (TIMER_GUARD policy), never by hand-writing a legacy ledger.timer.
//    Every timer receipt must satisfy the strict guard checks (boundThreadId,
//    once schedule, exact dueAt/nextRunAt, not blocked by policy).
// 2. After the first integrate decision repeats with maxStalledDecisionRepeats=1,
//    the tick returns a TOP-LEVEL disable_timer whose nextAction merely PREVIEWS
//    wait_user/STALLED_DECISION. The user gate is not reached until the real
//    disabled receipt is submitted in a later tick, which must then return the
//    wait_user/STALLED_DECISION as the actual top-level action.
// 3. After the stall, a real full-SHA integration observation (Git already
//    fast-forwarded externally; auto integration was already approved) is
//    reconciled through the controller's own timer-lifecycle actions; the merge
//    fact is recorded with the full mergeSha and survives identical resubmission
//    without a second integrate decision. No approved:true is ever fabricated.
// 4. A mismatched scheduler receipt is refused and durably recorded; it cannot
//    hide the already-observed facts or corrupt the guard.

const root = fileURLToPath(new URL("../../", import.meta.url));
const now = Date.parse("2026-11-03T04:00:00Z");
const full = "c".repeat(40),
  short = full.slice(0, 7);
const ownerThread = "bounded-owner";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, ".bounded-stalled-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, {
    missionId: "bounded-stalled",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: ownerThread,
    integration: { branch: "mission/fixture", auto: true },
    retryPolicy: { maxStalledDecisionRepeats: 1 },
    milestones: [{ id: "m1", title: "Fixture", ordinal: 1 }],
    features: [{ id: "f1", milestoneId: "m1", title: "Fixture feature" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1", description: "Fixture assertion" }],
  });
  kernel.approveMissionPlan(dir);
  return dir;
}

async function tick(dir, observations = [], extra = {}) {
  return (await kernel.missionTick(dir, { now, observations, ...extra })).action;
}

function timerReceipt(
  requestId,
  taskId,
  dueAt,
  { enabled = true, boundThreadId = ownerThread, blockedByPolicy = false } = {},
) {
  return {
    type: enabled ? "timer" : "timer_disabled",
    requestId,
    response: {
      taskId,
      enabled,
      boundThreadId,
      schedule: { type: "once", runAt: new Date(dueAt).toISOString() },
      nextRunAt: new Date(dueAt).toISOString(),
      blockedByPolicy,
    },
  };
}

function integrationObservation(dispatch) {
  // Real owner observation: the fast-forward already happened in Git; full SHA.
  // No approved field is fabricated.
  return {
    type: "integration",
    featureId: "f1",
    runId: dispatch.runId,
    response: {
      branch: "mission/fixture",
      sourceBranch: "feature/fixture",
      commit: full,
      mergeSha: full,
    },
  };
}

function assertNoSecondIntegrate(action, label) {
  assert.ok(
    !(action.type === "orchestrator_decision" && action.kind === "integrate"),
    `${label}: must not repeat the integrate decision, got ${JSON.stringify({ type: action.type, kind: action.kind ?? action.gate ?? action.reason })}`,
  );
}

function ledgerTimer(dir) {
  const timer = readController(dir, "bounded-stalled").timer;
  assert.ok(timer, "the durable timer exists");
  assert.ok(timer.guard, "the timer carries its bounded once guard");
  assert.equal(timer.guard.maxWakeups, 1);
  return timer;
}

function assertIntegrationReceiptsRetained(dir, label) {
  const ledger = readController(dir, "bounded-stalled");
  const rows = readObservations(dir).filter((item) => item.observation.type === "integration");
  assert.ok(rows.length >= 1, `${label}: at least one integration observation is archived`);
  for (const row of rows) {
    const record = ledger.observations[row.id];
    assert.ok(record, `${label}: integration receipt ${row.id} stays in the durable ledger`);
    assert.notEqual(
      record.outcome,
      "refused",
      `${label}: integration receipt ${row.id} was refused`,
    );
  }
}

test("a mismatched strict-guard creation receipt is refused on the record without confirming the timer", async (t) => {
  const dir = fixture(t);
  const ensure = await tick(dir, [], { timerMaxWakeups: 1 });
  assert.equal(ensure.type, "ensure_timer");
  const dueAt = Date.parse(ensure.schedule.runAt);
  // Wrong owner binding: the guard must refuse this receipt.
  const badReceipt = timerReceipt(ensure.requestId, "sched-1", dueAt, {
    boundThreadId: "attacker-thread",
  });
  const badId = archiveObservation(dir, badReceipt);
  const afterBad = await tick(dir, [badReceipt]);
  const ledger = readController(dir, "bounded-stalled");
  assert.equal(
    ledger.observations[badId].outcome,
    "refused",
    "the mismatched receipt is refused on the record",
  );
  assert.equal(ledger.observations[badId].code, "INVALID_TIMER_RECEIPT");
  assert.ok(
    afterBad.type === "wait_user",
    "the refusal surfaces to the owner instead of being hidden",
  );
  assert.ok(
    JSON.stringify(afterBad).includes("INVALID_TIMER_RECEIPT"),
    "the refusal reason reaches the owner action",
  );
  assert.equal(
    ledger.timer.scheduledTaskId,
    undefined,
    "no scheduler task was confirmed by the bad receipt",
  );
  assert.equal(ledger.timer.phase, "requested");
  assert.equal(ledger.timer.guard.dueAt, dueAt, "the guard is unchanged by the refusal");
  // The controller self-heals once the real strict receipt arrives.
  await tick(dir, [timerReceipt(ensure.requestId, "sched-1", dueAt)]);
  const healed = readController(dir, "bounded-stalled");
  assert.equal(healed.timer.phase, "confirmed");
  assert.equal(healed.timer.scheduledTaskId, "sched-1");
  assert.equal(
    healed.observations[badId].outcome,
    "refused",
    "the earlier refusal stays on the record after healing",
  );
});

test("bounded once guard: disable_timer precedes the real top-level STALLED_DECISION wait, then the integration fact lands", async (t) => {
  const dir = fixture(t);

  // --- Normal entry: the bounded timer policy is set through missionTick itself.
  const ensure = await tick(dir, [], { timerMaxWakeups: 1 });
  assert.equal(ensure.type, "ensure_timer");
  assert.equal(ensure.schedule.type, "once", "the guard demands a one-shot schedule");
  const baseRequestId = ensure.requestId;
  const dueAt = Date.parse(ensure.schedule.runAt);
  const timer = ledgerTimer(dir);
  assert.equal(timer.requestId, baseRequestId);
  assert.equal(timer.phase, "requested");
  assert.equal(timer.guard.dueAt, dueAt);
  assert.equal(timer.guard.deadline, dueAt, "maxWakeups=1 makes deadline == first dueAt");

  // --- The real strict-guard creation receipt confirms the once timer, and the
  // same tick hands the first worker dispatch to the owner.
  const dispatch = await tick(dir, [timerReceipt(baseRequestId, "sched-1", dueAt)]);
  ledgerTimer(dir).phase === "confirmed" || assert.fail("timer must be confirmed");
  assert.equal(ledgerTimer(dir).scheduledTaskId, "sched-1");
  assert.equal(ledgerTimer(dir).phase, "confirmed");
  assert.equal(dispatch.type, "dispatch");
  const child = { taskId: "task-1", childThreadId: "thread-1", childRunId: "child-1" };
  await tick(dir, [
    {
      type: "dispatch",
      featureId: dispatch.featureId,
      runId: dispatch.runId,
      intentId: dispatch.intentId,
      invocationId: dispatch.invocationId,
      response: child,
    },
  ]);
  const result = {
    version: 1,
    featureId: "f1",
    runId: dispatch.runId,
    status: "success",
    summary:
      "The fixture implemented the required behavior and verified the result using the recorded command.",
    commit: short,
    branch: "feature/fixture",
    tests: [{ command: "fixture", status: "passed" }],
    discoveredIssues: [],
    whatWasLeftUndone: [],
  };
  const response = {
    ...child,
    status: "completed",
    workState: "result_available",
    hasPendingChildRuns: false,
    summary: "```mission-result\n" + JSON.stringify(result) + "\n```",
  };

  // --- First integrate decision (auto integration is already approved).
  const first = await tick(dir, [
    { type: "task_status", featureId: "f1", runId: dispatch.runId, taskId: child.taskId, response },
  ]);
  assert.equal(first.type, "orchestrator_decision");
  assert.equal(first.kind, "integrate");
  assert.equal(
    kernel.loadState(dir).integration?.mergeSha,
    undefined,
    "no integration fact before the real observation",
  );

  // --- The repeat must produce a TOP-LEVEL disable_timer whose nextAction only
  // previews the stall. The wait_user gate has NOT been reached yet.
  const stalledOuter = await tick(dir);
  assert.equal(
    stalledOuter.type,
    "disable_timer",
    "the stalled wait is announced via the timer lifecycle, not reached",
  );
  assert.equal(stalledOuter.scheduledTaskId, "sched-1");
  assert.equal(stalledOuter.updateScheduledTask.enabled, false);
  const preview = stalledOuter.nextAction;
  assert.ok(
    preview && preview.type === "wait_user" && preview.gate === "STALLED_DECISION",
    "nextAction previews the stall but is not itself the returned action",
  );
  assert.equal(
    kernel.loadState(dir).integration?.mergeSha,
    undefined,
    "still no integration fact while the timer is being disabled",
  );

  // --- Only after the real disabled receipt does the gate actually arrive.
  const disabledReceipt = {
    type: "timer_disabled",
    requestId: baseRequestId,
    response: { taskId: "sched-1", enabled: false },
  };
  const stalled = await tick(dir, [disabledReceipt]);
  assert.equal(
    stalled.type,
    "wait_user",
    "the STALLED_DECISION gate is now the actual top-level action",
  );
  assert.equal(stalled.gate, "STALLED_DECISION");
  assert.equal(stalled.originalDecision.kind, "integrate");
  assert.equal(stalled.repeatCount, 1);
  assert.equal(ledgerTimer(dir).phase, "disabled");
  assert.equal(kernel.loadState(dir).integration?.mergeSha, undefined);

  // --- Git already fast-forwarded externally; submit the real full-SHA receipt.
  const observation = integrationObservation(dispatch);
  const afterObservation = await tick(dir, [observation]);
  assertIntegrationReceiptsRetained(dir, "after submitting the integration observation");
  if (kernel.loadState(dir).integration?.mergeSha !== full) {
    // The controller demands reconciliation of its own re-arm action first; that
    // is a timer-lifecycle action on the SAME once timer, never a second integrate.
    assertNoSecondIntegrate(afterObservation, "while reconciling the timer");
    assert.equal(
      afterObservation.type,
      "ensure_timer",
      "a pending integration fact only blocks on the timer lifecycle",
    );
    assert.equal(
      afterObservation.scheduledTaskId,
      "sched-1",
      "the re-arm targets the same once timer",
    );
    const confirm = timerReceipt(
      afterObservation.requestId,
      "sched-1",
      ledgerTimer(dir).guard.dueAt,
    );
    const afterConfirm = await tick(dir, [confirm]);
    assertNoSecondIntegrate(afterConfirm, "after the re-arm receipt");
    assertIntegrationReceiptsRetained(dir, "after the re-arm receipt");
    assert.equal(ledgerTimer(dir).phase, "confirmed");
  }

  // --- The already-happened integration fact is recorded with the full mergeSha.
  const state = kernel.loadState(dir);
  assert.equal(
    state.integration.mergeSha,
    full,
    "the real integration fact must be recorded with the full mergeSha",
  );
  assert.equal(state.milestones.length, 1);
  for (const milestone of state.milestones)
    assert.equal(milestone.mergeSha, full, "milestones record the merged head");

  // --- Resubmitting the identical observation is idempotent.
  const afterReplay = await tick(dir, [observation]);
  const replayState = kernel.loadState(dir);
  assert.equal(replayState.integration.mergeSha, full, "mergeSha survives resubmission unchanged");
  for (const milestone of replayState.milestones) assert.equal(milestone.mergeSha, full);
  assertNoSecondIntegrate(afterReplay, "after resubmitting the identical observation");
  assertIntegrationReceiptsRetained(dir, "after resubmission");
  assert.equal(
    ledgerTimer(dir).scheduledTaskId,
    "sched-1",
    "the once timer identity is stable end to end",
  );

  // --- Second lightweight negative: a disabled receipt for a foreign task id is
  // refused on the record and cannot disturb the confirmed guard or the merge fact.
  const foreign = {
    type: "timer_disabled",
    requestId: baseRequestId,
    response: { taskId: "foreign-task", enabled: false },
  };
  const foreignId = archiveObservation(dir, foreign);
  const afterForeign = await tick(dir, [foreign]);
  const finalLedger = readController(dir, "bounded-stalled");
  assert.equal(
    finalLedger.observations[foreignId].outcome,
    "refused",
    "the foreign receipt is refused on the record",
  );
  assert.ok(afterForeign.type === "wait_user", "the refusal surfaces instead of being hidden");
  assert.equal(finalLedger.timer.scheduledTaskId, "sched-1");
  assert.equal(
    finalLedger.timer.phase,
    "confirmed",
    "the confirmed once timer is untouched by the refusal",
  );
  assert.equal(
    kernel.loadState(dir).integration.mergeSha,
    full,
    "the integration fact survives the refused receipt",
  );
});
