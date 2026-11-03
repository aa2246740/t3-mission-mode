import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as k from '../kernel/index.mjs';
import { readController, saveController, readObservations } from '../kernel/autopilot-store.mjs';
import { hasActiveMissionTransaction, runClaimedEffect, setTransactionTestHook, transactionHash } from '../kernel/mission-transaction.mjs';
const actor = fileURLToPath(new URL('./fixtures/wp3-actor.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = process.env.WP3_EVIDENCE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wp3-evidence-'));
fs.mkdirSync(evidence, { recursive: true });
let serial = 0;
function workspace(name) { const dir = path.join(evidence, `${serial++}-${name}`); fs.mkdirSync(dir); return dir; }
function sync(operation, dir, input = {}) {
  const r = spawnSync(process.execPath, [actor, operation, dir, JSON.stringify(input)], { encoding: 'utf8', timeout: 15000 });
  fs.writeFileSync(path.join(dir, `${operation}-${serial++}.stdout.log`), r.stdout ?? '');
  fs.writeFileSync(path.join(dir, `${operation}-${serial++}.stderr.log`), r.stderr ?? '');
  assert.equal(r.status, 0, r.stderr || String(r.error)); return JSON.parse(r.stdout).result;
}
function child(operation, dir, input = {}) {
  const p = spawn(process.execPath, [actor, operation, dir, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', chunk => { stdout += chunk; }); p.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => p.on('exit', (code, signal) => {
    fs.writeFileSync(path.join(dir, `${operation}-${p.pid}.stdout.log`), stdout);
    fs.writeFileSync(path.join(dir, `${operation}-${p.pid}.stderr.log`), stderr);
    resolve({ code, signal, stdout, stderr, result: code === 0 ? JSON.parse(stdout).result : null });
  }));
  return { p, done };
}
async function ready(file) { const limit = Date.now() + 10000; while (!fs.existsSync(file)) { assert.ok(Date.now() < limit, 'Owned actor did not reach barrier'); await sleep(10); } }
function initialized(name) { const dir = workspace(name); sync('init', dir); return dir; }
const binding = state => ({ featureId: state.activeWorker.featureId, runId: state.activeWorker.runId, expectedRevision: state.revision, runtimeTransport: 't3-delegate-task', taskId: 'bound-task', childThreadId: 'bound-thread', childRunId: 'bound-child' });

