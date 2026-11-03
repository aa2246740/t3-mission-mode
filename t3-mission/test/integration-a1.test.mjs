import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as k from '../kernel/index.mjs';
import { createMissionHudServer } from '../hud/server.mjs';
import { bounded, createHandlerHud, saveContractEvidence } from './hud-handler-fixture.mjs';
import { hasActiveMissionTransaction } from '../kernel/mission-transaction.mjs';
import { inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';

const receipt = { accepted: true, taskId: 'a1-task', childThreadId: 'a1-thread', childRunId: 'a1-turn', runtimeTransport: 't3-delegate-task' };
async function fixture(t, bound = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-a1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.mission/\n');
  execFileSync('git', ['-C', dir, 'add', '.gitignore']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'fixture']);
  k.proposeMission(dir, { repoPath: dir, title: 'A1 private fixture', features: [{ id: 'm2-material-test-gaps', title: 'M2 material test gaps', milestoneId: 'm2' }],
    milestones: [{ id: 'm2' }], modelSettings: { skipScrutiny: true, skipUserTesting: true } });
  k.approveMissionPlan(dir);
  await k.startMissionRun(dir, {}, bound ? { runFeature: async () => receipt } : {});
  return dir;
}
const bytes = dir => Object.fromEntries(['statePath', 'featuresPath', 'modelSettingsPath', 'progressLogPath'].map(key => [key, fs.readFileSync(k.getMissionPaths(dir)[key], 'utf8')]));
function pause(dir) {
  const state = k.loadState(dir); state.status = 'paused'; state.pausedAt = '2026-10-23T00:00:00.000Z'; state.revision++;
  state.activeWorker.status = 'paused'; state.sessions[0].status = 'paused'; k.saveState(dir, state);
}
function finish(dir, worker) {
  k.endFeatureRun(dir, { runId: worker.runId, featureId: worker.featureId, successState: 'success', validatorsPassed: true,
    handoff: { whatWasImplemented: 'The original private fixture completed its feature and verified the final result without creating any external task or starting a local worker daemon.' } });
}

test('A1 VAL-HUD-004 handler keeps the full worker pause message after the Mission pause log', async t => {
  const dir = await fixture(t);
  const state = k.loadState(dir); state.activeWorker.workerNumber = 28; state.sessions[0].workerNumber = 28; k.saveState(dir, state);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const hud = await createHandlerHud({ missionDir: dir, dispatchAdapter: {
    pauseWorker: async () => { assert.equal(hasActiveMissionTransaction(), false); enter(); await gate; return { paused: true }; },
    resumeWorker: async () => ({ resumed: true }),
  } });
  let pending;
  try {
    pending = hud.post('pause'); await bounded(entered);
    const during = k.readMissionSnapshot(dir);
    assert.equal(during.state.status, 'paused'); assert.equal(during.state.activeWorker.status, 'running');
    assert.equal(during.progressLog.some(row => row.type === 'worker_paused'), false);
    release(); assert.equal((await bounded(pending)).status, 200);
    assert.equal((await hud.post('pause')).status, 200);
    assert.equal((await hud.post('resume')).status, 200);
    const logs = k.readProgressLog(dir), messages = logs.map(row => row.message);
    saveContractEvidence('A1-worker-28-pause', { during, logs });
    const mission = messages.indexOf('Mission paused'), worker = messages.indexOf('Worker #28 paused M2 material test gaps');
    assert.ok(worker >= 0, 'Expected Worker #28 paused log entry');
    assert.ok(mission >= 0 && mission < worker, 'Expected Mission paused before Worker #28 paused');
    assert.ok(messages.indexOf('Mission resumed') > worker);
    assert.ok(messages.findIndex(message => message.startsWith('Run started: Resume')) > messages.indexOf('Mission resumed'));
    assert.equal(logs.filter(row => row.type === 'worker_paused').length, 1);
  } finally { release(); await pending?.catch(() => {}); await hud.close(); }
});

