import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";
import { parseMissionResult } from "../kernel/mission-result.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController, saveController, archiveObservation } from "../kernel/autopilot-store.mjs";
import { callMissionTool, MISSION_TOOLS } from "../bridge/mcp-server.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const summary = "The isolated fake executor reports this feature and its checks complete. This is protocol evidence only, not real provider or product acceptance.";
const sha = "a".repeat(40);
const target = { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "max", serviceTier: "priority" } };
function fixture(t, input = {}) {
  const dir = fs.mkdtempSync(path.join(repo, ".autopilot-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { repoPath: dir, autopilot: true, pauseMode: "let_finish", ownerThreadId: "toy-owner", title: "Toy Mission", milestones: [{ id: "m1", title: "Toy", ordinal: 1, mergeSha: sha }],
    features: [{ id: "f1", title: "Feature one", milestoneId: "m1", description: "Only a fake executor exercises this contract." }],
    assertions: [{ id: "VAL-T1", milestoneId: "m1", description: "Fake-executor protocol assertion" }],
    integration: { branch: "mission/toy", auto: true }, modelSettings: { worker: target, validator: target }, ...input });
  k.approveMissionPlan(dir);
  const ledger = readController(dir, k.loadState(dir).missionId);
  ledger.timer = { requestId: `mission-timer:${ledger.missionId}`, scheduledTaskId: "fixture-scheduled-task", phase: "confirmed" };
  const timerObservation = { type: "timer", requestId: ledger.timer.requestId, response: { taskId: ledger.timer.scheduledTaskId, enabled: true } };
  ledger.observations[archiveObservation(dir, timerObservation)] = { outcome: "applied" };
  saveController(dir, ledger);
  return dir;
}
const obs = (type, action, response) => ({ type, featureId: action.featureId, runId: action.runId, intentId: action.intentId, taskId: action.taskId, response });
const mcp = response => ({ content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response });
function receipt(action, additions = {}) {
  return { taskId: `session-a:${action.runId}`, childThreadId: `thread:${action.runId}`, childRunId: `child:${action.runId}`,
    ...action.delegateTask.target, options: Object.entries(action.delegateTask.target.options).map(([id, value]) => ({ id, value })),
    parentThreadId: "toy-owner", status: "running", workState: "working", hasPendingChildRuns: false, ...additions };
}
function envelope(action, additions = {}) {
  const value = { version: 1, featureId: action.featureId, runId: action.runId, status: "success", summary,
    commit: sha, branch: `feature/${action.featureId}`, tests: [{ command: "fake-executor checks", status: "passed" }],
    discoveredIssues: [], whatWasLeftUndone: [], testedSha: sha, assertionResults: { "VAL-T1": "passed" }, ...additions };
  value.failedAssertions = Object.keys(value.assertionResults ?? {}).filter(id => value.assertionResults[id] === "failed");
  return value;
}
const fence = value => "```mission-result\n" + JSON.stringify(value) + "\n```";
const taskStatus = (binding, value, additions = {}) => ({ ...binding, status: "completed", workState: "result_available", hasPendingChildRuns: false,
  hasPendingQuestion: false, pendingApproval: null, summary: fence(value), ...additions });
async function bound(t, input = {}) {
  const dir = fixture(t, input), action = (await k.missionTick(dir)).action, binding = receipt(action);
  const polled = (await k.missionTick(dir, { observations: [obs("dispatch", action, mcp(binding))] })).action;
  assert.equal(polled.type, "poll");
  return { dir, action, binding, polled };
}
function snapshot(dir) {
  const base = path.join(dir, ".mission"), result = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(base, file)] = [fs.readFileSync(file, "utf8"), fs.statSync(file, { bigint: true }).mtimeNs.toString()];
    }
  };
  walk(base); return result;
}
const logs = dir => k.readProgressLog(dir).filter(item => item.type === "feature_run_ended");
function mutate(dir, fn) { const state = k.loadState(dir); fn(state); k.saveState(dir, state); }

