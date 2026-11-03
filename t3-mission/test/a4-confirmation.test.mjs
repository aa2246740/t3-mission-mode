import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import * as k from '../kernel/index.mjs';
import { dispatchReceiptSources, isPauseConfirmed, isResumeConfirmed, isDispatchRejected, isDispatchPending, unwrapMcpResponse } from '../kernel/schema.mjs';
import { readController } from '../kernel/autopilot-store.mjs';
import { applyAutopilotCommand } from '../kernel/autopilot-commands.mjs';
import { inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';
import { parseT3ToolOutput } from '../bridge/t3-adapter.mjs';
import { createHandlerHud, bounded } from './hud-handler-fixture.mjs';
import { hasActiveMissionTransaction } from '../kernel/mission-transaction.mjs';
import { inspectOwnedLocalWorker } from '../kernel/worker-process.mjs';
const target = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max', serviceTier: 'priority' } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wrap = (mode, inner, outer = {}) => mode === 'plain' ? inner : mode === 'response' ? { ...outer, response: inner } : mode === 'delegation' ? { ...outer, delegation: inner } : mode === 'structuredContent' ? { ...outer, structuredContent: inner } : { ...outer, content: [{ type: 'text', text: JSON.stringify(inner) }] };
function fixture(t, autopilot = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-confirmation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'A4 boundary', repoPath: dir, autopilot, ownerThreadId: 'owner-fixture', milestones: [{ id: 'm1' }], features: [{ id: 'f1', milestoneId: 'm1' }], assertions: [{ id: 'VAL-1', milestoneId: 'm1' }], modelSettings: { worker: target, validator: target }, integration: { branch: 'mission/a4', auto: true } });
  k.approveMissionPlan(dir); return dir;
}
const tick = async (dir, observations = [], now = Date.now()) => (await k.missionTick(dir, { observations, now })).action;
const observe = (type, action, response) => ({ type, featureId: action.featureId, runId: action.runId, intentId: action.intentId, taskId: response?.taskId ?? action.taskId, controlId: action.controlId, response });
async function boot(dir) { const timer = await tick(dir); return tick(dir, [{ type: 'timer', requestId: timer.requestId, response: { taskId: 'fixture-timer', enabled: true } }]); }
const receipt = action => ({ accepted: true, taskId: 'task-' + action.runId, childThreadId: 'thread-' + action.runId, ...target });
for (const mode of ['plain', 'response', 'delegation', 'structuredContent', 'content']) {
  for (const negative of [{ ok: false }, { accepted: false }, { paused: false }, { interrupted: false }, { canPause: false }, { isError: true }]) test(`A4 shared Pause refusal ${mode} ${Object.keys(negative)[0]}`, () => {
    const raw = wrap(mode, { ok: true, ...negative });
    assert.equal(isDispatchRejected(raw, 'pause'), true); assert.equal(isPauseConfirmed(raw), false);
  });
  for (const pending of [{ dispatchPending: true }, { pending: true }]) test(`A4 shared pending ${mode} ${Object.keys(pending)[0]}`, () => {
    const raw = wrap(mode, { ok: true, paused: true, resumed: true, ...pending });
    assert.equal(isDispatchPending(raw), true); assert.equal(isPauseConfirmed(raw), false); assert.equal(isResumeConfirmed(raw), false);
  });
  test(`A4 shared affirmative Pause and Resume ${mode}`, () => {
    assert.equal(isPauseConfirmed(wrap(mode, { paused: true })), true);
    assert.equal(isResumeConfirmed(wrap(mode, { sent: true })), true);
    assert.equal(isResumeConfirmed(wrap(mode, { ok: true })), false);
    assert.equal(isResumeConfirmed(wrap(mode, { sent: true, resumed: false })), false);
  });
}
for (const mode of ['structuredContent', 'content']) for (const outer of [{ accepted: false }, { ok: false }, { started: false }, { dispatchPending: true }, { pending: true }, { taskId: 'conflicting-task' }]) test(`A4 all decoding entrypoints retain outer veto ${mode} ${Object.keys(outer)[0]}`, async t => {
  const dir = fixture(t, false);
  const raw = wrap(mode, { accepted: true, taskId: 'inner-task', childThreadId: 'inner-thread', runtimeTransport: 't3-delegate-task' }, outer);
  assert.throws(() => unwrapMcpResponse(raw));
  assert.throws(() => parseT3ToolOutput(raw), error => error.runtimeResult === raw);
  await assert.rejects(k.startMissionRun(dir, {}, { runFeature: async () => raw }));
  const journal = fs.readdirSync(path.join(dir, '.mission')).find(name => /^dispatch-.*\.json$/.test(name));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.mission', journal))).phase, 'inflight');
  await assert.rejects(k.startMissionRun(dir, {}, { runFeature: async () => assert.fail('An inflight wrapper conflict cannot redispatch') }));
  assert.equal(k.loadState(dir).activeWorker.taskId, undefined);
  const file = fs.readdirSync(path.join(dir, '.mission/.txn/receipts'))[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mission/.txn/receipts', file))).result, raw);
});
for (const mode of ['same', 'different']) test(`A4 authentication reapproval ${mode} retains budget, backoff, and audits recovery`, async t => {
  const dir = fixture(t), first = await boot(dir), accepted = receipt(first);
  await tick(dir, [observe('dispatch', first, accepted)]);
  const failed = await tick(dir, [observe('task_status', first, { ...accepted, status: 'failed', workState: 'result_available', hasPendingChildRuns: false, summary: '401 Unauthorized: API key rejected' })]);
  assert.equal(failed.reason, 'PROVIDER_AUTH_REQUIRED');
  const old = k.loadState(dir), ledger = readController(dir, old.missionId), budget = ledger.features.f1;
  assert.deepEqual(budget.authBlock.target, target); assert.equal(budget.authBlock.approvalEpoch, 1);
  assert.equal((await tick(dir, [], Date.now() + 86400000)).reason, 'PROVIDER_AUTH_REQUIRED');
  const replacement = mode === 'same' ? target : { ...target, providerInstanceId: 'approved-replacement' };
  k.rejectMissionPlan(dir, 'Credentials repaired; approve this exact primary');
  k.proposeMission(dir, { title: old.title, repoPath: dir, autopilot: true, ownerThreadId: old.ownerThreadId, milestones: old.milestones, assertions: old.assertions, features: k.loadFeaturesDoc(dir).features.map(f => ({ ...f, target: replacement })), modelSettings: { worker: replacement, validator: replacement }, forceModelSettings: true, integration: old.integration });
  k.approveMissionPlan(dir);
  const sleeping = await tick(dir, [], Date.parse(budget.nextRetryAt) - 1);
  assert.equal(sleeping.type, 'sleep');
  const recovered = readController(dir, old.missionId), nextBudget = recovered.features.f1;
  assert.equal(recovered.consecutiveProviderErrors, ledger.consecutiveProviderErrors);
  assert.equal(nextBudget.providerErrors, budget.providerErrors); assert.equal(nextBudget.nextRetryAt, budget.nextRetryAt);
  assert.equal(recovered.runs[first.runId].consumed, true);
  assert.equal(nextBudget.invalidatedAuthBlocks[0].reason, mode === 'same' ? 'explicit_auth_recovery' : 'superseded_by_approval');
  assert.equal(nextBudget.invalidatedAuthBlocks[0].supersededByApprovalEpoch, 2);
  const action = await tick(dir, [], Date.parse(budget.nextRetryAt) + 1);
  assert.equal(action.type, 'dispatch'); assert.equal(action.attempt, 2);
  assert.equal(k.loadState(dir).activeWorker.providerInstanceId, replacement.providerInstanceId);
});
for (const response of [{ ok: true, resumed: false }, { ok: true, sent: false, canResume: false }, { sent: true, response: { accepted: false } }, { sent: true, dispatchPending: true }, {}, { sent: true }]) test(`A4 Autopilot Resume confirmation ${JSON.stringify(response)}`, async t => {
  const dir = fixture(t), first = await boot(dir), accepted = receipt(first);
  await tick(dir, [observe('dispatch', first, accepted)]); applyAutopilotCommand(dir, 'pause');
  const interrupt = await tick(dir);
  await tick(dir, [observe('interrupt', interrupt, { threadId: accepted.childThreadId, interrupted: true })]);
  applyAutopilotCommand(dir, 'resume'); const resume = await tick(dir); assert.equal(resume.type, 'resume_worker');
  const control = { threadId: accepted.childThreadId, ...response };
  const after = await tick(dir, [observe('resume', resume, control)]);
  const run = readController(dir, k.loadState(dir).missionId).runs[first.runId];
  assert.equal(run.pause.phase, isResumeConfirmed(control) ? 'resumed' : 'resume_requested');
  if (!isResumeConfirmed(control)) {
    assert.equal(after.type, 'wait_user'); assert.equal(run.controlError.code, 'INVALID_WORKER_CONTROL_RECEIPT');
    assert.equal((await tick(dir)).type, 'wait_user');
    await tick(dir, [observe('resume', resume, { threadId: accepted.childThreadId, sent: true })]);
    assert.equal(readController(dir, k.loadState(dir).missionId).runs[first.runId].pause.phase, 'resumed');
  }
});
test('A4 real Git deadline returns retryable diagnostics, leaves gate unchanged, and reaps its hook', async t => {
  const dir = fixture(t, false);
  execFileSync('git', ['init', '-q', dir]);
  await k.startMissionRun(dir, {}, { runFeature: async () => ({ accepted: true, taskId: 'git-task', childThreadId: 'git-thread', runtimeTransport: 't3-delegate-task' }) });
  const state = k.loadState(dir); state.status = 'paused'; state.pausedAt = 'pause-a4'; state.revision++; state.activeWorker.status = 'paused'; state.sessions[0].status = 'paused'; k.saveState(dir, state);
  const hook = path.join(dir, 'hook');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "%s" "$$" > "' + dir + '/hook-pid"\nwhile [ ! -f "' + dir + '/release" ]; do /bin/sleep 0.02; done\nprintf "\\n"\n', { mode: 0o700 });
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', hook]);
  const hud = await createHandlerHud({ missionDir: dir, gitPreflightTimeoutMs: 10000, runtimeAdapter: { resumeWorker: async () => assert.fail('Unverified Git cannot authorize Resume') } });
  t.after(() => hud.close());
  const before = fs.readFileSync(k.getMissionPaths(dir).statePath, 'utf8'); let response;
  try { response = await bounded(hud.post('resume'), 12000); }
  finally { fs.writeFileSync(path.join(dir, 'release'), 'release'); }
  assert.equal(response.status, 409); assert.equal(response.body.code, 'GIT_PREFLIGHT_TIMEOUT');
  assert.equal(response.body.gitCheck.retryable, true); assert.equal(response.body.gitCheck.clean, false); assert.equal(response.body.gitCheck.canResume, false);
  assert.equal(fs.readFileSync(k.getMissionPaths(dir).statePath, 'utf8'), before);
  const pid = Number(fs.readFileSync(path.join(dir, 'hook-pid')));
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); await delay(10); } catch (error) { assert.equal(error.code, 'ESRCH'); return; } }
  assert.fail('Git fsmonitor hook was not reaped after its deadline');
});
test('A4 native process arguments identify a plain child without external ps or a daemon', async t => {
  if (process.platform !== 'darwin') return;
  const native = createRequire(import.meta.url)('../native/mission-lock-darwin-arm64.node');
  const script = 'process.stdout.write("ready\\n");setInterval(()=>{},1000)';
  const child = spawn(process.execPath, ['-e', script, 'argument with spaces'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    assert.deepEqual(native.processArgs(child.pid), [process.execPath, '-e', script, 'argument with spaces']);
    assert.equal(native.processArgs(-1), null);
    const dir = fixture(t, false), file = path.join(dir, 'marker.json');
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, runId: 'run', featureId: 'f1', missionDir: dir, repoPath: dir }));
    assert.equal(inspectOwnedLocalWorker({ workerPid: child.pid, daemonStateFile: file, runId: 'run', featureId: 'f1' }, dir), null);
    assert.equal(hasActiveMissionTransaction(), false);
  } finally { child.kill('SIGTERM'); await done; }
  assert.equal(native.processArgs(child.pid), null);
});
for (const mutation of ['reject', 'revision', 'run']) test(`A4 Git completion revalidates ${mutation} before control`, async t => {
  const dir = fixture(t, false); execFileSync('git', ['init', '-q', dir]);
  await k.startMissionRun(dir, {}, { runFeature: async () => ({ accepted: true, taskId: 'task', childThreadId: 'thread', runtimeTransport: 't3-delegate-task' }) });
  const state = k.loadState(dir); state.status = 'paused'; state.pausedAt = 'original'; state.revision++; state.activeWorker.status = 'paused'; state.sessions[0].status = 'paused'; k.saveState(dir, state);
  const hook = path.join(dir, 'hook');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf entered > "' + dir + '/entered"\nwhile [ ! -f "' + dir + '/release" ]; do /bin/sleep 0.02; done\nprintf "\\n"\n', { mode: 0o700 });
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', hook]); let calls = 0;
  const hud = await createHandlerHud({ missionDir: dir, gitPreflightTimeoutMs: 10000, runtimeAdapter: { resumeWorker: async () => { calls++; return { resumed: true }; } } }); t.after(() => hud.close());
  const pending = hud.post('resume'); let saved;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(dir, 'entered'))) { assert.ok(Date.now() < deadline); await delay(10); }
    if (mutation === 'reject') k.rejectMissionPlan(dir, 'User revoked the plan during Git preflight');
    else {
      const current = k.loadState(dir); current.revision++;
      if (mutation === 'run') { current.activeWorker.runId = 'replacement-run'; current.sessions = [{ ...current.activeWorker }]; }
      k.saveState(dir, current);
    }
    saved = fs.readFileSync(k.getMissionPaths(dir).statePath, 'utf8');
  } finally { fs.writeFileSync(path.join(dir, 'release'), 'release'); }
  assert.equal((await bounded(pending)).status, 409); assert.equal(calls, 0);
  assert.equal(fs.readFileSync(k.getMissionPaths(dir).statePath, 'utf8'), saved);
});
