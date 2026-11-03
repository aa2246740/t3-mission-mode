import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as k from '../kernel/index.mjs';
import { inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';

const sha = 'a'.repeat(40), now = 1793000000000;
const wraps = { plain: x => x, response: x => ({ response: x }), delegation: x => ({ delegation: x }), structured: x => ({ structuredContent: x }), content: x => ({ content: [{ type: 'text', text: JSON.stringify(x) }] }) };
const controls = [
  ['positive', {}, true], ['rejected', { accepted: false }, false], ['isError', { isError: true }, false],
  ['pending', { pending: true }, false], ['dispatchPending', { dispatchPending: true }, false],
  ['identity-conflict', { threadId: 'first', response: { threadId: 'foreign' } }, false],
  ['scope-conflict', { featureId: 'first', response: { featureId: 'foreign' } }, false],
  ['invalid-text', { content: [{ type: 'text', text: '{' }] }, false],
  ['invalid-structured', { structuredContent: true }, false],
  ['array-payload', { delegation: [{ accepted: true }] }, false],
];
const tick = async (dir, observations = [], clock = now) => (await k.missionTick(dir, { observations, now: clock })).action;
const obs = (type, a, response) => ({ type, runId: a.runId, featureId: a.featureId, intentId: a.intentId, response });
function seed(dir, maxAttempts = 5) {
  fs.mkdirSync(dir);
  k.proposeMission(dir, { title: 'A6 global fixture', repoPath: dir, autopilot: true, ownerThreadId: 'a6-owner', pauseMode: 'let_finish', milestones: [{ id: 'm1' }], features: [{ id: 'f1', milestoneId: 'm1', maxAttempts }], assertions: [{ id: 'VAL-1', milestoneId: 'm1' }], integration: { branch: 'mission/a6', auto: true }, retryPolicy: { baseDelayMs: 1000, maxDelayMs: 10000 } });
  k.approveMissionPlan(dir);
}
const ledger = dir => JSON.parse(fs.readFileSync(path.join(dir, '.mission/autopilot/controller.json')));
async function boot(dir) { const timer = await tick(dir); return tick(dir, [{ type: 'timer', requestId: timer.requestId, response: { taskId: 'a6-timer', enabled: true } }]); }
async function integrate(dir) {
  const a = await boot(dir), child = { taskId: 'a6-task', childThreadId: 'a6-thread', childRunId: 'a6-child' };
  await tick(dir, [obs('dispatch', a, child)]);
  const result = { version: 1, featureId: 'f1', runId: a.runId, status: 'success', summary: 'Implemented the entire private test fixture and verified its observable behavior through the explicit commands recorded here.', commit: sha, branch: 'feature/a6', tests: [{ command: 'private-fixture', status: 'passed' }], discoveredIssues: [], whatWasLeftUndone: [] };
  const next = await tick(dir, [{ ...obs('task_status', a, { ...child, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '```mission-result\n' + JSON.stringify(result) + '\n```' }), taskId: child.taskId }]);
  assert.equal(next.kind, 'integrate'); return a;
}
async function requestDisable(dir) {
  let a = await boot(dir);
  for (let i = 0; i < 12; i++) {
    if (a.type === 'disable_timer') return a;
    assert.equal(a.type, 'dispatch');
    const child = { taskId: 'task-' + a.runId, childThreadId: 'thread-' + a.runId };
    await tick(dir, [obs('dispatch', a, child)]);
    const result = { version: 1, featureId: a.featureId, runId: a.runId, status: 'success', summary: 'Implemented and verified all the required private fixture behavior using the explicit checks in this result envelope.', tests: [{ command: 'private-fixture', status: 'passed' }], commit: sha, branch: 'feature/a6', testedSha: sha, assertionResults: { 'VAL-1': 'passed' }, failedAssertions: [], discoveredIssues: [], whatWasLeftUndone: [] };
    let next = await tick(dir, [{ ...obs('task_status', a, { ...child, status: 'completed', workState: 'result_available', hasPendingChildRuns: false, summary: '```mission-result\n' + JSON.stringify(result) + '\n```' }), taskId: child.taskId }]);
    if (next.kind === 'integrate') next = await tick(dir, [obs('integration', a, { branch: 'mission/a6', sourceBranch: 'feature/a6', commit: sha, mergeSha: sha })]);
    a = next;
  }
  assert.fail('Private fixture never requested timer disable');
}
for (const operation of ['timer', 'timer_disabled', 'integration']) test('A6 global observation matrix ' + operation, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-global-')), rows = [];
  t.after(() => { if (process.env.R9_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, 'observations-' + operation + '.json'), JSON.stringify({ operation, cases: rows.length, rows }, null, 2)); fs.rmSync(root, { recursive: true, force: true }); });
  let disabled;
  if (operation === 'timer_disabled') { const template = path.join(root, 'template'); seed(template); disabled = { template, action: await requestDisable(template) }; }
  for (const [container, wrap] of Object.entries(wraps)) for (const [name, control, success] of controls) await t.test(container + '/' + name, async () => {
    const dir = path.join(root, container + '-' + name);
    if (disabled) { fs.mkdirSync(dir); fs.cpSync(path.join(disabled.template, '.mission'), path.join(dir, '.mission'), { recursive: true }); } else seed(dir);
    const a = disabled?.action ?? (operation === 'timer' ? await tick(dir) : await integrate(dir));
    const body = operation !== 'integration' ? { taskId: 'a6-timer', enabled: operation === 'timer' } : { branch: 'mission/a6', sourceBranch: 'feature/a6', commit: sha, mergeSha: sha };
    const raw = wrap({ ...body, ...control }), row = { container, name, raw, expectedSuccess: success }; rows.push(row);
    try {
      row.next = await tick(dir, [{ ...obs(operation, a, raw), ...(operation !== 'integration' ? { requestId: a.requestId } : {}) }]);
      row.ledger = ledger(dir); row.features = k.loadFeaturesDoc(dir);
      if (operation !== 'integration') { assert.equal(row.ledger.timer.phase, success ? (disabled ? 'disabled' : 'confirmed') : (disabled ? 'disable_requested' : 'requested')); assert.equal(row.next.type, success ? (disabled ? 'done' : 'dispatch') : 'wait_user'); }
      else { assert.equal(row.features.features[0].status, success ? 'completed' : 'running'); assert.equal(Boolean(row.features.features[0].integration), success); assert.equal(Boolean(row.ledger.runs[a.runId].integration), success); }
      row.pass = true;
    } catch (error) { row.pass = false; row.assertion = error.stack; throw error; }
  });
});
for (const count of [0, 2]) test('A6 unknown recovery stops only after matching count=' + count, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-recovery-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'Recovery ambiguity', autopilot: true, repoPath: dir, ownerThreadId: 'a6-owner', milestones: [{ id: 'm1' }], features: [{ id: 'f1', milestoneId: 'm1' }] }); k.approveMissionPlan(dir);
  const a = await boot(dir); assert.equal((await tick(dir, [obs('dispatch', a, { isError: true })])).type, 'recover_dispatch');
  const next = await tick(dir, [obs('children', a, { threads: Array.from({ length: count }, (_, i) => ({ taskId: 'task-' + i, childThreadId: 'thread-' + i, clientRequestId: a.intentId, parentThreadId: 'a6-owner' })) })]);
  assert.equal(next.type, 'wait_user'); assert.equal(next.reason, 'DISPATCH_RECOVERY_AMBIGUOUS');
  assert.equal(inspectDispatchRecords(dir)[0].phase, 'inflight'); assert.equal(inspectDispatchRecords(dir)[0].intent.clientRequestId, a.intentId); assert.equal(k.loadState(dir).sessions.length, 1);
});
test('A6 bare refusal reaches the attempt budget without clearing counters', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-budget-')), dir = path.join(root, 'mission'); t.after(() => fs.rmSync(root, { recursive: true, force: true })); seed(dir, 2);
  const first = await boot(dir); assert.equal((await tick(dir, [obs('dispatch', first, { blocked: true })])).type, 'sleep');
  const second = await tick(dir, [], now + 1000); assert.equal(second.type, 'dispatch'); assert.equal(second.attempt, 2);
  const last = await tick(dir, [obs('dispatch', second, { accepted: false, code: 'PROVIDER_BUSY' })], now + 1000);
  assert.equal(last.type, 'wait_user'); assert.equal(last.reason, 'MAX_ATTEMPTS_EXCEEDED'); assert.equal(ledger(dir).features.f1.providerErrors, 2); assert.equal(k.loadState(dir).sessions.length, 2); assert.equal(inspectDispatchRecords(dir).every(r => r.phase === 'retryable'), true);
});
test('A6 scheduler requires an enabled boolean and matches the disabled acknowledgement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-enabled-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [i, enabled] of [undefined, false, 'true'].entries()) {
    const dir = path.join(root, String(i)); seed(dir); const a = await tick(dir);
    assert.equal((await tick(dir, [{ type: 'timer', requestId: a.requestId, response: { taskId: 'timer', enabled } }])).type, 'wait_user'); assert.equal(ledger(dir).timer.phase, 'requested');
  }
});