async function drive(t, input = {}, { failFirst = false, manual = false } = {}) {
  const dir = fixture(t, { features: [1, 2, 3].map(number => ({ id: `f${number}`, title: `Feature ${number}`, milestoneId: "m1" })), ...input });
  const accepted = new Map(), trace = [];
  let next = await k.missionTick(dir);
  for (let turns = 0; turns < 100; turns++) {
    const action = next.action; trace.push(action);
    if (action.type === "done") return { dir, trace, accepted, next };
    if (action.type === "dispatch") {
      assert.equal(accepted.has(action.intentId), false, "each intent creates at most one fake child");
      const binding = receipt(action);
      accepted.set(action.intentId, { action, binding, polls: 0 });
      next = await k.missionTick(dir, { observations: [obs("dispatch", action, mcp(binding))] });
    } else if (action.type === "poll") {
      const task = [...accepted.values()].find(item => item.binding.taskId === action.taskId);
      assert.ok(task);
      const failure = failFirst && task.action.featureId === "f2" && task.action.attempt === 1;
      const response = task.polls++ === 0 ? { ...task.binding, summary: null } : taskStatus(task.binding, envelope(task.action, failure ? { status: "failure", commit: null, branch: null, tests: [{ command: "fake first failure", status: "failed" }] } : {}));
      next = await k.missionTick(dir, { observations: [obs("task_status", action, mcp(response))] });
    } else if (action.type === "disable_timer") {
      next = await k.missionTick(dir, { observations: [{ type: "timer_disabled", requestId: action.requestId, response: { taskId: action.scheduledTaskId, enabled: false } }] });
    } else if (action.type === "sleep") {
      next = await k.missionTick(dir);
    } else if (action.type === "orchestrator_decision" && action.kind === "integrate") {
      const context = action.context;
      next = await k.missionTick(dir, { observations: [obs("integration", context, { ...context, mergeSha: context.commit })] });
    } else if (manual && action.type === "wait_user" && action.gate === "merge") {
      next = await k.missionTick(dir, { observations: [obs("integration", action, { branch: "mission/toy", sourceBranch: `feature/${action.featureId}`, commit: action.commit, mergeSha: action.commit, approved: true })] });
    } else assert.fail(JSON.stringify(action));
  }
  assert.fail("Fake Mission did not converge in 100 actions");
}

test("Toy Mission: one approval, three features and two validators reach done with no user actions", async t => {
  const { dir, trace, accepted, next } = await drive(t);
  assert.equal(next.action.status, "completed"); assert.equal(accepted.size, 5); assert.equal(logs(dir).length, 5);
  assert.equal(trace.filter(action => action.type === "dispatch").length, 5);
  assert.equal(trace.some(action => action.type === "wait_user"), false);
  const state = k.loadState(dir);
  assert.equal(state.activeWorker, null); assert.equal(state.status, "completed");
  assert.deepEqual(state.assertions[0].stageResults, { scrutiny: "passed", user_testing: "passed" });
  assert.equal(k.loadFeaturesDoc(dir).features.filter(feature => feature.integration?.mergeSha === sha).length, 3);
  assert.equal(inspectDispatchRecords(dir).every(record => record.phase === "accepted"), true);
  const before = snapshot(dir);
  for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual((await k.missionTick(dir)).action, { type: "done", status: "completed" });
  assert.deepEqual(snapshot(dir), before, "terminal ticks produce zero writes, including mtimes");
  if (process.env.AUTOPILOT_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.AUTOPILOT_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.AUTOPILOT_EVIDENCE_DIR, "toy-trace.json"), JSON.stringify({ evidenceLevel: "fake T3 protocol fixture; no Git merges or provider calls", trace, state, features: k.loadFeaturesDoc(dir), journal: inspectDispatchRecords(dir), endEvents: logs(dir) }, null, 2) + "\n");
    const savedToy = path.join(process.env.AUTOPILOT_EVIDENCE_DIR, "toy-mission");
    fs.rmSync(savedToy, { recursive: true, force: true });
    fs.cpSync(path.join(dir, ".mission"), path.join(savedToy, ".mission"), { recursive: true });
  }
});
test("Worker failure is consumed once; second attempt gets a new run and key then completes", async t => {
  const { dir, accepted } = await drive(t, {}, { failFirst: true });
  const attempts = [...accepted.values()].filter(item => item.action.featureId === "f2").map(item => item.action);
  assert.equal(accepted.size, 6); assert.equal(logs(dir).length, 6);
  assert.deepEqual(attempts.map(action => action.attempt), [1, 2]);
  assert.notEqual(attempts[0].intentId, attempts[1].intentId); assert.notEqual(attempts[0].runId, attempts[1].runId);
});