for (const action of ['pause', 'resume']) for (const hook of ['runtime', 'onCommand']) for (const outcome of ['confirmed', 'unconfirmed', 'rejected', 'throws', 'throws-state-code']) {
  test(`A1 ${action} ${hook} owner completion ${outcome} preserves owner bytes and error priority`, async t => {
    const dir = await fixture(t); if (action === 'resume') pause(dir);
    let committed, calls = 0;
    const invoke = async worker => {
      calls++; assert.equal(hasActiveMissionTransaction(), false); finish(dir, worker); committed = bytes(dir);
      if (outcome.startsWith('throws')) {
        const error = new Error('A1 hook failed after owner completion');
        if (outcome === 'throws-state-code') error.code = 'MISSION_STATE_CHANGED';
        throw error;
      }
      if (outcome === 'rejected') return { accepted: false };
      if (outcome === 'confirmed') return action === 'pause' ? { paused: true } : { resumed: true };
    };
    const hud = await createHandlerHud({ missionDir: dir,
      ...(hook === 'onCommand' ? { onCommand: async event => {
        assert.equal(event.type, action); return invoke(k.loadState(dir).activeWorker);
      } } : {}),
      dispatchAdapter: hook === 'runtime' ? { [action === 'pause' ? 'pauseWorker' : 'resumeWorker']: invoke } : {},
    });
    try {
      const response = await bounded(hud.post(action));
      saveContractEvidence(`A1-${action}-${hook}-${outcome}`, { response, committed, after: bytes(dir), calls });
      assert.equal(response.status, outcome.startsWith('throws') ? 500 : 409);
      assert.equal(calls, 1); assert.equal(k.loadState(dir).status, 'completed');
      assert.equal(k.loadState(dir).activeWorker, null); assert.deepEqual(bytes(dir), committed);
    } finally { await hud.close(); }
  });
}

for (const adapter of ['missing', 'rejects', 'throws', 'accepts']) test(`A1 V03 pending Resume lifts the gate without external control: ${adapter}`, async t => {
  const dir = await fixture(t, false); pause(dir);
  const before = k.loadState(dir), records = inspectDispatchRecords(dir); let calls = 0;
  const invoke = async () => { calls++; if (adapter === 'throws') throw new Error('No external control allowed'); return adapter === 'accepts' ? receipt : { accepted: false }; };
  const hud = await createHandlerHud({ missionDir: dir, dispatchAdapter: adapter === 'missing' ? {} : { runFeature: invoke, resumeWorker: invoke, startMissionRun: invoke } });
  try {
    const response = await bounded(hud.post('resume'));
    saveContractEvidence('A1-V03-' + adapter, { response, calls, before, after: k.loadState(dir) });
    assert.equal(response.status, 200); assert.equal(calls, 0); assert.equal(response.body.trigger, '[resume the mission]');
    const state = k.loadState(dir);
    assert.equal(state.status, 'running'); assert.equal(state.activeWorker.runId, before.activeWorker.runId);
    assert.equal(state.activeWorker.dispatchPending, true); assert.equal(state.activeWorker.resumePending, true);
    assert.equal(state.sessions.length, 1); assert.equal(k.loadFeaturesDoc(dir).features[0].attempts, 1);
    assert.deepEqual(inspectDispatchRecords(dir), records);
    let dispatched = 0;
    const started = await k.startMissionRun(dir, {}, { runFeature: async () => { dispatched++; return receipt; } });
    assert.equal(dispatched, 1); assert.equal(started.activeWorker.runId, before.activeWorker.runId);
    assert.equal(started.activeWorker.taskId, receipt.taskId);
  } finally { await hud.close(); }
});

