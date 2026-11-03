import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
import { requestIds, recoverTask, dispatchFailure, providerFailure, retryDeadline } from "../kernel/autopilot-policy.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const A = "a".repeat(40), B = "b".repeat(40), NOW = Date.parse("2026-10-23T08:00:00Z");
const target = { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "max", serviceTier: "priority" } };
const alternative = { ...target, providerInstanceId: "codex-approved" };
const summary = "The toy executor checked this exact integration commit and all declared behaviors. This is a local protocol fixture with no real provider calls.";
const tick = async (dir, observations = [], now = NOW) => (await k.missionTick(dir, { observations, now })).action;
const ledger = dir => readController(dir, k.loadState(dir).missionId);
const logs = dir => k.readProgressLog(dir).filter(item => item.type === "feature_run_ended");
const observe = (type, action, response, extra = {}) => ({ type, featureId: action.featureId, runId: action.runId, intentId: action.intentId, taskId: action.taskId, controlId: action.controlId, response, ...extra });
const wrapped = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
function fixture(t, input = {}) {
  const dir = fs.mkdtempSync(path.join(root, ".wp2-toy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { autopilot: true, repoPath: dir, title: "WP2 toy", ownerThreadId: "owner-A", milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", title: "Toy feature" }], assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    modelSettings: { worker: target, validator: target }, integration: { branch: "mission/toy", auto: true }, ...input });
  k.approveMissionPlan(dir); return dir;
}
async function boot(dir) {
  let action = await tick(dir);
  if (action.type === "identify_owner") action = await tick(dir, [{ type: "owner", response: wrapped({ parentThreadId: "owner-A", inheritedOptions: {} }) }]);
  assert.equal(action.type, "ensure_timer");
  return tick(dir, [{ type: "timer", requestId: action.requestId, response: wrapped({ taskId: "timer-A", enabled: true }) }]);
}
function receipt(action) {
  return { taskId: `node:${action.runId}`, childThreadId: `thread:${action.runId}`, childRunId: `turn:${action.runId}`, ...action.delegateTask.target, status: "running", workState: "working", hasPendingChildRuns: false };
}
function envelope(action, additions = {}) {
  return { version: 1, featureId: action.featureId, runId: action.runId, status: "success", summary, tests: [{ command: "toy behavior", status: "passed" }],
    commit: A, branch: `feature/${action.featureId}`, discoveredIssues: [], whatWasLeftUndone: [], testedSha: A, assertionResults: { "VAL-1": "passed" }, failedAssertions: [], ...additions };
}
const fence = value => "```mission-result\n" + JSON.stringify(value) + "\n```";
const status = (binding, action, additions = {}) => ({ ...binding, status: "completed", workState: "result_available", hasPendingChildRuns: false, summary: fence(envelope(action)), ...additions });
async function bind(dir, action) {
  const binding = receipt(action);
  const poll = await tick(dir, [observe("dispatch", action, wrapped(binding))]);
  assert.equal(poll.type, "poll"); return { action, binding, poll };
}
async function complete(dir, action, additions = {}) {
  const { binding, poll } = await bind(dir, action);
  let next = await tick(dir, [observe("task_status", poll, status(binding, action, { summary: fence(envelope(action, additions)) }))]);
  if (next.kind === "integrate") next = await tick(dir, [observe("integration", action, { ...next.context, mergeSha: next.context.commit })]);
  return next;
}
async function drive(dir, action, sha = A, trace = []) {
  for (let turns = 0; turns < 30; turns++) {
    trace.push(action);
    if (action.type === "done") return { action, trace };
    if (action.type === "dispatch") action = await complete(dir, action, { commit: sha, testedSha: sha });
    else if (action.type === "disable_timer") action = await tick(dir, [{ type: "timer_disabled", requestId: action.requestId, response: { task: { id: action.scheduledTaskId, enabled: false } } }]);
    else assert.fail(JSON.stringify(action));
  }
  assert.fail("Toy did not converge");
}
function snapshot(dir) {
  const result = {};
  const walk = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) walk(file);
    else result[path.relative(dir, file)] = [fs.readFileSync(file).toString("base64"), fs.statSync(file, { bigint: true }).mtimeNs.toString()];
  } };
  walk(path.join(dir, ".mission")); return result;
}
function evidence(name, dir, trace) {
  if (!process.env.WP2_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.WP2_EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.WP2_EVIDENCE_DIR, `${name}.json`), JSON.stringify({ level: "local fake T3 protocol; no provider, scheduler, or Git merge", trace, state: k.loadState(dir), features: k.loadFeaturesDoc(dir), ledger: ledger(dir), journal: inspectDispatchRecords(dir), ends: logs(dir) }, null, 2) + "\n");
}

