import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as k from '../kernel/index.mjs';
import {createHandlerHud} from './hud-handler-fixture.mjs';
import {fixture, fresh, ledger, recordCount, observe, timerReceipt, envelope, terminalObservation, evidence, verifyProvenance} from './fixtures/a13-fixture.mjs';

const timerId = 'scheduled-task:command:mcp:fe6eecc6-8fad-4c0a-9dcf-871d2ab1165f:schedule-task:mission-timer%3Aa11-toy-calc';
const owned = (t, phase = 'scrutiny', policy) => {
  const dir = fixture(phase, policy);
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const tick = (dir, observations = []) => fresh(dir, 'tick', {observations}).result;
const noNewExecution = (dir, count, runId) => {
  assert.equal(recordCount(dir), count);
  assert.equal(ledger(dir).runs[runId].integration, undefined);
  assert.equal(ledger(dir).runs[runId].consumed, undefined);
  assert.equal(k.loadFeaturesDoc(dir).features.find(row => row.runId === runId)?.integration, undefined);
};
const sameTimer = (action, id, enabled) => {
  assert.equal(action.type, enabled ? 'ensure_timer' : 'disable_timer');
  assert.equal(id, timerId);
  assert.equal(action.scheduledTaskId, timerId);
  assert.deepEqual(action.updateScheduledTask, {scheduledTaskId: id, enabled});
  assert.equal(action.scheduleTask, undefined);
};
const report = (runId, reason = 'Unknown dirty checkout remains unresolved') => ({type: 'integration', featureId: 'F2', runId,
  response: {blocked: true, reason, dirtyFiles: ['README.md', 'src/cli.mjs', 'test/cli.test.mjs']}});

for (const sequence of [['A'], ['A', 'A'], ['A', 'A', 'A'], ['B', 'A', 'B', 'A'], ['A', 'retry', 'A'], ['B', 'retry', 'A', 'retry', 'B']])
test(`A14 R12-01 blocked report sequence ${sequence.join('/')}`, t => {
  const dir = owned(t, 'integration'), count = recordCount(dir), start = tick(dir), runId = start.context.runId;
  const id = ledger(dir).timer.scheduledTaskId;
  const actions = [];
  let action = tick(dir, [report(runId)]); actions.push(action);
  sameTimer(action, id, false);
  action = tick(dir, [timerReceipt(action, false)]); actions.push(action);
  assert.equal(action.gate, 'INTEGRATION_BLOCKED');
  for (const item of sequence) {
    action = tick(dir, item === 'retry' ? [] : [report(runId, item === 'A' ? 'Unknown dirty checkout remains unresolved' : 'Rechecked: dirty files still need user cleanup')]);
    actions.push(action);
    if (item === 'retry') {
      sameTimer(action, id, true); assert.equal(ledger(dir).timer.phase, 'requested');
      action = tick(dir, [timerReceipt(action, true)]); actions.push(action);
      assert.equal(action.type, 'orchestrator_decision'); assert.equal(action.kind, 'integrate');
      assert.equal(ledger(dir).timer.phase, 'confirmed');
    } else {
      if (action.type === 'disable_timer') {
        sameTimer(action, id, false);
        action = tick(dir, [timerReceipt(action, false)]); actions.push(action);
      }
      assert.equal(action.type, 'wait_user'); assert.equal(action.gate, 'INTEGRATION_BLOCKED');
      assert.equal(action.message, item === 'A' ? 'Unknown dirty checkout remains unresolved' : 'Rechecked: dirty files still need user cleanup');
      assert.equal(ledger(dir).timer.phase, 'disabled');
    }
    noNewExecution(dir, count, runId);
  }
  // The owner has now cleaned the checkout. Only its explicit retry grants another Git check.
  if (ledger(dir).timer.phase === 'disabled') {
    action = tick(dir); sameTimer(action, id, true);
    action = tick(dir, [timerReceipt(action, true)]);
    assert.equal(action.kind, 'integrate');
  }
  noNewExecution(dir, count, runId);
  evidence(`a14-blocked-${sequence.join('-')}`, {actions, timer: ledger(dir).timer, dispatches: 0, integrated: false});
});

test('A14 R12-01 fresh blocked report wins over stalled-decision timer recovery', t => {
  const dir = owned(t, 'integration'), runId = k.loadState(dir).activeWorker.runId, count = recordCount(dir);
  tick(dir); tick(dir); const stop = tick(dir);
  assert.equal(tick(dir, [timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  const next = tick(dir, [report(runId)]);
  assert.equal(next.type, 'wait_user'); assert.equal(next.gate, 'INTEGRATION_BLOCKED');
  assert.equal(ledger(dir).timer.phase, 'disabled'); noNewExecution(dir, count, runId);
});

function startControl(t, kind, policy) {
  if (kind === 'interrupt') return startInterrupt(t, policy);
  if (kind === 'bound-resume') {
    const x = startInterrupt(t, policy);
    assert.equal(tick(x.dir, [observe('interrupt', x.control, {threadId: x.control.threadId, interrupted: true})]).gate, 'pause');
    fresh(x.dir, 'pause', {command: 'resume'});
    x.control = tick(x.dir); assert.equal(x.control.type, 'resume_worker');
    return x;
  }
  const dir = owned(t, 'scrutiny', policy);
  const count = recordCount(dir), runId = k.loadState(dir).activeWorker.runId;
  let control;
  if (kind === 'resume') {
    const invalid = envelope(ledger(dir).runs[runId].lastStatus.summary);
    assert.equal(invalid.assertionResults['VAL-007'], 'partial');
    control = tick(dir); assert.equal(control.type, 'resume_worker');
  }
  return {dir, count, runId, control};
}
function startInterrupt(t, policy) {
  const dir = owned(t, 'scrutiny', policy), count = recordCount(dir), correction = tick(dir), runId = correction.runId;
  assert.equal(tick(dir, [observe('resume', correction, {threadId: correction.threadId, sent: true})]).type, 'poll');
  fresh(dir, 'pause', {command: 'pause'});
  const control = tick(dir); assert.equal(control.type, 'interrupt_worker');
  return {dir, count, runId, control};
}
for (const kind of ['resume', 'interrupt', 'bound-resume']) for (const threshold of [1, 3])
test(`A14 R12-02 ${kind} unknown threshold=${threshold} stops once and recovers the original control`, t => {
  const {dir, count, runId, control} = startControl(t, kind, {maxStalledDecisionRepeats: threshold});
  const id = ledger(dir).timer.scheduledTaskId, claim = structuredClone(ledger(dir).runs[runId].pause), actions = [];
  for (let i = 1; i <= threshold; i++) {
    const action = tick(dir); actions.push(action);
    if (i < threshold) {
      assert.equal(action.type, 'wait_user');
      assert.equal(action.reason, kind === 'interrupt' ? 'INTERRUPT_OUTCOME_UNKNOWN' : 'WORKER_CONTROL_OUTCOME_UNKNOWN');
      assert.equal(ledger(dir).timer.phase, 'confirmed');
    } else {
      sameTimer(action, id, false); assert.equal(ledger(dir).timer.phase, 'disable_requested');
      assert.equal(action.nextAction.gate, 'STALLED_DECISION');
      assert.equal(action.nextAction.repeatCount, threshold);
    }
    assert.deepEqual(ledger(dir).runs[runId].pause, claim); noNewExecution(dir, count, runId);
  }
  const stop = actions.at(-1);
  for (let i = 0; i < 2; i++) {
    const action = tick(dir); actions.push(action);
    assert.equal(action.type, 'wait_user'); assert.equal(action.reason, 'TIMER_OUTCOME_UNKNOWN');
    assert.deepEqual(ledger(dir).runs[runId].pause, claim);
  }
  let action = tick(dir, [timerReceipt(stop, false)]); actions.push(action);
  assert.equal(action.gate, 'STALLED_DECISION'); assert.equal(ledger(dir).timer.phase, 'disabled');
  action = tick(dir); assert.equal(action.gate, 'STALLED_DECISION'); assert.equal(ledger(dir).decisionRepeat.count, threshold);
  const response = kind !== 'interrupt' ? {threadId: control.threadId, sent: true} : {threadId: control.threadId, interrupted: true};
  action = tick(dir, [observe(kind === 'interrupt' ? 'interrupt' : 'resume', control, response)]); actions.push(action);
  if (kind === 'interrupt') {
    assert.equal(action.gate, 'pause'); assert.equal(k.loadState(dir).status, 'paused');
    assert.equal(ledger(dir).timer.phase, 'disabled');
    fresh(dir, 'pause', {command: 'resume'});
    action = tick(dir); assert.equal(action.type, 'resume_worker');
    action = tick(dir, [observe('resume', action, {threadId: action.threadId, sent: true})]);
  }
  sameTimer(action, id, true);
  assert.equal(tick(dir, [timerReceipt(action, true)]).type, 'poll');
  assert.equal(ledger(dir).timer.phase, 'confirmed'); noNewExecution(dir, count, runId);
  evidence(`a14-unknown-${kind}-${threshold}`, {control, actions, timer: ledger(dir).timer, dispatches: 0});
});

for (const paused of [false, true]) for (const maximum of [1, 3]) test(`A14 R12-02 new observation restarts original timer without resending Resume paused=${paused} maximum=${maximum}`, t => {
  const {dir, count, runId, control} = startControl(t, 'resume', {maxStalledDecisionRepeats: maximum});
  for (let i = 1; i < maximum; i++) assert.equal(tick(dir).type, 'wait_user');
  const stop = tick(dir); assert.equal(stop.type, 'disable_timer');
  tick(dir, [timerReceipt(stop, false)]);
  if (paused) { fresh(dir, 'pause', {command: 'pause'}); assert.equal(tick(dir).type, 'wait_user'); }
  const input = [{type: 'owner', response: {parentThreadId: k.loadState(dir).ownerThreadId, note: 'New explicit investigation evidence'}}];
  let action = tick(dir, input);
  if (paused) {
    assert.equal(action.type, 'wait_user'); assert.equal(ledger(dir).timer.phase, 'disabled');
    assert.equal(k.loadState(dir).status, 'paused'); fresh(dir, 'pause', {command: 'resume'});
    action = tick(dir);
  }
  sameTimer(action, stop.scheduledTaskId, true);
  const unknown = tick(dir, [timerReceipt(action, true)]);
  assert.equal(unknown.type, {1: 'disable_timer', 3: 'wait_user'}[maximum]);
  if (maximum === 3) assert.equal(unknown.reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN');
  else sameTimer(unknown, timerId, false);
  assert.equal(ledger(dir).runs[runId].pause.epoch, 'result-format-1');
  assert.equal(ledger(dir).runs[runId].resultFormatRetries, 1); noNewExecution(dir, count, runId);
  assert.equal(control.controlId, `${runId}:result-format-1:resume`);
});

test('A14 R12-02 refused original control also stops and accepts a later confirmed receipt', t => {
  const {dir, count, runId, control} = startControl(t, 'resume');
  const refused = observe('resume', control, {threadId: control.threadId, accepted: false, code: 'REFUSED'});
  assert.equal(tick(dir, [refused]).reason, 'INVALID_WORKER_CONTROL_RECEIPT');
  assert.equal(tick(dir, [refused]).type, 'wait_user');
  const stop = tick(dir, [refused]); sameTimer(stop, ledger(dir).timer.scheduledTaskId, false);
  assert.equal(tick(dir, [timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  const enabled = tick(dir, [observe('resume', control, {threadId: control.threadId, sent: true})]);
  sameTimer(enabled, stop.scheduledTaskId, true); assert.equal(tick(dir, [timerReceipt(enabled, true)]).type, 'poll');
  noNewExecution(dir, count, runId);
});

test('A14 R12-02 HUD Pause control uses the same counter and never sends another child control', async t => {
  const dir = owned(t, 'scrutiny'); const correction = tick(dir);
  tick(dir, [observe('resume', correction, {threadId: correction.threadId, sent: true})]);
  const state = k.loadState(dir); state.autopilot = false; k.saveState(dir, state);
  let calls = 0;
  const hud = await createHandlerHud({missionDir: dir, runtimeAdapter: {pauseWorker: async () => {calls++; return {pending: true};}}});
  try { assert.equal((await hud.post('pause')).status, 409); } finally { await hud.close(); }
  assert.equal(calls, 1); assert.equal(k.loadState(dir).pauseControl.phase, 'unknown');
  const count = recordCount(dir), claim = structuredClone(k.loadState(dir).pauseControl);
  assert.equal(tick(dir).type, 'wait_user'); assert.equal(tick(dir).type, 'wait_user');
  const stop = tick(dir); sameTimer(stop, ledger(dir).timer.scheduledTaskId, false);
  assert.equal(tick(dir, [timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  assert.equal(tick(dir).gate, 'STALLED_DECISION'); assert.equal(ledger(dir).timer.phase, 'disabled');
  assert.deepEqual(k.loadState(dir).pauseControl, claim); assert.equal(calls, 1); assert.equal(recordCount(dir), count);
});

test('A14 RA1 VAL-007 fixture provenance is unchanged', verifyProvenance);

test('A14 R12-02 new terminal before original Resume confirmation remains bounded and unconsumed', t => {
  const {dir, count, runId, control} = startControl(t, 'resume');
  tick(dir); tick(dir); const stop = tick(dir);
  assert.equal(tick(dir, [timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  const invalid = envelope(ledger(dir).runs[runId].lastStatus.summary);
  const good = {...invalid, status: 'success', discoveredIssues: [], whatWasLeftUndone: [], failedAssertions: [], assertionResults: {...invalid.assertionResults, 'VAL-007': 'passed'}};
  const terminal = terminalObservation(dir, good, 1);
  let action = tick(dir, [terminal]); sameTimer(action, timerId, true);
  action = tick(dir, [timerReceipt(action, true)]); assert.equal(action.type, 'wait_user');
  action = tick(dir); assert.equal(action.type, 'wait_user');
  action = tick(dir); sameTimer(action, timerId, false);
  assert.equal(k.loadState(dir).assertions.find(row => row.id === 'VAL-007').stageResults?.scrutiny, undefined);
  assert.equal(ledger(dir).runs[runId].pause.phase, 'resume_requested');
  assert.equal(ledger(dir).runs[runId].resultFormatRetries, 1); noNewExecution(dir, count, runId);
  tick(dir, [timerReceipt(action, false)]);
  action = tick(dir, [observe('resume', control, {threadId: control.threadId, sent: true}), terminal]);
  sameTimer(action, timerId, true);
});

test('A14 R12-01 fresh blocked report precedes control-wait timer recovery', t => {
  const dir = owned(t, 'integration'), count = recordCount(dir), worker = k.loadState(dir).activeWorker;
  const invalid = envelope(ledger(dir).runs[worker.runId].lastStatus.summary); delete invalid.tests;
  const terminal = terminalObservation(dir, invalid, 0);
  terminal.response.childRunId = worker.childRunId; terminal.response.latestTerminalRunId = worker.childRunId;
  const control = tick(dir, [terminal]); assert.equal(control.type, 'resume_worker');
  tick(dir); tick(dir); const stop = tick(dir); sameTimer(stop, timerId, false);
  assert.equal(tick(dir, [timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  const claim = structuredClone(ledger(dir).runs[worker.runId].pause);
  for (let i = 0; i < 3; i++) {
    const action = tick(dir, [report(worker.runId)]);
    assert.equal(action.type, 'wait_user'); assert.equal(action.gate, 'INTEGRATION_BLOCKED');
    assert.equal(ledger(dir).timer.phase, 'disabled');
    assert.deepEqual(ledger(dir).runs[worker.runId].pause, claim); noNewExecution(dir, count, worker.runId);
  }
  const enable = tick(dir, [observe('resume', control, {threadId: control.threadId, sent: true})]);
  sameTimer(enable, timerId, true); noNewExecution(dir, count, worker.runId);
});