test('A1 failed HUD startup closes its file watchers without opening a port', async t => {
  const dir = await fixture(t, false), originalWatch = fs.watch, originalListen = http.Server.prototype.listen;
  const watchers = [];
  fs.watch = function (...args) {
    const watcher = originalWatch.apply(this, args), row = { watcher, closed: false };
    watcher.on('close', () => { row.closed = true; }); watchers.push(row); return watcher;
  };
  http.Server.prototype.listen = function () { queueMicrotask(() => this.emit('error', Object.assign(new Error('A1 deliberate startup failure'), { code: 'A1_STARTUP_FAILURE' }))); return this; };
  try {
    await assert.rejects(async () => await createMissionHudServer({ missionDir: dir }), { code: 'A1_STARTUP_FAILURE' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(watchers.length, 2);
    assert.equal(watchers.filter(row => !row.closed).length, 0, 'Failed startup must release every fs.watch handle');
  } finally {
    fs.watch = originalWatch; http.Server.prototype.listen = originalListen;
    for (const { watcher } of watchers) watcher.close();
  }
});

for (const entry of ['kernel', 'HUD']) test(`A1 approval epoch and approval log recover as one durable transaction through ${entry}`, async t => {
  const { setTransactionTestHook } = await import('../kernel/mission-transaction.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-approval-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'Atomic approval', features: [] });
  const hud = entry === 'HUD' ? await createHandlerHud({ missionDir: dir }) : null;
  let fired = false;
  setTransactionTestHook(event => {
    if (!fired && event.role === 'projection:state.json' && event.operation === 'rename' && event.boundary === 'before') {
      fired = true; throw Object.assign(new Error('Injected A1 approval materialization EIO'), { code: 'EIO' });
    }
  });
  try {
    if (hud) assert.equal((await hud.post('approve')).status, 500);
    else assert.throws(() => k.approveMissionPlan(dir), { code: 'EIO' });
  } finally { setTransactionTestHook(); await hud?.close(); }
  assert.equal(fired, true);
  const module = new URL('../kernel/index.mjs', import.meta.url).href;
  const recovered = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import * as k from ${JSON.stringify(module)}; console.log(JSON.stringify(k.readMissionSnapshot(process.argv[1])))`, dir], { encoding: 'utf8' }));
  assert.equal(recovered.state.planAccepted, true); assert.equal(recovered.state.planApprovalEpoch, 1);
  assert.equal(recovered.progressLog.filter(row => row.type === 'plan_approved').length, 1);
  const before = bytes(dir); k.approveMissionPlan(dir); assert.deepEqual(bytes(dir), before);
  assert.equal(k.loadState(dir).planApprovalEpoch, 1);
});

test('A1 fallback invalidation, ledger update and new intent share the selection transaction', async t => {
  const { setTransactionTestHook, missionTransaction } = await import('../kernel/mission-transaction.mjs');
  const { readController, saveController } = await import('../kernel/autopilot-store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-fallback-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max' } };
  const fallback = { ...primary, providerInstanceId: 'old-fallback' };
  k.proposeMission(dir, { autopilot: true, title: 'Atomic fallback', ownerThreadId: 'fixture-owner', milestones: [{ id: 'm1' }],
    features: [{ id: 'f1', milestoneId: 'm1', target: primary }], modelSettings: { worker: primary }, fallbackTargets: { worker: [] } });
  k.approveMissionPlan(dir);
  missionTransaction(dir, () => {
    const state = k.loadState(dir), ledger = readController(dir, state.missionId);
    ledger.timer = { phase: 'confirmed', scheduledTaskId: 'fixture-timer' };
    ledger.features = { f1: { target: fallback, approvalEpoch: 1, providerErrors: 1, nextRetryAt: '2020-01-01T00:00:00.000Z', switches: [] } };
    ledger.consecutiveProviderErrors = 1; saveController(dir, ledger);
  });
  k.rejectMissionPlan(dir, 'Explicitly approve the current primary'); k.approveMissionPlan(dir);
  const batches = [];
  setTransactionTestHook(event => {
    if (event.role === 'wal-commit' && event.operation === 'rename' && event.boundary === 'before')
      batches.push(JSON.parse(fs.readFileSync(path.join(dir, '.mission/.txn/prepare.json'), 'utf8')).payload);
  });
  let result;
  try { result = await k.missionTick(dir); } finally { setTransactionTestHook(); }
  assert.equal(result.action.type, 'dispatch'); assert.deepEqual(result.action.delegateTask.target, primary);
  const invalidating = batches.filter(batch => batch.files.some(file => file.name === 'autopilot/controller.json' && JSON.parse(file.after).features.f1.invalidatedFallbacks?.length));
  assert.equal(invalidating.length, 1);
  const batch = invalidating[0];
  assert.ok(batch.files.some(file => /^dispatch-[a-f0-9]+\.json$/.test(file.name) && JSON.parse(file.after).intent.runId === result.action.runId));
  assert.ok(batch.files.some(file => file.name === 'state.json' && JSON.parse(file.after).activeWorker.runId === result.action.runId));
  assert.ok(batch.files.some(file => file.name === 'features.json' && JSON.parse(file.after).features[0].attempts === 1));
  saveContractEvidence('A1-fallback-selection-transaction', { batches, result });
});