test('WP3 R01: real Bind and Reject serialize through the public kernel and MCP entry', async () => {
  const dir = initialized('R01'); sync('start', dir);
  const before = k.loadState(dir), barrier = { ready: path.join(dir, 'bind-ready'), release: path.join(dir, 'bind-release'), role: 'projection:features.json', operation: 'rename', boundary: 'before' };
  const bind = child('bind', dir, { payload: binding(before), trace: true, barrier });
  await ready(barrier.ready);
  const reject = child('gate', dir, { kind: 'reject' });
  await sleep(50); fs.writeFileSync(barrier.release, 'release');
  const results = await Promise.all([bind.done, reject.done]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const final = sync('read', dir);
  assert.equal(final.state.planAccepted, false); assert.equal(final.state.status, 'planning');
  assert.equal(final.state.revision, before.revision + 2);
  assert.equal(final.state.activeWorker.taskId, 'bound-task');
  assert.equal(final.progressLog.filter(row => row.type === 'plan_rejected').length, 1);
  assert.deepEqual(final.progressLog.map(row => row.seq), final.progressLog.map((_, i) => i + 1));
});

test('WP3 R02 and R05: direct official append and observation APIs lose no events or sequence numbers', async () => {
  const dir = initialized('R02-R05');
  const logsBefore = k.readProgressLog(dir).length;
  const writers = Array.from({ length: 6 }, (_, id) => child('append', dir, { id: 'event-' + id }));
  for (const r of await Promise.all(writers.map(w => w.done))) assert.equal(r.code, 0, r.stderr);
  const facts = Array.from({ length: 6 }, (_, id) => child('archive', dir, { id: 'fact-' + id }));
  for (const r of await Promise.all(facts.map(w => w.done))) assert.equal(r.code, 0, r.stderr);
  const snapshot = sync('read', dir);
  assert.equal(snapshot.progressLog.length, logsBefore + 6);
  assert.equal(new Set(snapshot.progressLog.map(row => row.seq)).size, snapshot.progressLog.length);
  assert.deepEqual(snapshot.observations.map(row => row.sequence), [1, 2, 3, 4, 5, 6]);
});

test('WP3 R03: SIGKILL between actual Bind projection renames recovers one complete official snapshot', async () => {
  const dir = initialized('R03'); sync('start', dir);
  const barrier = { ready: path.join(dir, 'bound-feature'), release: path.join(dir, 'never-release'), role: 'projection:features.json', operation: 'rename', boundary: 'after' };
  const writer = child('bind', dir, { payload: binding(k.loadState(dir)), trace: true, barrier });
  await ready(barrier.ready); writer.p.kill('SIGKILL');
  assert.equal((await writer.done).signal, 'SIGKILL');
  const snapshot = sync('read', dir);
  for (const record of [snapshot.state.activeWorker, snapshot.state.sessions[0], snapshot.featuresDoc.features[0]]) assert.equal(record.taskId, 'bound-task');
  assert.equal(snapshot.records[0].phase, 'accepted');
  const bytes = fs.readFileSync(path.join(dir, '.mission/progress_log.jsonl'), 'utf8');
  sync('read', dir); assert.equal(fs.readFileSync(path.join(dir, '.mission/progress_log.jsonl'), 'utf8'), bytes);
});

test('WP3 R04: concurrent reducers preserve every consumed ledger record', async () => {
  const dir = initialized('R04');
  const writers = ['A', 'B', 'C', 'D'].map(id => child('ledger', dir, { id }));
  for (const r of await Promise.all(writers.map(w => w.done))) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(sync('read', dir).ledger.runs).sort(), ['A', 'B', 'C', 'D']);
  const old = readController(dir, k.loadState(dir).missionId);
  sync('ledger', dir, { id: 'new' }); old.runs.stale = { consumed: true };
  assert.throws(() => saveController(dir, old), { code: 'TX_STALE_REVISION' });
  assert.equal(readController(dir, k.loadState(dir).missionId).runs.stale, undefined);
});

for (const gate of ['pause', 'reject']) test(`WP3 transport await permits independent ${gate} and preserves the accepted receipt`, async () => {
  const dir = initialized('await-' + gate), input = { ready: path.join(dir, 'transport-ready'), release: path.join(dir, 'transport-release'), pauseCalls: path.join(dir, 'pause-calls.jsonl') };
  const writer = child('transport', dir, input); await ready(input.ready);
  const gated = sync('gate', dir, { kind: gate });
  assert.equal(gated.status, gate === 'pause' ? 'paused' : 'planning');
  fs.writeFileSync(input.release, 'accepted');
  const r = await writer.done; assert.equal(r.code, 0, r.stderr);
  const snapshot = sync('read', dir);
  assert.equal(snapshot.state.status, gate === 'pause' ? 'paused' : 'planning');
  assert.equal(snapshot.records[0].phase, 'accepted');
  if (gate === 'pause') {
    assert.equal(snapshot.state.pausedAt, gated.pausedAt);
    for (const record of [snapshot.state.activeWorker, snapshot.state.sessions[0], snapshot.featuresDoc.features[0]]) { assert.equal(record.taskId, 'wp3-task'); assert.equal(record.slot, 'worker'); }
    assert.equal(fs.readFileSync(input.pauseCalls, 'utf8').trim().split('\n').length, 1);
  } else {
    assert.equal(snapshot.state.planAccepted, false); assert.equal(snapshot.state.activeWorker.taskId, undefined);
    assert.equal(fs.existsSync(input.pauseCalls), false);
  }
});