for (const [gate, change] of [
  ["plan", state => { state.planAccepted = false; }],
  ["pause", state => { state.status = "paused"; }],
  ["input", state => { state.status = "awaiting_input"; }],
  ["permission", state => { state.permissions = [{ id: "deploy", status: "pending", reason: "Deployment approval" }]; }],
  ["handoff", state => { state.lastHandoffNeedsAttention = true; state.pendingHandoffItems = [{ requiresUser: true, summary: "Decision needed" }]; }],
]) test(`Decision table: ${gate} gate creates no intent or child`, async t => {
  const dir = fixture(t); mutate(dir, change); const before = snapshot(dir);
  const result = await k.missionTick(dir); assert.equal(result.action.type, "wait_user"); assert.equal(result.action.gate, gate);
  assert.deepEqual(snapshot(dir), before); assert.equal(inspectDispatchRecords(dir).length, 0);
});
test("Feature-scoped permission stops before selection", async t => {
  const dir = fixture(t, { permissions: [{ id: "account", featureId: "f1", status: "pending" }] });
  assert.equal((await k.missionTick(dir)).action.gate, "permission"); assert.equal(k.loadState(dir).activeWorker, null);
});
test("Decision table: unresolved model handoff returns orchestrator_decision", async t => {
  const dir = fixture(t); mutate(dir, state => { state.lastHandoffNeedsAttention = true; state.pendingHandoffItems = [{ summary: "Choose repair or dismissal" }]; });
  const result = await k.missionTick(dir); assert.equal(result.action.type, "orchestrator_decision"); assert.equal(result.action.kind, "handoff");
});
test("Brief contains role, title, target options, repository, assertion and exact run fence", async t => {
  const dir = fixture(t); const action = (await k.missionTick(dir)).action;
  assert.equal(action.delegateTask.title, "[M1] Worker #1: Feature one");
  assert.equal(action.delegateTask.role, "implementation"); assert.equal(action.delegateTask.isolation, "worktree"); assert.equal(action.delegateTask.mode, "async");
  assert.deepEqual(action.delegateTask.target, target);
  for (const value of [dir, action.runId, "VAL-T1", "```mission-result", "Do not merge"]) assert.ok(action.delegateTask.task.includes(value));
  assert.equal(inspectDispatchRecords(dir)[0].phase, "inflight");
  assert.equal(action.delegateTask.clientRequestId, action.intentId);
});
test("Crash after intent and accepted delegate, before receipt submission: recover the one original task", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  let accepted = 0; let original;
  assert.throws(() => { accepted++; original = { ...receipt(action), clientRequestId: action.intentId, parentThreadId: "toy-owner" }; throw new Error("injected owner death before receipt"); }, /injected owner death/);
  const recovered = (await k.missionTick(dir)).action;
  assert.equal(recovered.type, "recover_dispatch"); assert.equal(recovered.clientRequestId, action.intentId);
  assert.equal((await k.missionTick(dir)).action.type, "recover_dispatch");
  const polled = await k.missionTick(dir, { observations: [obs("children", recovered, mcp({ tasks: [original] }))] });
  assert.equal(polled.action.type, "poll"); assert.equal(polled.action.taskId, original.taskId); assert.equal(accepted, 1);
});
for (const count of [0, 2]) test(`Recovery ${count} matching tasks waits for user and never redispatches`, async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const tasks = Array.from({ length: count }, () => ({ ...receipt(action), clientRequestId: action.intentId }));
  const result = await k.missionTick(dir, { observations: [obs("children", action, { tasks })] });
  assert.equal(result.action.type, "wait_user"); assert.equal(result.action.reason, "DISPATCH_RECOVERY_AMBIGUOUS");
  assert.equal(inspectDispatchRecords(dir)[0].phase, "inflight"); assert.equal(k.loadState(dir).sessions.length, 1);
});
test("Conflicting returned target stays inflight and unbound", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const result = await k.missionTick(dir, { observations: [obs("dispatch", action, receipt(action, { model: "wrong-model" }))] });
  assert.equal(result.action.type, "wait_user"); assert.equal(inspectDispatchRecords(dir)[0].phase, "inflight"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
});
test("One intent refuses a second task identity without replacing the first", async t => {
  const { dir, action, binding } = await bound(t);
  const result = await k.missionTick(dir, { observations: [obs("dispatch", action, receipt(action, { taskId: "second-task", childThreadId: "second-thread" }))] });
  assert.equal(result.action.type, "wait_user"); assert.equal(k.loadState(dir).activeWorker.taskId, binding.taskId);
  assert.equal(inspectDispatchRecords(dir)[0].receipt.taskId, binding.taskId);
});
test("Identical receipt observation is write-free, including journal and all projections", async t => {
  const { dir, action, binding } = await bound(t), before = snapshot(dir);
  assert.equal((await k.missionTick(dir, { observations: [obs("dispatch", action, mcp(binding))] })).action.type, "poll");
  assert.deepEqual(snapshot(dir), before);
});
for (const response of [
  { status: "running", workState: "working", hasPendingChildRuns: false },
  { status: "completed", workState: "waiting_for_children", hasPendingChildRuns: true },
  { status: "completed", workState: "result_available", hasPendingChildRuns: true },
]) test(`No End while ${response.status}/${response.workState}/pending=${response.hasPendingChildRuns}`, async t => {
  const { dir, action, binding, polled } = await bound(t);
  const observation = obs("task_status", polled, taskStatus(binding, envelope(action), response));
  assert.equal((await k.missionTick(dir, { observations: [observation] })).action.type, "sleep");
  const before = snapshot(dir);
  assert.equal((await k.missionTick(dir, { observations: [observation] })).action.type, "sleep");
  assert.deepEqual(snapshot(dir), before); assert.equal(logs(dir).length, 0);
  assert.equal((await k.missionTick(dir)).action.type, "poll");
});
for (const [gate, additions] of [["permission", { pendingApproval: { requestId: "approval", kind: "command" } }], ["input", { hasPendingQuestion: true }]])
test(`T3 child ${gate} gate belongs to the user`, async t => {
  const { dir, binding, polled } = await bound(t);
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, { ...binding, ...additions })] });
  assert.equal(result.action.type, "wait_user"); assert.equal(result.action.gate, gate); assert.equal(logs(dir).length, 0);
});
for (const [name, summaryValue] of [
  ["missing", "success"], ["truncated", "```mission-result\n{\"version\":1"], ["plain success", "成功"], ["wrong run", "wrong-run"]
]) test(`Invalid result ${name} requires an orchestrator decision and preserves raw evidence`, async t => {
  const { dir, action, binding, polled } = await bound(t);
  const raw = summaryValue === "wrong-run" ? fence(envelope(action, { runId: "foreign-run" })) : summaryValue;
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action), { summary: raw }))] });
  assert.equal(result.action.type, "resume_worker"); assert.equal(result.action.kind, "result_unparseable");
  assert.equal(result.action.threadId, binding.childThreadId); assert.equal(result.action.runId, action.runId);
  assert.equal(result.action.context.raw, raw); assert.equal(logs(dir).length, 0); assert.ok(k.loadState(dir).activeWorker);
});
test("Completion repeats and old run observations do not End twice or replace the next run", async t => {
  const { dir, action, binding, polled } = await bound(t);
  const done = obs("task_status", polled, taskStatus(binding, envelope(action)));
  assert.equal((await k.missionTick(dir, { observations: [done, done] })).action.kind, "integrate");
  const integration = obs("integration", action, { branch: "mission/toy", sourceBranch: `feature/${action.featureId}`, commit: sha, mergeSha: sha });
  const next = (await k.missionTick(dir, { observations: [integration, done] })).action;
  assert.equal(next.type, "dispatch"); assert.equal(next.featureId, "scrutiny-validator-m1");
  const before = snapshot(dir);
  assert.equal((await k.missionTick(dir, { observations: [done, integration] })).action.type, "recover_dispatch");
  assert.equal(logs(dir).length, 1); assert.deepEqual(snapshot(dir), before);
});
test("Out-of-order old working status cannot erase a terminal result", async t => {
  const { dir, action, binding, polled } = await bound(t);
  const done = obs("task_status", polled, taskStatus(binding, envelope(action)));
  await k.missionTick(dir, { observations: [done] });
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, binding)] });
  assert.equal(result.action.kind, "integrate"); assert.equal(logs(dir).length, 0);
});
test("Pause saves receipt and terminal evidence but does not End or dispatch", async t => {
  const { dir, action, binding, polled } = await bound(t);
  mutate(dir, state => { state.status = "paused"; state.activeWorker.status = "paused"; });
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action)))] });
  assert.equal(result.action.gate, "pause"); assert.equal(k.loadState(dir).status, "paused"); assert.equal(logs(dir).length, 0); assert.equal(k.loadState(dir).sessions.length, 1);
  const before = snapshot(dir); await k.missionTick(dir); assert.deepEqual(snapshot(dir), before);
});
for (const operation of ["pause", "reject"]) test(`${operation} during the tick's await wins before external action`, async t => {
  const dir = fixture(t);
  const pending = k.missionTick(dir);
  if (operation === "reject") k.rejectMissionPlan(dir, "Revise the plan during selection");
  else mutate(dir, state => { state.status = "paused"; });
  const result = await pending;
  assert.equal(result.action.type, "wait_user"); assert.equal(result.action.gate, operation === "reject" ? "plan" : "pause");
  assert.equal(inspectDispatchRecords(dir)[0].phase, "prepared"); assert.equal(k.loadState(dir).sessions.length, 1);
});
test("Reject while owner awaits delegate preserves accepted evidence until reapproval", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const pendingDelegate = Promise.resolve(receipt(action));
  k.rejectMissionPlan(dir, "User rejects during delegated acceptance");
  const result = await k.missionTick(dir, { observations: [obs("dispatch", action, await pendingDelegate)] });
  assert.equal(result.action.gate, "plan"); assert.equal(k.loadState(dir).planAccepted, false); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
  assert.equal(inspectDispatchRecords(dir)[0].phase, "accepted");
  const rejectedAt = k.loadState(dir).lastPlanRejectedAt;
  k.approveMissionPlan(dir);
  assert.equal((await k.missionTick(dir)).action.type, "poll"); assert.equal(k.loadState(dir).lastPlanRejectedAt, rejectedAt);
});
test(".mission alone recovers identities after relocation and a fresh CLI process", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const other = fixture(t);
  fs.rmSync(path.join(other, ".mission"), { recursive: true }); fs.cpSync(path.join(dir, ".mission"), path.join(other, ".mission"), { recursive: true });
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(repo, "t3-mission/bridge/cli.mjs"), "MissionTick", "--mission-dir", other], { encoding: "utf8" }));
  assert.equal(cli.action.type, "recover_dispatch"); assert.equal(cli.action.clientRequestId, action.intentId);
  const result = await k.missionTick(other, { observations: [obs("children", action, { tasks: [{ ...receipt(action), clientRequestId: action.intentId }] })] });
  assert.equal(result.action.type, "poll"); assert.equal(result.action.runId, action.runId);
});
for (const policy of [undefined, { branch: "mission/toy", auto: false }]) test(`Integration ${JSON.stringify(policy)} stops at the merge gate`, async t => {
  const { dir, action, binding, polled } = await bound(t, { integration: policy });
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action)))] });
  assert.equal(result.action.type, "wait_user"); assert.equal(result.action.gate, "merge"); assert.equal(logs(dir).length, 0);
});
test("Manual integration only records approved exact commits and ends at awaiting_merge", async t => {
  const { dir, next } = await drive(t, { integration: { branch: "mission/toy", auto: false } }, { manual: true });
  assert.equal(next.action.status, "awaiting_merge"); assert.equal(k.loadState(dir).status, "awaiting_merge");
  const before = snapshot(dir); await k.missionTick(dir); assert.deepEqual(snapshot(dir), before);
});
test("A mismatched merge SHA input cannot integrate a different feature commit", async t => {
  const { dir, action, binding, polled } = await bound(t);
  await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action)))] });
  const result = await k.missionTick(dir, { observations: [obs("integration", action, { branch: "mission/toy", sourceBranch: "feature/f1", commit: "b".repeat(40), mergeSha: sha })] });
  assert.equal(result.action.kind, "integration_conflict"); assert.equal(logs(dir).length, 0);
});
test("Validator failure is consumed and returns repair decision, never completed", async t => {
  const { dir, action, binding, polled } = await bound(t, { features: [{ id: "scrutiny-validator-m1", milestoneId: "m1", kind: "scrutiny" }] });
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action, { status: "failure", assertionResults: { "VAL-T1": "failed" } })))] });
  assert.equal(result.action.kind, "validation_failed"); assert.equal(logs(dir).length, 1); assert.notEqual(k.loadState(dir).status, "completed");
  assert.equal((await k.missionTick(dir)).action.kind, "handoff");
});
test("Attempts limit stops without creating another run", async t => {
  const dir = fixture(t, { features: [{ id: "f1", attempts: 5, maxAttempts: 5 }] });
  assert.equal((await k.missionTick(dir)).action.gate, "attempts"); assert.equal(k.loadState(dir).sessions.length, 0);
});
test("Missing validators, required cancellation and fake completed status cannot produce done", async t => {
  for (const status of ["completed", "cancelled"]) {
    const dir = fixture(t, { features: [{ id: "f1", status }] });
    mutate(dir, state => { state.status = "completed"; state.milestoneValidationTriggered = { m1: true }; state.assertions = []; });
    assert.equal((await k.missionTick(dir)).action.kind, "incomplete_terminal_state");
  }
});
test("An orphan unknown intent blocks completion even if feature projections claim completed", async t => {
  const dir = fixture(t); await k.missionTick(dir);
  mutate(dir, state => { state.activeWorker = null; });
  const result = await k.missionTick(dir); assert.equal(result.action.type, "wait_user"); assert.equal(result.action.reason, "ORPHAN_DISPATCH_INTENT");
});
test("MCP aliases and CLI expose the same MissionTick gate without transport", async t => {
  const dir = fixture(t); k.rejectMissionPlan(dir, "Hold for review");
  assert.ok(MISSION_TOOLS.find(tool => tool.name === "MissionTick"));
  for (const name of ["MissionTick", "missionTick", "mission-tick"]) assert.equal((await callMissionTool(name, { missionDir: dir }, { dispatchAdapter: { runFeature: () => assert.fail("must never dispatch") } })).action.gate, "plan");
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(repo, "t3-mission/bridge/cli.mjs"), "MissionTick", "--mission-dir", dir, "--json", '{"observations":[]}'], { encoding: "utf8" }));
  assert.equal(cli.action.gate, "plan");
});
for (const [name, additions] of [
  ["wrong version", { version: 2 }], ["short summary", { summary: "success" }], ["no commit", { commit: null }],
  ["failed check", { tests: [{ command: "check", status: "failed" }] }], ["missing issues", { discoveredIssues: null }],
  ["missing left undone", { whatWasLeftUndone: null }], ["wrong feature", { featureId: "foreign" }],
]) test(`Result parser rejects ${name}`, () => {
  const action = { featureId: "f1", runId: "run-one" };
  assert.throws(() => parseMissionResult(fence(envelope(action, additions)), { feature: { id: "f1" }, runId: "run-one" }), { code: "INVALID_MISSION_RESULT" });
});
test("Validator parser requires every milestone assertion", () => {
  const action = { featureId: "scrutiny-validator-m1", runId: "run-one" };
  assert.throws(() => parseMissionResult(fence(envelope(action, { assertionResults: {} })), { feature: { id: action.featureId, milestoneId: "m1", kind: "scrutiny" }, runId: action.runId, assertions: [{ id: "VAL-T1", milestoneId: "m1" }] }), { code: "INVALID_MISSION_RESULT" });
});

