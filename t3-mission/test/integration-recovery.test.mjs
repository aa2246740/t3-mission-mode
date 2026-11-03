import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kernel from "../kernel/index.mjs";
import { archiveObservation, readController, saveController } from "../kernel/autopilot-store.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const now = Date.parse("2026-11-03T04:00:00Z");
const full = "a".repeat(40),
  short = full.slice(0, 7);

function fixture(t, bounded = false) {
  const dir = fs.mkdtempSync(path.join(root, ".integration-recovery-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, {
    missionId: "integration-recovery",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "fixture-owner",
    integration: { branch: "mission/fixture", auto: true },
    retryPolicy: { maxStalledDecisionRepeats: 1 },
    milestones: [{ id: "m1", title: "Fixture", ordinal: 1 }],
    features: [{ id: "f1", milestoneId: "m1", title: "Fixture feature" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1", description: "Fixture assertion" }],
  });
  kernel.approveMissionPlan(dir);
  const ledger = readController(dir, "integration-recovery");
  ledger.timer = {
    requestId: "mission-timer:integration-recovery",
    scheduledTaskId: "fixture-timer",
    phase: "confirmed",
  };
  if (bounded) {
    ledger.timerGuardPolicy = { maxWakeups: 2 };
    ledger.timer.guard = {
      maxWakeups: 2,
      scheduled: 1,
      periodMs: 60000,
      dueAt: now + 60000,
      deadline: now + 120000,
    };
  }
  const observation = {
    type: "timer",
    requestId: ledger.timer.requestId,
    response: { taskId: "fixture-timer", enabled: true },
  };
  ledger.observations[archiveObservation(dir, observation)] = { outcome: "applied" };
  saveController(dir, ledger);
  return dir;
}

async function tick(dir, observations = []) {
  return (await kernel.missionTick(dir, { now, observations })).action;
}

async function integrationDecision(t, commit, bounded = false) {
  const dir = fixture(t, bounded),
    dispatch = await tick(dir);
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
      "The fixture implemented the required behavior and verified the result using the command recorded below.",
    commit,
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
  const action = await tick(dir, [
    { type: "task_status", featureId: "f1", runId: dispatch.runId, taskId: child.taskId, response },
  ]);
  return { dir, dispatch, action };
}

test("a stall limit of one still exposes the first integration decision", async (t) => {
  const { action } = await integrationDecision(t, full);
  assert.equal(action.type, "orchestrator_decision");
  assert.equal(action.kind, "integrate");
});

test("a full integration SHA can extend a worker's short SHA", async (t) => {
  const { dir, dispatch, action } = await integrationDecision(t, short);
  assert.equal(action.kind, "integrate");
  const next = await tick(dir, [
    {
      type: "integration",
      featureId: "f1",
      runId: dispatch.runId,
      response: {
        branch: "mission/fixture",
        sourceBranch: "feature/fixture",
        commit: full,
        mergeSha: full,
      },
    },
  ]);
  assert.equal(next.type, "dispatch");
  assert.equal(kernel.loadState(dir).integration.mergeSha, full);
});

test("a full integration SHA that does not match the worker's prefix is refused", async (t) => {
  const { dir, dispatch, action } = await integrationDecision(t, short);
  assert.equal(action.kind, "integrate");
  const other = "b".repeat(40);
  const next = await tick(dir, [
    {
      type: "integration",
      featureId: "f1",
      runId: dispatch.runId,
      response: {
        branch: "mission/fixture",
        sourceBranch: "feature/fixture",
        commit: other,
        mergeSha: other,
      },
    },
  ]);
  assert.equal(next.type, "orchestrator_decision");
  assert.equal(next.kind, "integration_conflict");
});

test("a bounded mission refuses an integration observation containing only the short SHA", async (t) => {
  const { dir, dispatch, action } = await integrationDecision(t, short, true);
  assert.equal(action.kind, "integrate");
  const next = await tick(dir, [
    {
      type: "integration",
      featureId: "f1",
      runId: dispatch.runId,
      response: {
        branch: "mission/fixture",
        sourceBranch: "feature/fixture",
        commit: short,
        mergeSha: short,
      },
    },
  ]);
  assert.equal(next.kind, "integration_conflict");
});