test('WP3 independent CLI/MCP updates retain both feature mutations and monotonic revision', async () => {
  const dir = initialized('updates'), before = k.loadState(dir).revision;
  const results = await Promise.all(['left', 'right'].map(id => child('update', dir, { payload: { commandId: 'update-' + id, addFeatures: [{ id, milestoneId: 'm1' }] } }).done));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const snapshot = sync('read', dir);
  assert.deepEqual(snapshot.featuresDoc.features.map(f => f.id).sort(), ['f1', 'left', 'right']);
  assert.equal(snapshot.state.revision, before + 2);
});

test('WP3 concurrent controller ticks return one dispatch claim and one recovery action', async () => {
  const dir = initialized('ticks');
  const results = await Promise.all([child('tick', dir).done, child('tick', dir).done]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(results.map(r => r.result.action.type).sort(), ['dispatch', 'recover_dispatch']);
  assert.equal(k.loadState(dir).sessions.length, 1);
});

test('WP3 command retry never grants the same external dispatch action twice', () => {
  const dir = initialized('command-replay');
  const first = sync('tick', dir, { payload: { commandId: 'one-tick' } });
  const second = sync('tick', dir, { payload: { commandId: 'one-tick' } });
  assert.equal(first.action.type, 'dispatch'); assert.equal(second.action.type, 'recover_dispatch');
  const before = k.readMissionSnapshot(dir);
  const r = spawnSync(process.execPath, [actor, 'tick', dir, JSON.stringify({ payload: { commandId: 'one-tick', now: 123 } })], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /TX_COMMAND_ID_CONFLICT/);
  assert.deepEqual(k.readMissionSnapshot(dir), before);
});

test('WP3 stale loaded state and detached revision guesses cannot overwrite a newer gate', () => {
  const dir = initialized('stale-save'), old = k.loadState(dir);
  sync('gate', dir, { kind: 'reject' }); old.revision += 1;
  assert.throws(() => k.saveState(dir, old), { code: 'TX_STALE_REVISION' });
  const detached = { ...k.loadState(dir), planAccepted: true };
  assert.throws(() => k.saveState(dir, detached), { code: 'TX_EXPECTED_REVISION_REQUIRED' });
  assert.equal(k.loadState(dir).planAccepted, false);
});

test('WP3 nested transaction rejects reentry and Promise reducers without business writes', () => {
  const dir = initialized('reentry'), before = k.readMissionSnapshot(dir);
  assert.throws(() => k.withMissionTransaction(dir, () => k.withMissionTransaction(dir, () => {})), { code: 'TX_REENTRANT' });
  assert.throws(() => k.withMissionTransaction(dir, () => { k.appendProgressLog(dir, { message: 'rollback' }); return Promise.resolve(); }), { code: 'TX_ASYNC_REDUCER' });
  assert.deepEqual(k.readMissionSnapshot(dir), before);
});

test('WP3 direct loaded document replacements and Reject retries retain their conflict boundaries', () => {
  const dir = initialized('document-conflicts');
  const oldDoc = k.loadFeaturesDoc(dir), oldSettings = k.loadModelSettings(dir);
  sync('update', dir, { payload: { addFeatures: [{ id: 'new-feature', milestoneId: 'm1' }] } });
  oldDoc.features[0].title = 'stale replacement';
  assert.throws(() => k.saveFeaturesDoc(dir, oldDoc), { code: 'TX_STALE_REVISION' });
  k.saveModelSettings(dir, { ...oldSettings, skipUserTesting: false });
  assert.throws(() => k.saveModelSettings(dir, oldSettings), { code: 'TX_STALE_REVISION' });
  const before = k.loadState(dir);
  k.rejectMissionPlan(dir, 'Once', { commandId: 'reject-once' });
  const after = k.readMissionSnapshot(dir);
  assert.equal(after.state.revision, before.revision + 1);
  k.rejectMissionPlan(dir, 'Once', { commandId: 'reject-once' });
  assert.deepEqual(k.readMissionSnapshot(dir), after);
  assert.throws(() => k.rejectMissionPlan(dir, 'Different', { commandId: 'reject-once' }), { code: 'TX_COMMAND_ID_CONFLICT' });
});

test('WP3 held lock returns busy, a different Mission commits, and SIGKILL releases the original lock', async () => {
  const dir = initialized('lock-one'), other = initialized('lock-two');
  const input = { ready: path.join(dir, 'lock-ready'), release: path.join(dir, 'never-release') };
  const holder = child('hold', dir, input); await ready(input.ready);
  try {
    assert.throws(() => k.withMissionTransaction(dir, () => {}, { lockTimeoutMs: 20 }), { code: 'TX_BUSY' });
    sync('append', other, { id: 'independent' });
  } finally { holder.p.kill('SIGKILL'); await holder.done; }
  assert.equal(sync('read', dir).state.missionId, 'wp3-owned-mission');
});

test('WP3 explicit effects execute outside the lock and a missing receipt never invokes them twice', async () => {
  const dir = initialized('effects'); let calls = 0;
  const response = await runClaimedEffect(dir, 'resume-fixture', async () => { assert.equal(hasActiveMissionTransaction(), false); calls++; return { resumed: true }; });
  assert.equal(response.resumed, true);
  await runClaimedEffect(dir, 'resume-fixture', () => { calls++; });
  assert.equal(calls, 1);
  await assert.rejects(runClaimedEffect(dir, 'unknown-fixture', () => { throw new Error('lost external receipt'); }), /lost external receipt/);
  await assert.rejects(runClaimedEffect(dir, 'unknown-fixture', () => { calls++; }), { code: 'TX_EFFECT_OUTCOME_UNKNOWN' });
  assert.equal(calls, 1);
});

test('WP3 invalid WAL and foreign lock fail closed; a missing native backend never writes a Mission', async () => {
  const dir = initialized('corrupt-wal');
  fs.writeFileSync(path.join(dir, '.mission/.txn/prepare.json'), JSON.stringify({ version: 8, payload: {} }));
  assert.throws(() => k.readMissionSnapshot(dir), { code: 'TX_WAL_CORRUPT' });
  const lockDir = initialized('foreign-lock');
  fs.unlinkSync(path.join(lockDir, '.mission/.txn/writer.lock'));
  fs.symlinkSync(path.join(dir, '.mission/state.json'), path.join(lockDir, '.mission/.txn/writer.lock'));
  assert.throws(() => k.readMissionSnapshot(lockDir));
  const missing = workspace('missing-backend'), module = path.join(missing, 'mission-transaction.mjs');
  fs.copyFileSync(new URL('../kernel/mission-transaction.mjs', import.meta.url), module);
  const program = `import { withMissionTransaction } from ${JSON.stringify(pathToFileURL(module).href)}; withMissionTransaction(${JSON.stringify(path.join(missing, '.mission'))}, () => {});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
  fs.writeFileSync(path.join(missing, 'stderr.log'), result.stderr);
  assert.equal(result.status, 1); assert.match(result.stderr, /TX_LOCK_BACKEND_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(missing, '.mission/state.json')), false);
});

test('WP3 concurrent End notifications commit one session, one End event, and one command result', async () => {
  const dir = initialized('end-once'); sync('start', dir);
  const state = k.loadState(dir);
  const payload = { runId: state.activeWorker.runId, featureId: 'f1', successState: 'success', validatorsPassed: true, handoff: { whatWasImplemented: 'Implemented and checked the complete owned fixture work with a deterministic public interface and no external side effects.' } };
  const results = await Promise.all([child('end', dir, { payload }).done, child('end', dir, { payload }).done]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const snapshot = sync('read', dir);
  assert.equal(snapshot.state.sessions.length, 1);
  assert.equal(snapshot.progressLog.filter(row => row.type === 'feature_run_ended').length, 1);
  assert.equal(snapshot.featuresDoc.features[0].status, 'completed');
  const bytes = fs.readFileSync(path.join(dir, '.mission/progress_log.jsonl'), 'utf8');
  sync('end', dir, { payload });
  assert.equal(fs.readFileSync(path.join(dir, '.mission/progress_log.jsonl'), 'utf8'), bytes);
});

test('WP3 MW-R9C-01: old child identity cannot confirm an unknown Resume response', async () => {
  const { settlePausedWorkerResult } = await import('../kernel/runner.mjs');
  const dir = initialized('resume-confirmation'); sync('start', dir); sync('bind', dir, { payload: binding(k.loadState(dir)) });
  const before = k.loadState(dir), current = k.loadState(dir);
  current.status = 'paused'; current.pausedAt = '2026-10-23T00:00:00.000Z'; current.revision++;
  current.activeWorker.status = 'paused'; current.activeWorker.pausedAt = current.pausedAt;
  current.sessions[0].status = 'paused'; current.sessions[0].pausedAt = current.pausedAt; k.saveState(dir, current);
  const snapshot = k.readMissionSnapshot(dir); let pauses = 0;
  for (const response of [undefined, {}, { status: 'running' }, { taskId: 'bound-task', childThreadId: 'bound-thread' }, { response: { resumed: true, dispatchPending: true } }, { delegation: { resumed: false, accepted: true } }]) {
    assert.equal(await settlePausedWorkerResult(dir, before, before.activeWorker, response, null, { pauseWorker: async () => { pauses++; } }, 'resume'), null);
    assert.deepEqual(k.readMissionSnapshot(dir), snapshot);
  }
  assert.equal(pauses, 0);
  const positive = { resumed: true, taskId: 'bound-task', childThreadId: 'bound-thread', runtimeTransport: 't3-delegate-task' };
  await settlePausedWorkerResult(dir, before, before.activeWorker, positive, null, { pauseWorker: async () => { pauses++; return { paused: true }; } }, 'resume');
  await settlePausedWorkerResult(dir, before, before.activeWorker, positive, null, { pauseWorker: async () => { pauses++; } }, 'resume');
  assert.equal(pauses, 1); assert.equal(k.loadState(dir).pausedAt, current.pausedAt);
  assert.equal(k.loadState(dir).revision, current.revision + 1);
});

test('WP3 MW-PARENT-01: reapproval cannot use a revoked cached fallback, even for a different role', async () => {
  for (const reapproved of [false, true]) for (const change of ['removed', 'validator-only', 'changed-options', 'feature-role-changed', 'still-approved']) {
    const dir = workspace('fallback-' + change);
    const target = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max', serviceTier: 'priority' } };
    const alternate = { ...target, providerInstanceId: 'codex-approved-then-revoked' };
    const input = { autopilot: true, repoPath: dir, ownerThreadId: 'fixture-owner',
      features: [{ id: 'f1', milestoneId: 'm1' }], milestones: [{ id: 'm1' }],
      modelSettings: { worker: target, validator: target, skipScrutiny: true, skipUserTesting: true },
      integration: { auto: true, branch: 'mission/private' }, fallbackTargets: { worker: [alternate] } };
    k.proposeMission(dir, input); k.approveMissionPlan(dir);
    const tick = (observations = [], now) => sync('tick', dir, { payload: { observations, ...(now === undefined ? {} : { now }) } }).action;
    const timer = tick();
    const first = tick([{ type: 'timer', requestId: timer.requestId, response: { scheduledTaskId: 'fixture-timer', enabled: true } }]);
    assert.equal(first.type, 'dispatch');
    const observation = (type, action, response) => ({ type, featureId: action.featureId, runId: action.runId, intentId: action.intentId, taskId: action.taskId, response });
    const receipt = { taskId: 'fixture-provider-task', childThreadId: 'fixture-provider-child', ...first.delegateTask.target, status: 'running' };
    const poll = tick([observation('dispatch', first, receipt)]);
    const backoff = tick([observation('task_status', poll, { ...receipt, status: 'failed', workState: 'result_available', hasPendingChildRuns: false, summary: '429 rate limit', headers: { 'Retry-After': '1' } })]);
    assert.equal(backoff.type, 'sleep');
    assert.deepEqual(readController(dir, k.loadState(dir).missionId).features.f1.target, alternate);
    if (reapproved) k.rejectMissionPlan(dir, 'Revoke the cached fallback');
    const fallbackTargets = change === 'removed' ? { worker: [] } : change === 'validator-only' ? { worker: [], validator: [alternate] } : change === 'changed-options' ? { worker: [{ ...alternate, options: { reasoningEffort: 'high', serviceTier: 'priority' } }] } : { worker: [alternate], validator: [] };
    const features = k.loadFeaturesDoc(dir).features;
    if (change === 'feature-role-changed') features[0].kind = 'scrutiny';
    if (reapproved) {
      k.proposeMission(dir, { ...input, features, fallbackTargets }); k.approveMissionPlan(dir);
    } else k.withMissionTransaction(dir, () => {
      const state = k.loadState(dir); state.fallbackTargets = fallbackTargets; k.saveState(dir, state);
      const doc = k.loadFeaturesDoc(dir); doc.features = features; k.saveFeaturesDoc(dir, doc);
    });
    const before = sync('read', dir);
    const action = tick([], Date.parse(backoff.until));
    if (change === 'still-approved' || reapproved) {
      assert.equal(action.type, 'dispatch');
      assert.deepEqual(action.delegateTask.target, change === 'still-approved' ? alternate : target);
      if (change !== 'still-approved') {
        const after = sync('read', dir), budget = after.ledger.features.f1, oldBudget = before.ledger.features.f1;
        assert.deepEqual(budget.invalidatedFallbacks, [{ target: alternate, invalidatedAt: backoff.until,
          reason: 'superseded_by_approval', approvalEpoch: oldBudget.approvalEpoch, supersededByApprovalEpoch: before.state.planApprovalEpoch }]);
        assert.equal(Object.hasOwn(budget, 'target'), false); assert.equal(Object.hasOwn(budget, 'approvalEpoch'), false);
        assert.equal(budget.providerErrors, oldBudget.providerErrors); assert.equal(budget.nextRetryAt, oldBudget.nextRetryAt);
        assert.equal(after.ledger.consecutiveProviderErrors, before.ledger.consecutiveProviderErrors);
        assert.deepEqual(budget.switches, oldBudget.switches);
        for (const [id, run] of Object.entries(before.ledger.runs)) assert.deepEqual(after.ledger.runs[id], run);
        assert.deepEqual(after.state.sessions.slice(0, before.state.sessions.length), before.state.sessions);
        assert.equal(after.state.activeWorker.kind, change === 'feature-role-changed' ? 'scrutiny' : 'implementation');
      }
      assert.notEqual(action.runId, first.runId); assert.notEqual(action.intentId, first.intentId);
      assert.equal(action.attempt, 2);
      const after = sync('read', dir);
      assert.deepEqual(after.records.find(record => record.intent.runId === first.runId), before.records.find(record => record.intent.runId === first.runId));
      const again = tick([], Date.parse(backoff.until)); assert.equal(again.type, 'recover_dispatch'); assert.equal(again.intentId, action.intentId);
    } else {
      assert.equal(action.type, 'wait_user'); assert.equal(action.reason, 'FALLBACK_APPROVAL_REVOKED');
      assert.equal(action.role, change === 'feature-role-changed' ? 'validator' : 'worker');
      assert.deepEqual(sync('read', dir), before, 'Revoked target cannot change projections, budgets or accepted journals');
      assert.deepEqual(tick([], Date.parse(backoff.until)), action);
      assert.deepEqual(sync('read', dir), before);
    }
  }
});

test('WP3 a copied committed WAL, changed checksum, or unknown version never rewrites another Mission', () => {
  const source = initialized('foreign-source');
  let injected = false;
  setTransactionTestHook(event => {
    if (!injected && event.operation === 'rename' && event.role === 'projection:state.json' && event.boundary === 'before') {
      injected = true; throw Object.assign(new Error('owned committed WAL EIO'), { code: 'EIO' });
    }
  });
  try { assert.throws(() => k.updateMissionFeatures(source, { addFeatures: [{ id: 'foreign-after', milestoneId: 'm1' }] }), { code: 'EIO' }); }
  finally { setTransactionTestHook(undefined); }
  assert.equal(injected, true);
  const prepare = fs.readFileSync(path.join(source, '.mission/.txn/prepare.json'), 'utf8');
  const commit = fs.readFileSync(path.join(source, '.mission/.txn/commit.json'), 'utf8');
  for (const scenario of ['foreign', 'checksum', 'version']) {
    const dir = initialized('invalid-' + scenario), before = k.readMissionSnapshot(dir);
    const wal = JSON.parse(prepare), marker = JSON.parse(commit);
    if (scenario === 'checksum') wal.sha256 = '0'.repeat(64);
    if (scenario === 'version') wal.version = 9;
    fs.writeFileSync(path.join(dir, '.mission/.txn/prepare.json'), JSON.stringify(wal));
    fs.writeFileSync(path.join(dir, '.mission/.txn/commit.json'), JSON.stringify(marker));
    assert.throws(() => k.readMissionSnapshot(dir), { code: scenario === 'foreign' ? 'TX_FOREIGN_MISSION' : scenario === 'version' ? 'TX_WAL_VERSION' : 'TX_WAL_CORRUPT' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mission/state.json'), 'utf8')), before.state);
  }
  assert.equal(k.readMissionSnapshot(source).featuresDoc.features.some(row => row.id === 'foreign-after'), true);
});

test('WP3 HUD GET and SSE use a consistent snapshot without business reconciliation or writes', async () => {
  const http = (await import('node:http')).default;
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const { createMissionHudServer } = await import('../hud/server.mjs');
  const dir = initialized('hud-read'), snapshot = k.readMissionSnapshot(dir);
  const files = ['state.json', 'features.json', 'model-settings.json', 'progress_log.jsonl'];
  const saved = files.map(name => ({ name, bytes: fs.readFileSync(path.join(dir, '.mission', name), 'utf8'), mtime: fs.statSync(path.join(dir, '.mission', name)).mtimeMs }));
  const createServer = http.createServer; let handler;
  const server = new EventEmitter(); server.listening = false;
  server.listen = () => { server.listening = true; queueMicrotask(() => server.emit('listening')); return server; };
  server.close = callback => { server.listening = false; callback(); }; server.address = () => ({ port: 0 });
  http.createServer = callback => { handler = callback; return server; };
  let hud;
  try { hud = await createMissionHudServer({ missionDir: dir, dispatchAdapter: { runFeature: () => assert.fail('Read cannot dispatch') } }); }
  finally { http.createServer = createServer; }
  try {
    for (const url of ['/api/mission/state', '/api/mission/stream']) {
      const req = Readable.from([]); Object.assign(req, { method: 'GET', url, headers: { host: 'fixture.invalid' } });
      let body = '', status;
      const res = { writeHead(code) { status = code; }, setHeader() {}, write(text) { body += text; }, end(text = '') { body += text; } };
      await handler(req, res); assert.equal(status, 200);
      if (url.endsWith('/state')) assert.deepEqual(JSON.parse(body).state, snapshot.state);
      else { assert.match(body, /event: mission_snapshot/); assert.match(body, /"revision":2/); req.emit('close'); }
    }
    assert.deepEqual(hud.getSnapshot().state, snapshot.state);
  } finally { await hud.close(); }
  for (const item of saved) { assert.equal(fs.readFileSync(path.join(dir, '.mission', item.name), 'utf8'), item.bytes); assert.equal(fs.statSync(path.join(dir, '.mission', item.name)).mtimeMs, item.mtime); }
});

test('WP3 HUD rejected runtime actions report the committed gate and command retries cannot repeat effects', async t => {
  const http = (await import('node:http')).default;
  const { Readable } = await import('node:stream');
  const { createMissionHudServer } = await import('../hud/server.mjs');
  for (const action of ['pause', 'approve']) {
    const dir = initialized('hud-refused-' + action), state = k.loadState(dir);
    state.autopilot = false; k.saveState(dir, state);
    if (action === 'pause') { sync('start', dir); sync('bind', dir, { payload: binding(k.loadState(dir)) }); }
    else k.rejectMissionPlan(dir, 'Return to planning');
    let calls = 0;
    const refuse = async () => { assert.equal(hasActiveMissionTransaction(), false); calls++; return { accepted: false, error: 'Owned fixture runtime refusal' }; };
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function () { queueMicrotask(() => this.emit('listening')); return this; };
    let hud;
    try { hud = await createMissionHudServer({ missionDir: dir, dispatchAdapter: action === 'pause' ? { pauseWorker: refuse } : { startMissionRun: refuse } }); }
    finally { http.Server.prototype.listen = listen; }
    const post = () => new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ commandId: 'hud-once-' + action }))]);
      Object.assign(req, { method: 'POST', url: '/api/mission/' + action, headers: { host: 'fixture.invalid', 'content-type': 'application/json' } });
      const res = { writeHead(status) { assert.equal(hasActiveMissionTransaction(), false, 'HTTP response follows durable commit and unlock'); this.status = status; }, setHeader() {}, end(bytes) { try { resolve({ status: this.status, body: JSON.parse(bytes) }); } catch (error) { reject(error); } } };
      hud.server.emit('request', req, res);
    });
    try {
      const first = await post(); assert.equal(first.status, 409); assert.equal(calls, 1);
      assert.deepEqual(first.body.state, k.loadState(dir));
      assert.equal(first.body.state.status, action === 'pause' ? 'paused' : 'running');
      const before = k.readMissionSnapshot(dir);
      assert.deepEqual(await post(), first); assert.equal(calls, 1);
      assert.deepEqual(k.readMissionSnapshot(dir), before);
    } finally { await hud.close(); }
  }
});

test('WP3 legacy CLI preflight cannot reauthorize a rejected current gate', () => {
  const dir = initialized('cli-preflight'); sync('start', dir);
  const approved = k.loadState(dir), feature = k.loadFeaturesDoc(dir).features[0];
  sync('gate', dir, { kind: 'reject' });
  const before = k.readMissionSnapshot(dir), paths = k.getMissionPaths(dir);
  const payload = { missionId: approved.missionId, runId: approved.activeWorker.runId, feature, slotConfig: approved.activeWorker,
    dispatchPreflight: { state: approved, features: [feature], base: Object.fromEntries(['statePath', 'featuresPath', 'modelSettingsPath', 'progressLogPath'].map(key => [key, transactionHash(fs.readFileSync(paths[key]))])) } };
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('T3_') && !name.startsWith('ACP_') && name !== 'NODE_OPTIONS'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bridge/cli.mjs', import.meta.url)), 'DispatchWorkerRuntime', '--mission-dir', dir, '--json', JSON.stringify(payload)], { encoding: 'utf8', env });
  fs.writeFileSync(path.join(dir, 'cli.stdout.log'), r.stdout ?? ''); fs.writeFileSync(path.join(dir, 'cli.stderr.log'), r.stderr ?? '');
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.accepted, false); assert.equal(result.code, 'MISSION_NOT_DISPATCHABLE');
  assert.deepEqual(k.readMissionSnapshot(dir), before);
});
