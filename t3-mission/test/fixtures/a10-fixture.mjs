import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";
import * as k from "../../kernel/index.mjs";
import { inspectDispatchRecords } from "../../kernel/dispatch-journal.mjs";
import { readController } from "../../kernel/autopilot-store.mjs";

export const now = 1793000000000;
export const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
export const observation = (a, response, type = "dispatch") => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  ...(type === "dispatch" ? { invocationId: a.invocationId } : {}),
  response,
});
export const accepted = (a) => ({
  accepted: true,
  taskId: a.taskId ?? "task-" + a.attempt,
  childThreadId: a.childThreadId ?? "thread-" + a.attempt,
  childRunId: a.childRunId ?? "turn-" + a.attempt,
  ...(a.worktreePath ? { worktreePath: a.worktreePath } : {}),
});
export const status = (a, kind, extra = {}) => ({
  ...observation(
    a,
    {
      ...accepted(a),
      status: kind,
      workState: kind === "running" ? "working" : "result_available",
      hasPendingChildRuns: false,
      ...extra,
    },
    "task_status",
  ),
  taskId: accepted(a).taskId,
});
export const envelope = (a, outcome = "success") => ({
  version: 1,
  featureId: a.featureId,
  runId: a.runId,
  status: outcome,
  summary:
    "Literal private protocol result for this exact original execution, with complete identity, retained source branch and verification evidence.",
  tests: [{ command: "private-check", status: "passed" }],
  discoveredIssues: [],
  whatWasLeftUndone: [],
  commit: outcome === "success" ? "abcdef1234567" : null,
  branch: outcome === "success" ? "feature/original" : null,
  testedSha: "abcdef1234567",
  failedAssertions: [],
  assertionResults: {},
});
export const result = (a, outcome = "success") =>
  status(a, "completed", {
    summary: "```mission-result\n" + JSON.stringify(envelope(a, outcome)) + "\n```",
  });
export const ledger = (d) => readController(d, k.loadState(d).missionId);
export function init(name, maxAttempts = 8) {
  const d = fs.mkdtempSync(
    path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a10-" + name + "-"),
  );
  k.proposeMission(d, {
    title: name,
    repoPath: d,
    autopilot: true,
    ownerThreadId: "owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", maxAttempts }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000, maxConsecutiveProviderErrors: 10 },
    integration: { branch: "main", auto: true },
  });
  k.approveMissionPlan(d);
  return d;
}
export async function first(d) {
  const timer = await tick(d);
  assert.equal(timer.type, "ensure_timer");
  return tick(d, [
    { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
  ]);
}
export function fresh(d, op = "all-entries", input = {}) {
  const out = cp.spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./a10-r9-child.mjs", import.meta.url)), op, d, JSON.stringify(input)],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}
export function fenced(d) {
  const before = JSON.stringify(k.loadState(d).sessions);
  const reply = fresh(d);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.entries, 5);
  assert.deepEqual(reply.calls, []);
  assert.equal(JSON.stringify(k.loadState(d).sessions), before);
}
export function reapprove(d, model) {
  if (model)
    k.updateMissionFeatures(d, {
      modelSettings: { worker: { providerInstanceId: "codex", model, options: {} } },
    });
  const state = k.loadState(d);
  k.rejectMissionPlan(d, "Explicit reapproval retains execution evidence and budgets.");
  k.proposeMission(d, {
    ...state,
    features: k.loadFeaturesDoc(d).features,
    modelSettings: k.loadModelSettings(d),
  });
  k.approveMissionPlan(d);
}
export async function finish(d, action, time) {
  for (let step = 0; step < 4 && action.type === "dispatch"; step++) {
    const a = action;
    await tick(d, [observation(a, accepted(a))], time++);
    action = await tick(d, [result(a)], time++);
    if (action.kind === "integrate")
      action = await tick(
        d,
        [
          observation(
            a,
            {
              branch: "main",
              sourceBranch: "feature/original",
              commit: "abcdef1234567",
              mergeSha: "abcdef1234567",
            },
            "integration",
          ),
        ],
        time++,
      );
  }
  assert.equal(action.type, "disable_timer");
  await tick(
    d,
    [
      {
        type: "timer_disabled",
        requestId: action.requestId,
        response: { taskId: action.scheduledTaskId, enabled: false },
      },
    ],
    time++,
  );
  assert.equal(fresh(d, "tick", { now: time }).result.action.type, "done");
  assert.equal(
    k.loadFeaturesDoc(d).features.find((row) => row.id === "f1").integration.runId,
    k.loadFeaturesDoc(d).features.find((row) => row.id === "f1").runId,
  );
}
export async function rejectedAttempts(d, n) {
  let a = await first(d);
  const attempts = [];
  for (let i = 0; i < n; i++) {
    attempts.push(a);
    await tick(d, [observation(a, { accepted: false, code: "PROVIDER_BUSY" })], now + i * 1000);
    if (i + 1 < n) a = await tick(d, [], now + (i + 1) * 1000);
  }
  return attempts;
}
export async function rejectedHistory(d, n) {
  const tasks = [],
    adapter = { runFeature: async () => ({ accepted: false, code: "PROVIDER_BUSY" }) };
  for (let i = 0; i <= n; i++) {
    if (i) reapprove(d, "model-" + i);
    await assert.rejects(() => k.startMissionRun(d, {}, adapter));
    const r = inspectDispatchRecords(d)[0];
    if (i < n)
      tasks.push({
        featureId: "f1",
        runId: r.intent.runId,
        intentId: r.intent.clientRequestId,
        invocationId: r.invocations[0].invocationId,
        attempt: 1,
        taskId: "history-" + i,
        childThreadId: "history-thread-" + i,
        childRunId: "history-turn-" + i,
      });
  }
  const timer = await tick(d);
  await tick(d, [
    { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
  ]);
  return tasks;
}