test("WP2 owner identification persists verbatim before timer and dispatch", async t => {
  const dir = fixture(t, { ownerThreadId: undefined });
  assert.equal((await tick(dir)).type, "identify_owner");
  assert.equal(k.loadState(dir).activeWorker, null);
  const action = await boot(dir);
  assert.equal(action.type, "dispatch"); assert.equal(k.loadState(dir).ownerThreadId, "owner-A");
});
test("WP2 timer is requested once, confirms raw ID, and disables before done; terminal ticks write nothing", async t => {
  const dir = fixture(t, { timerEveryMs: 120000 });
  const timer = await tick(dir);
  assert.deepEqual(timer.schedule, { type: "interval", everyMs: 120000 }); assert.ok(timer.prompt.includes(dir));
  const before = snapshot(dir);
  assert.equal((await tick(dir)).reason, "TIMER_OUTCOME_UNKNOWN"); assert.deepEqual(snapshot(dir), before);
  const first = await tick(dir, [{ type: "timer", requestId: timer.requestId, response: { taskId: "timer-A", enabled: true } }]);
  const { action, trace } = await drive(dir, first);
  assert.equal(action.status, "completed"); assert.equal(trace.filter(item => item.type === "disable_timer").length, 1);
  assert.equal(ledger(dir).timer.scheduledTaskId, "timer-A"); assert.equal(ledger(dir).timer.phase, "disabled");
  const done = snapshot(dir); await tick(dir); await tick(dir); assert.deepEqual(snapshot(dir), done);
  evidence("timer-to-done", dir, [timer, ...trace]);
});
test("WP2 default timer is ten minutes; failed or wrong timer receipts cannot dispatch", async t => {
  const dir = fixture(t), timer = await tick(dir);
  assert.equal(timer.schedule.everyMs, 600000);
  assert.equal((await tick(dir, [{ type: "timer", requestId: "wrong", response: { id: "other" } }])).reason, "TIMER_IDENTITY_CONFLICT");
  assert.equal(k.loadState(dir).activeWorker, null);
});
test("WP2 recover request ID from any URL encoded ID despite a different MCP session", () => {
  const id = "t3m:stable:request", threadId = `thread:delegated-task:${encodeURIComponent(`command:mcp:new-session:delegate-task:${id}`)}`;
  assert.deepEqual(requestIds({ arbitraryId: threadId }), [id]);
  const recovered = recoverTask([{ threads: [{ id: threadId, parentThreadId: "owner-A" }] }], { clientRequestId: id }, "owner-A");
  assert.equal(recovered.childThreadId, threadId); assert.equal(recovered.taskId, threadId.replace(/^thread:/, "node:"));
  assert.throws(() => recoverTask([{ threads: [{ id: threadId, parentThreadId: "wrong" }] }], { clientRequestId: id }, "owner-A"), { code: "DISPATCH_RECOVERY_AMBIGUOUS" });
  assert.throws(() => recoverTask([{ threads: [null] }], { clientRequestId: id }, "owner-A"), { code: "INVALID_RECOVERY_LIST" });
});
test("WP2 SIGKILL after dispatch intent, fresh process recovery with real T3 thread IDs and pagination reaches done", async t => {
  const dir = fixture(t); const timer = await tick(dir);
  const observations = [{ type: "timer", requestId: timer.requestId, response: { id: "timer-A", enabled: true } }];
  const program = `import {missionTick} from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)}; console.log(JSON.stringify(await missionTick(${JSON.stringify(dir)},{observations:${JSON.stringify(observations)}}))); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const action = await new Promise((resolve, reject) => { let data = ""; child.on("error", reject); child.stdout.on("data", chunk => { data += chunk; if (data.includes("\n")) resolve(JSON.parse(data).action); }); child.on("exit", code => { if (!data) reject(new Error(`child exited ${code}`)); }); });
  child.kill("SIGKILL"); await new Promise(resolve => child.on("close", resolve));
  const recovered = JSON.parse(execFileSync(process.execPath, [path.join(root, "t3-mission/bridge/cli.mjs"), "MissionTick", "--mission-dir", dir], { encoding: "utf8" })).action;
  assert.equal(recovered.type, "recover_dispatch"); assert.equal(recovered.t3ThreadList.includeSubagents, true); assert.equal(recovered.t3ThreadList.titleContains, action.delegateTask.title);
  const threadId = `thread:delegated-task:${encodeURIComponent(`command:mcp:changed-session:delegate-task:${action.intentId}`)}`;
  const page2 = await tick(dir, [observe("children", recovered, wrapped({ threads: [{ threadId, parentThreadId: "owner-A" }], nextCursor: "page-2" }))]);
  assert.equal(page2.type, "recover_dispatch"); assert.equal(page2.t3ThreadList.cursor, "page-2"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
  const poll = await tick(dir, [observe("children", page2, { threads: [], nextCursor: null }, { cursor: "page-2" })]);
  assert.equal(poll.taskId, threadId.replace(/^thread:/, "node:")); assert.equal(k.loadState(dir).sessions.length, 1);
  let next = await tick(dir, [observe("task_status", poll, { taskId: poll.taskId, childThreadId: threadId, status: "completed", workState: "result_available", hasPendingChildRuns: false, summary: fence(envelope(action)) })]);
  next = await tick(dir, [observe("integration", action, { ...next.context, mergeSha: A })]);
  const result = await drive(dir, next); assert.equal(result.action.type, "done");
  evidence("killed-owner-recovery", dir, [action, recovered, page2, poll, ...result.trace]);
});
for (const count of [0, 2]) test(`WP2 recovery ${count} owner matches never redispatches`, async t => {
  const dir = fixture(t), action = await boot(dir);
  const threads = Array.from({ length: count }, (_, i) => ({ ...receipt(action), clientRequestId: action.intentId, parentThreadId: "owner-A", taskId: `node:${i}`, childThreadId: `thread:${i}` }));
  const next = await tick(dir, [observe("children", action, { threads })]);
  assert.equal(next.type, "wait_user"); assert.equal(next.reason, "DISPATCH_RECOVERY_AMBIGUOUS"); assert.equal(k.loadState(dir).sessions.length, 1);
});
test("WP2 recovery requires parentThreadId even for explicit request keys", async t => {
  const dir = fixture(t), action = await boot(dir);
  const next = await tick(dir, [observe("children", action, { tasks: [{ ...receipt(action), clientRequestId: action.intentId }] })]);
  assert.equal(next.type, "wait_user"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
});
test("WP2 failure classifier distinguishes transport, rejection, unknown, rate and authentication", () => {
  assert.equal(dispatchFailure({ code: "NO_T3_TRANSPORT" }).kind, "acceptance_unknown");
  assert.equal(dispatchFailure({ accepted: false }).kind, "not_accepted");
  assert.equal(dispatchFailure({ error: "timeout" }).kind, "acceptance_unknown");
  assert.equal(dispatchFailure({ accepted: true }).kind, "acceptance_unknown");
  assert.equal(providerFailure({ summary: "Claude API rate limit reached. Try again later. 429" }).kind, "provider_rate");
  assert.equal(providerFailure({ summary: "401 Unauthorized API key" }).kind, "provider_auth");
  assert.equal(retryDeadline({ retryAfter: "120" }, NOW, 1), new Date(NOW + 120000).toISOString());
  assert.equal(retryDeadline({ headers: { "Retry-After": "Fri, 23 Oct 2026 08:02:00 GMT" } }, NOW, 1), new Date(NOW + 120000).toISOString());
  assert.equal(retryDeadline({}, NOW, 99, { baseDelayMs: 1000, maxDelayMs: 5000 }), new Date(NOW + 5000).toISOString());
});
for (const [response, expected, nextType] of [[{ code: "NO_T3_TRANSPORT" }, "NO_T3_TRANSPORT", "recover_dispatch"], [{ accepted: false, error: "unavailable" }, "DISPATCH_NOT_ACCEPTED", "sleep"]]) test(`WP2 ${expected} remains a classified gate with no replacement child`, async t => {
  const dir = fixture(t), action = await boot(dir);
  const next = await tick(dir, [observe("dispatch", action, response)]);
  assert.equal(next.type, nextType); await tick(dir); assert.equal(k.loadState(dir).sessions.length, 1);
});
for (const approved of [false, true]) test(`WP2 429 persists retry deadline and ${approved ? "uses approved fallback" : "keeps original target"} then succeeds`, async t => {
  const dir = fixture(t, approved ? { fallbackTargets: { worker: [alternative] } } : {}), action = await boot(dir);
  const { binding, poll } = await bind(dir, action);
  const sleep = await tick(dir, [observe("task_status", poll, status(binding, action, { status: "failed", summary: "429 rate limit. Try again later.", headers: { "Retry-After": "90" } }))]);
  assert.equal(sleep.type, "sleep"); assert.equal(sleep.until, new Date(NOW + 90000).toISOString());
  const before = snapshot(dir);
  assert.equal((await tick(dir, [], NOW + 89999)).type, "sleep"); assert.deepEqual(snapshot(dir), before);
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(root, "t3-mission/bridge/cli.mjs"), "MissionTick", "--mission-dir", dir, "--json", JSON.stringify({ now: NOW + 1000 })], { encoding: "utf8" }));
  assert.equal(cli.action.until, sleep.until); assert.equal(ledger(dir).consecutiveProviderErrors, 1);
  const retry = await tick(dir, [], NOW + 90000);
  assert.equal(retry.type, "dispatch"); assert.equal(retry.attempt, 2); assert.notEqual(retry.intentId, action.intentId);
  assert.deepEqual(retry.delegateTask.target, approved ? alternative : target);
  if (approved) assert.match(ledger(dir).features.f1.switches[0].reason, /429/);
  const final = await drive(dir, retry); assert.equal(final.action.type, "done");
  evidence(approved ? "approved-fallback" : "rate-retry-original", dir, [action, sleep, retry, ...final.trace]);
});
test("WP2 provider budget persists across restarts and stops before another attempt", async t => {
  const dir = fixture(t, { retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxConsecutiveProviderErrors: 2 } });
  let action = await boot(dir);
  for (let n = 0; n < 2; n++) {
    const { binding, poll } = await bind(dir, action);
    action = await tick(dir, [observe("task_status", poll, status(binding, action, { status: "failed", summary: "429 rate limit" }))], NOW + n * 100);
    if (n === 0) action = await tick(dir, [], NOW + 100);
  }
  assert.equal(action.reason, "PROVIDER_ERROR_BUDGET_EXHAUSTED");
  const reopened = JSON.parse(execFileSync(process.execPath, [path.join(root, "t3-mission/bridge/cli.mjs"), "MissionTick", "--mission-dir", dir], { encoding: "utf8" }));
  assert.equal(reopened.action.reason, "PROVIDER_ERROR_BUDGET_EXHAUSTED"); assert.equal(k.loadState(dir).sessions.length, 2);
});
test("WP2 feature attempts budget persists independently of Mission provider budget", async t => {
  const dir = fixture(t, { features: [{ id: "f1", maxAttempts: 1 }] }), action = await boot(dir);
  const { binding, poll } = await bind(dir, action);
  const next = await tick(dir, [observe("task_status", poll, status(binding, action, { status: "failed", summary: "429" }))]);
  assert.equal(next.reason, "MAX_ATTEMPTS_EXCEEDED"); assert.equal(ledger(dir).consecutiveProviderErrors, 1);
});
test("WP2 authentication errors wait for user without an approved alternate", async t => {
  const dir = fixture(t), action = await boot(dir), { binding, poll } = await bind(dir, action);
  const next = await tick(dir, [observe("task_status", poll, status(binding, action, { status: "failed", summary: "401 Unauthorized" }))]);
  assert.equal(next.reason, "PROVIDER_AUTH_REQUIRED"); assert.equal(logs(dir).length, 1);
});
test("WP2 worker failure envelope is separate from provider failure and retries immediately", async t => {
  const dir = fixture(t), action = await boot(dir);
  const retry = await complete(dir, action, { status: "failure", commit: null, branch: null, tests: [{ command: "toy failure", status: "failed" }] });
  assert.equal(retry.type, "dispatch"); assert.equal(retry.attempt, 2); assert.equal(ledger(dir).runs[action.runId].failure.kind, "worker_failure");
  assert.equal(ledger(dir).consecutiveProviderErrors, 0);
});
test("WP2 wrong testedSha cannot write passed or End", async t => {
  const dir = fixture(t); let action = await complete(dir, await boot(dir));
  assert.equal(action.featureId, "scrutiny-validator-m1");
  const next = await complete(dir, action, { testedSha: B });
  assert.equal(next.kind, "result_unparseable"); assert.equal(next.context.code, "VALIDATION_SHA_MISMATCH");
  assert.equal(k.loadState(dir).assertions[0].stageResults?.scrutiny, undefined); assert.equal(logs(dir).length, 1);
});
test("WP2 validation failure yields failedAssertions, repair makes prior stages stale, and automatically revalidates to done", async t => {
  const dir = fixture(t); let action = await complete(dir, await boot(dir));
  action = await complete(dir, action); // scrutiny passed, user testing selected
  const failedId = action.featureId;
  action = await complete(dir, action, { status: "failure", assertionResults: { "VAL-1": "failed" }, failedAssertions: ["VAL-1"], tests: [{ command: "toy acceptance", status: "failed" }] });
  assert.equal(action.kind, "validation_failed"); assert.deepEqual(action.context.failedAssertions, ["VAL-1"]);
  assert.equal(k.loadState(dir).assertions[0].stageResults.scrutiny, "passed");
  k.updateMissionFeatures(dir, { addFeatures: [{ id: "repair-one", kind: "repair", milestoneId: "m1", sourceFeatureId: failedId, title: "Repair failed assertion", resolvesHandoffItemIds: [`${failedId}:validator_failure`] }] });
  const repair = await tick(dir); assert.equal(repair.featureId, "repair-one");
  const validate = await complete(dir, repair, { commit: B });
  assert.equal(validate.type, "dispatch"); assert.equal(validate.featureId, "scrutiny-validator-m1");
  assert.deepEqual(k.loadState(dir).assertions[0].stageResults, { scrutiny: "stale", user_testing: "stale" });
  assert.ok(validate.delegateTask.task.includes(B));
  const final = await drive(dir, validate, B);
  assert.equal(final.action.type, "done");
  assert.deepEqual(k.loadState(dir).assertions[0].stageTestedSha, { scrutiny: B, user_testing: B });
  assert.equal(logs(dir).length, 6);
  evidence("repair-and-revalidation", dir, [action, repair, ...final.trace]);
});
test("WP2 interrupt Pause acts once; Resume sends to the same child and consumes latestTerminal once", async t => {
  const dir = fixture(t), action = await boot(dir), { binding, poll } = await bind(dir, action);
  applyAutopilotCommand(dir, "pause");
  const interrupt = await tick(dir); assert.equal(interrupt.type, "interrupt_worker"); assert.equal(interrupt.threadId, binding.childThreadId);
  assert.equal((await tick(dir)).type, "wait_user");
  const paused = await tick(dir, [observe("interrupt", interrupt, { threadId: binding.childThreadId, interrupted: true })]); assert.equal(paused.gate, "pause");
  await tick(dir, [observe("task_status", poll, status(binding, action, { status: "interrupted", summary: "Stopped by user", latestTerminalRunId: "old-turn", latestTerminalSummary: "Stopped by user" }))]);
  applyAutopilotCommand(dir, "resume");
  const resume = await tick(dir); assert.equal(resume.type, "resume_worker"); assert.equal(resume.threadId, binding.childThreadId); assert.ok(resume.message.includes(action.runId));
  const resumed = await tick(dir, [observe("resume", resume, { threadId: binding.childThreadId, accepted: true })]); assert.equal(resumed.type, "poll");
  const old = await tick(dir, [observe("task_status", resumed, status(binding, action, { status: "interrupted", summary: "Stopped by user", latestTerminalRunId: "old-turn", latestTerminalSummary: "Stopped by user" }))]); assert.equal(old.type, "sleep");
  const terminal = observe("task_status", resumed, status(binding, action, { status: "interrupted", summary: "old non-result", latestTerminalRunId: "new-turn", latestTerminalSummary: fence(envelope(action)) }));
  let next = await tick(dir, [terminal]); assert.equal(next.kind, "integrate");
  next = await tick(dir, [observe("integration", action, { ...next.context, mergeSha: A }), terminal]);
  assert.equal(k.loadState(dir).sessions.filter(item => item.featureId === "f1").length, 1); assert.equal(logs(dir).length, 1);
  await tick(dir, [terminal]); assert.equal(logs(dir).length, 1);
  const final = await drive(dir, next); assert.equal(final.action.type, "done");
  evidence("pause-resume-latest-terminal", dir, [interrupt, paused, resume, resumed, old, ...final.trace]);
});
test("WP2 let_finish Pause retains the original child without thread control", async t => {
  const dir = fixture(t, { pauseMode: "let_finish" }), action = await boot(dir), { binding, poll } = await bind(dir, action);
  applyAutopilotCommand(dir, "pause"); assert.equal((await tick(dir)).gate, "pause");
  await tick(dir, [observe("task_status", poll, status(binding, action))]);
  applyAutopilotCommand(dir, "resume"); assert.equal((await tick(dir)).kind, "integrate"); assert.equal(logs(dir).length, 0);
});
test("WP2 failed validator provider call backs off without recording acceptance failure", async t => {
  const dir = fixture(t); const action = await complete(dir, await boot(dir)); const { binding, poll } = await bind(dir, action);
  const next = await tick(dir, [observe("task_status", poll, status(binding, action, { status: "failed", summary: "429 rate limit" }))]);
  assert.equal(next.type, "sleep"); assert.equal(k.loadState(dir).lastHandoffNeedsAttention, false); assert.equal(k.loadState(dir).assertions[0].stageResults?.scrutiny, undefined);
});
test("WP2 unknown acceptance queries the original intent instead of repeating dispatch", async t => {
  const dir = fixture(t), action = await boot(dir);
  const next = await tick(dir, [observe("dispatch", action, { error: "connection lost after write" })]);
  assert.equal(next.type, "recover_dispatch"); assert.equal(next.clientRequestId, action.intentId);
  assert.equal(ledger(dir).runs[action.runId].failure.kind, "acceptance_unknown"); assert.equal(k.loadState(dir).sessions.length, 1);
});
test("WP2 explicit unaccepted 429 journals nonacceptance, waits Retry-After, and opens a bounded new attempt", async t => {
  const dir = fixture(t), action = await boot(dir);
  const next = await tick(dir, [observe("dispatch", action, { accepted: false, summary: "429 rate limit", retryAfter: 60 })]);
  assert.equal(next.type, "sleep"); assert.equal(next.until, new Date(NOW + 60000).toISOString());
  assert.equal(inspectDispatchRecords(dir)[0].phase, "retryable");
  const retry = await tick(dir, [], NOW + 60000); assert.equal(retry.attempt, 2); assert.notEqual(retry.intentId, action.intentId);
  const final = await drive(dir, retry); assert.equal(final.action.type, "done");
  evidence("rejected-rate-retry", dir, [action, next, retry, ...final.trace]);
});
test("WP2 multiple matches across recovery pages cannot bind the first page prematurely", async t => {
  const dir = fixture(t), action = await boot(dir);
  const item = { ...receipt(action), clientRequestId: action.intentId, parentThreadId: "owner-A" };
  const next = await tick(dir, [observe("children", action, { tasks: [item], nextCursor: "second" })]);
  assert.equal(next.type, "recover_dispatch"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
  const ambiguous = await tick(dir, [observe("children", next, { tasks: [{ ...item, taskId: "other", childThreadId: "other" }] }, { cursor: "second" })]);
  assert.equal(ambiguous.reason, "DISPATCH_RECOVERY_AMBIGUOUS"); assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
});
test("WP2 a new shared integration head invalidates previously passed milestones before done", async t => {
  const dir = fixture(t, { milestones: [{ id: "m1" }, { id: "m2" }], features: [{ id: "f1", milestoneId: "m1" }, { id: "f2", milestoneId: "m2" }] });
  let action = await boot(dir);
  action = await complete(dir, action);
  action = await complete(dir, action);
  action = await complete(dir, action);
  assert.equal(action.featureId, "f2");
  assert.deepEqual(k.loadState(dir).assertions[0].stageTestedSha, { scrutiny: A, user_testing: A });
  action = await complete(dir, action, { commit: B });
  assert.equal(action.type, "dispatch");
  assert.deepEqual(k.loadState(dir).assertions[0].stageResults, { scrutiny: "stale", user_testing: "stale" });
  const final = await drive(dir, action, B); assert.equal(final.action.type, "done");
  assert.ok(final.trace.some(item => item.type === "dispatch" && item.featureId === "scrutiny-validator-m1"));
  const state = k.loadState(dir), features = k.loadFeaturesDoc(dir).features;
  assert.equal(state.integration.mergeSha, B);
  assert.equal(features.filter(k.isValidatorFeature).every(feature => feature.lastHandoff.testedSha === B), true);
  evidence("shared-head-revalidation", dir, final.trace);
});
test("WP2 a consumable result received during Pause resumes without sending another turn", async t => {
  const dir = fixture(t), action = await boot(dir), { binding, poll } = await bind(dir, action);
  applyAutopilotCommand(dir, "pause");
  assert.equal((await tick(dir, [observe("task_status", poll, status(binding, action))])).gate, "pause");
  applyAutopilotCommand(dir, "resume"); assert.equal((await tick(dir)).kind, "integrate"); assert.equal(ledger(dir).runs[action.runId].pause, undefined);
});
test("WP2 second Pause epoch interrupts once again without accepting an old resume receipt", async t => {
  const dir = fixture(t), action = await boot(dir), { binding } = await bind(dir, action);
  applyAutopilotCommand(dir, "pause"); const first = await tick(dir);
  await tick(dir, [observe("interrupt", first, { threadId: binding.childThreadId, interrupted: true })]);
  applyAutopilotCommand(dir, "resume"); const resume = await tick(dir);
  await tick(dir, [observe("resume", resume, { threadId: binding.childThreadId, sent: true })]);
  applyAutopilotCommand(dir, "pause"); const second = await tick(dir);
  assert.equal(second.type, "interrupt_worker"); assert.notEqual(second.controlId, first.controlId);
  assert.equal((await tick(dir)).type, "wait_user");
  await tick(dir, [observe("resume", resume, { threadId: binding.childThreadId, sent: true })]);
  assert.equal(ledger(dir).runs[action.runId].pause.phase, "interrupt_requested");
});
test("WP2 missing validator testedSha or inconsistent failedAssertions never writes a passed stage", async t => {
  for (const additions of [{ testedSha: undefined }, { status: "failure", assertionResults: { "VAL-1": "failed" }, failedAssertions: [] }]) {
    const dir = fixture(t), validator = await complete(dir, await boot(dir));
    const next = await complete(dir, validator, additions);
    assert.equal(next.kind, "result_unparseable"); assert.equal(k.loadState(dir).assertions[0].stageResults?.scrutiny, undefined);
  }
});
test("WP2 a new permission gate blocks resume_worker until the user resolves it", async t => {
  const dir = fixture(t), action = await boot(dir), { binding } = await bind(dir, action);
  applyAutopilotCommand(dir, "pause"); const interrupt = await tick(dir);
  await tick(dir, [observe("interrupt", interrupt, { threadId: binding.childThreadId, interrupted: true })]);
  applyAutopilotCommand(dir, "resume");
  const state = k.loadState(dir); state.permissions = [{ id: "account", status: "pending" }]; k.saveState(dir, state);
  assert.equal((await tick(dir)).gate, "permission"); assert.equal(ledger(dir).runs[action.runId].pause.phase, "interrupted");
  state.permissions[0].status = "approved"; k.saveState(dir, state);
  assert.equal((await tick(dir)).type, "resume_worker");
});
for (const input of [{ pauseMode: "restart" }, { timerEveryMs: 0 }, { retryPolicy: { baseDelayMs: -1 } }, { fallbackTargets: { worker: [{ providerInstanceId: "x", model: "y" }] } }]) test(`WP2 invalid policy ${JSON.stringify(input)} is rejected at proposal`, t => {
  assert.throws(() => fixture(t, input), { code: "INVALID_AUTOPILOT_POLICY" });
});

test("T3 timer creation supplies the native scheduler arguments and a durable request key", async t => {
  const dir = fixture(t), action = await tick(dir);
  assert.deepEqual(action.scheduleTask, {
    clientRequestId: action.requestId,
    schedule: { type: "interval", everyMs: 600000 },
    prompt: action.prompt,
    bindToCurrentThread: true,
  });
});
test("T3 timer disable supplies scheduledTaskId to the native update tool", async t => {
  const dir = fixture(t), action = await boot(dir);
  const done = await drive(dir, action);
  const disable = done.trace.find(item => item.type === "disable_timer");
  assert.deepEqual(disable.updateScheduledTask, { scheduledTaskId: "timer-A", enabled: false });
});
test("Rejected selection returns a dispatch gate without inventing an intent", async t => {
  const dir = fixture(t);
  const state = k.loadState(dir); state.status = "initializing"; k.saveState(dir, state);
  const timer = await tick(dir);
  const action = await tick(dir, [{ type: "timer", requestId: timer.requestId, response: { scheduledTaskId: "timer-A", enabled: true } }]);
  assert.equal(action.type, "wait_user");
  assert.equal(action.reason, "MISSION_NOT_DISPATCHABLE");
  assert.equal(k.loadState(dir).activeWorker, null);
  assert.deepEqual(inspectDispatchRecords(dir), []);
});

for (const policy of ["removed", "changed-options", "other-role", "feature-role-changed", "still-approved"]) test(`WP2 cached fallback requires current role approval after replan: ${policy}`, async t => {
  const dir = fixture(t, { fallbackTargets: { worker: [alternative] } });
  const first = await boot(dir), { binding, poll } = await bind(dir, first);
  const sleep = await tick(dir, [observe("task_status", poll, status(binding, first, { status: "failed", summary: "429 rate limit", headers: { "Retry-After": "1" } }))]);
  assert.equal(sleep.type, "sleep");
  assert.deepEqual(ledger(dir).features.f1.target, alternative);
  k.rejectMissionPlan(dir, "Revise fallback permission before retry");
  const state = k.loadState(dir), features = k.loadFeaturesDoc(dir).features;
  const fallbackTargets = policy === "removed" ? { worker: [] }
    : policy === "changed-options" ? { worker: [{ ...alternative, options: { ...alternative.options, reasoningEffort: "high" } }] }
    : policy === "other-role" ? { worker: [], validator: [alternative] }
    : { worker: [alternative], validator: [] };
  if (policy === "feature-role-changed") features[0].kind = "scrutiny";
  k.proposeMission(dir, { autopilot: true, repoPath: dir, title: state.title, ownerThreadId: state.ownerThreadId,
    milestones: state.milestones, features, assertions: state.assertions,
    modelSettings: k.loadModelSettings(dir), integration: state.integration, fallbackTargets });
  k.approveMissionPlan(dir);
  const ownerBytes = () => Object.fromEntries(["state.json", "features.json", "model-settings.json", "progress_log.jsonl"].map(name => [name, fs.readFileSync(path.join(dir, ".mission", name), "utf8")]));
  const before = ownerBytes(), records = inspectDispatchRecords(dir), approved = k.loadState(dir);
  const original = records.find(record => record.intent.runId === first.runId);
  assert.equal(original.receipt.taskId, binding.taskId);
  const budgetBefore = ledger(dir);
  if (policy !== "still-approved") {
    assert.equal(approved.planApprovalEpoch, budgetBefore.features.f1.approvalEpoch + 1);
    const waiting = await tick(dir, [], Date.parse(sleep.until) - 1);
    assert.equal(waiting.type, "sleep"); assert.equal(waiting.until, sleep.until);
    const invalidated = ledger(dir), budget = invalidated.features.f1;
    assert.deepEqual(budget.invalidatedFallbacks, [{ target: alternative,
      invalidatedAt: new Date(Date.parse(sleep.until) - 1).toISOString(), reason: "superseded_by_approval",
      approvalEpoch: budgetBefore.features.f1.approvalEpoch, supersededByApprovalEpoch: approved.planApprovalEpoch }]);
    assert.equal(Object.hasOwn(budget, "target"), false);
    assert.equal(Object.hasOwn(budget, "approvalEpoch"), false);
    assert.equal(budget.providerErrors, budgetBefore.features.f1.providerErrors);
    assert.equal(invalidated.consecutiveProviderErrors, budgetBefore.consecutiveProviderErrors);
    assert.equal(budget.nextRetryAt, sleep.until);
    assert.deepEqual(budget.switches, budgetBefore.features.f1.switches);
    assert.deepEqual(invalidated.runs, budgetBefore.runs);
    assert.deepEqual(ownerBytes(), before); assert.deepEqual(inspectDispatchRecords(dir), records);
    assert.deepEqual(k.loadState(dir).sessions, approved.sessions);
  }
  const action = await tick(dir, [], Date.parse(sleep.until));
  const currentRecords = inspectDispatchRecords(dir);
  assert.deepEqual(currentRecords.find(record => record.intent.runId === first.runId), original);
  if (policy === "still-approved") {
    assert.equal(action.type, "dispatch");
    assert.deepEqual(action.delegateTask.target, alternative);
    assert.equal(action.attempt, 2); assert.notEqual(action.runId, first.runId);
    assert.notEqual(action.intentId, first.intentId);
    const next = await tick(dir, [], Date.parse(sleep.until));
    assert.equal(next.type, "recover_dispatch"); assert.equal(next.intentId, action.intentId);
  } else {
    assert.equal(action.type, "dispatch");
    assert.deepEqual(action.delegateTask.target, target);
    assert.notDeepEqual(action.delegateTask.target, alternative);
    assert.equal(action.attempt, 2); assert.notEqual(action.runId, first.runId);
    assert.notEqual(action.intentId, first.intentId);
    const current = ledger(dir);
    assert.equal(current.features.f1.providerErrors, budgetBefore.features.f1.providerErrors);
    assert.equal(current.consecutiveProviderErrors, budgetBefore.consecutiveProviderErrors);
    assert.equal(current.features.f1.nextRetryAt, sleep.until);
    assert.deepEqual(current.features.f1.switches, budgetBefore.features.f1.switches);
    for (const [runId, run] of Object.entries(budgetBefore.runs)) assert.deepEqual(current.runs[runId], run);
    assert.deepEqual(k.loadState(dir).sessions.slice(0, approved.sessions.length), approved.sessions);
    assert.equal(k.loadState(dir).activeWorker.kind, policy === "feature-role-changed" ? "scrutiny" : "implementation");
    assert.equal(k.loadFeaturesDoc(dir).features[0].attempts, 2);
    assert.equal(currentRecords.length, records.length + 1);
    const dispatched = ownerBytes(), next = await tick(dir, [], Date.parse(sleep.until));
    assert.equal(next.type, "recover_dispatch"); assert.equal(next.intentId, action.intentId);
    assert.deepEqual(ownerBytes(), dispatched);
    assert.deepEqual(inspectDispatchRecords(dir), currentRecords);
  }
  evidence(`fallback-current-approval-${policy}`, dir, [{ approved, before }, first, sleep, action]);
});