test("Later pending child turns block End; a fresh identical terminal snapshot can unblock it", async t => {
  const { dir, action, binding, polled } = await bound(t);
  const done = obs("task_status", polled, taskStatus(binding, envelope(action)));
  assert.equal((await k.missionTick(dir, { observations: [done] })).action.kind, "integrate");
  const pending = obs("task_status", polled, taskStatus(binding, envelope(action), { hasPendingChildRuns: true }));
  assert.equal((await k.missionTick(dir, { observations: [pending] })).action.type, "sleep");
  assert.equal((await k.missionTick(dir, { observations: [done] })).action.kind, "integrate");
  assert.equal(logs(dir).length, 0);
});
test("Raw archive replays in received order after loss of controller ledger", async t => {
  const { dir, action, binding, polled } = await bound(t);
  const done = obs("task_status", polled, taskStatus(binding, envelope(action)));
  await k.missionTick(dir, { observations: [done] });
  await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action), { hasPendingChildRuns: true }))] });
  fs.unlinkSync(path.join(dir, ".mission/autopilot/controller.json"));
  assert.equal((await k.missionTick(dir)).action.type, "poll"); assert.equal(logs(dir).length, 0);
});
test("Crash after durable raw receipt, before ledger save, recovers without a second dispatch", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action, binding = receipt(action);
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = function(from, to, ...args) {
    if (!injected && String(to).endsWith("autopilot/controller.json")) { injected = true; throw Object.assign(new Error("injected controller ledger EIO"), { code: "EIO" }); }
    return rename.call(this, from, to, ...args);
  };
  try { await assert.rejects(k.missionTick(dir, { observations: [obs("dispatch", action, mcp(binding))] }), { code: "EIO" }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  const next = await k.missionTick(dir);
  assert.equal(next.action.type, "poll"); assert.equal(next.action.taskId, binding.taskId); assert.equal(k.loadState(dir).sessions.length, 1);
});
test("Crash after End before ledger consumed marker does not End twice", async t => {
  const { dir, action, binding, polled } = await bound(t);
  await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action)))] });
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = function(from, to, ...args) {
    if (!injected && String(to).endsWith("autopilot/controller.json") && !k.loadState(dir).activeWorker) { injected = true; throw Object.assign(new Error("injected death after End"), { code: "EIO" }); }
    return rename.call(this, from, to, ...args);
  };
  try { await assert.rejects(k.missionTick(dir, { observations: [obs("integration", action, { branch: "mission/toy", sourceBranch: "feature/f1", commit: sha, mergeSha: sha })] }), { code: "EIO" }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.equal(logs(dir).length, 1);
  assert.equal((await k.missionTick(dir)).action.type, "dispatch"); assert.equal(logs(dir).length, 1);
});
for (const value of [{ accepted: true }, { delegation: { response: { accepted: true } } }, { accepted: false, taskId: "rejected", childThreadId: "rejected" }])
test(`Incomplete or refused acceptance ${JSON.stringify(value)} stays inflight`, async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const result = await k.missionTick(dir, { observations: [obs("dispatch", action, value)] });
  assert.equal(result.action.type, "recover_dispatch"); assert.equal(inspectDispatchRecords(dir)[0].phase, "inflight"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
});
test("An explicit MCP wrapper refusal cannot hide behind structuredContent", async t => {
  const dir = fixture(t), action = (await k.missionTick(dir)).action;
  const result = await k.missionTick(dir, { observations: [obs("dispatch", action, { accepted: false, ...mcp(receipt(action)) })] });
  assert.equal(result.action.type, "recover_dispatch"); assert.equal(inspectDispatchRecords(dir)[0].phase, "inflight");
});
test("A validator passed flag without the second assertion stage cannot complete the Mission", async t => {
  const { dir } = await drive(t);
  mutate(dir, state => { state.status = "orchestrator_turn"; delete state.assertions[0].stageResults.user_testing; });
  const result = await k.missionTick(dir);
  assert.equal(result.action.type, "orchestrator_decision"); assert.equal(result.action.kind, "incomplete_mission"); assert.notEqual(k.loadState(dir).status, "completed");
});
test("Invalid integration policy fails before a Mission plan can claim auto permission", t => {
  assert.throws(() => fixture(t, { integration: { auto: true } }), { code: "INVALID_INTEGRATION_POLICY" });
});
test("Unavailable kernel refuses MissionTick without writes", async t => {
  const { createFallbackKernel } = await import("../bridge/mcp-server.mjs");
  const dir = fixture(t), before = snapshot(dir);
  await assert.rejects(callMissionTool("MissionTick", { missionDir: dir }, { kernel: createFallbackKernel() }), { code: "KERNEL_UNAVAILABLE" });
  assert.deepEqual(snapshot(dir), before);
});
test("Multiple result fences, including a truncated extra fence, never count as success", () => {
  const action = { featureId: "f1", runId: "run-one" }, valid = fence(envelope(action));
  for (const raw of [valid + "\n" + valid, valid + "\n```mission-result\n{", valid + "\n```mission-result\n"]) {
    assert.throws(() => parseMissionResult(raw, { feature: { id: "f1" }, runId: action.runId }), { code: "INVALID_MISSION_RESULT" });
  }
});
test("T3 failed status cannot consume an envelope claiming success", async t => {
  const { dir, action, binding, polled } = await bound(t);
  const result = await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action), { status: "failed" }))] });
  assert.equal(result.action.kind, "result_unparseable"); assert.equal(logs(dir).length, 0);
});
test("Fast-forward integration requires the returned merge SHA to equal the source SHA", async t => {
  const { dir, action, binding, polled } = await bound(t);
  await k.missionTick(dir, { observations: [obs("task_status", polled, taskStatus(binding, envelope(action)))] });
  const result = await k.missionTick(dir, { observations: [obs("integration", action, { branch: "mission/toy", sourceBranch: "feature/f1", commit: sha, mergeSha: "b".repeat(40) })] });
  assert.equal(result.action.kind, "integration_conflict"); assert.equal(logs(dir).length, 0);
});
test("Invalid observation shape is rejected before any write", async t => {
  const dir = fixture(t), before = snapshot(dir);
  await assert.rejects(k.missionTick(dir, { observations: [{ type: "task_status", response: {} }] }), { code: "INVALID_OBSERVATIONS" });
  assert.deepEqual(snapshot(dir), before);
});
test("Autopilot HUD approve/pause/resume only change gates, using an in-memory HTTP transport", async t => {
  const http = (await import("node:http")).default;
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const { createMissionHudServer } = await import("../hud/server.mjs");
  const dir = fixture(t); k.rejectMissionPlan(dir, "Ready for HUD approval");
  const createServer = http.createServer; let handler; let runtimeCalls = 0;
  const server = new EventEmitter(); server.listening = false;
  server.listen = () => { server.listening = true; queueMicrotask(() => server.emit("listening")); return server; };
  server.close = callback => { server.listening = false; callback(); };
  server.address = () => ({ port: 0 });
  http.createServer = callback => { handler = callback; return server; };
  let hud;
  const forbidden = async () => { runtimeCalls++; assert.fail("HUD must never control an Autopilot provider"); };
  try { hud = await createMissionHudServer({ missionDir: dir, port: 0, dispatchAdapter: { runFeature: forbidden, startMissionRun: forbidden, pauseWorker: forbidden, resumeWorker: forbidden, pauseMission: forbidden } }); }
  finally { http.createServer = createServer; }
  t.after(() => hud.close());
  const post = async command => {
    const req = Readable.from([Buffer.from("{}")]); Object.assign(req, { method: "POST", url: `/api/mission/${command}`, headers: { host: "fixture.invalid" } });
    let status, body;
    await handler(req, { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } });
    assert.equal(status, 200); assert.equal(body.ok, true); return body.state;
  };
  const approved = await post("approve"); assert.equal(approved.planAccepted, true); assert.equal(approved.activeWorker, null);
  const action = (await k.missionTick(dir)).action; assert.equal(action.type, "dispatch");
  const paused = await post("pause"); assert.equal(paused.status, "paused"); assert.equal(paused.activeWorker.runId, action.runId);
  assert.equal((await k.missionTick(dir)).action.gate, "pause");
  const resumed = await post("resume"); assert.equal(resumed.activeWorker.runId, action.runId); assert.equal(resumed.status, "running");
  assert.equal((await k.missionTick(dir)).action.type, "recover_dispatch"); assert.equal(runtimeCalls, 0);
});
test("A feature referencing a missing milestone cannot dispatch", async t => {
  const dir = fixture(t, { milestones: [] });
  const result = await k.missionTick(dir);
  assert.equal(result.action.kind, "incomplete_mission"); assert.equal(inspectDispatchRecords(dir).length, 0);
});
