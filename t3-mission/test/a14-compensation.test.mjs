import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as k from '../kernel/index.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
import {init, tick as baseTick} from './fixtures/a10-fixture.mjs';
import {fresh, ledger, recordCount, timerReceipt, evidence} from './fixtures/a13-fixture.mjs';

for (const mode of ['let_finish', 'interrupt']) test(`A14 unknown late-accepted compensation Pause stops without another control mode=${mode}`, async t => {
  const dir = init('a14-late-pause'); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const state = k.loadState(dir); state.pauseMode = mode; k.saveState(dir, state);
  const timer = await baseTick(dir); let calls = 0;
  await k.startMissionRun(dir, {}, {runFeature: async () => {
    applyAutopilotCommand(dir, 'pause');
    return {accepted: true, taskId: 'a14-original-task', childThreadId: 'a14-original-child', childRunId: 'a14-original-turn'};
  }, pauseWorker: async () => {calls++; return {pending: true};}});
  const count = recordCount(dir), runId = k.loadState(dir).activeWorker.runId;
  const tick = observations => fresh(dir, 'tick', {observations: observations ?? []}).result;
  const actions = [tick([{type: 'timer', requestId: timer.requestId, response: {taskId: 'a14-compensation-timer', enabled: true}}])];
  assert.equal(actions[0].type, 'wait_user'); assert.equal(actions[0].reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN');
  assert.equal(ledger(dir).timer.phase, 'confirmed');
  actions.push(tick()); assert.equal(actions[1].type, 'wait_user');
  actions.push(tick()); const stop = actions[2]; assert.equal(stop.type, 'disable_timer');
  assert.deepEqual(stop.updateScheduledTask, {scheduledTaskId: 'a14-compensation-timer', enabled: false});
  assert.equal(stop.nextAction.gate, 'STALLED_DECISION');
  assert.equal(tick().reason, 'TIMER_OUTCOME_UNKNOWN');
  assert.equal(tick([timerReceipt(stop, false)]).gate, 'STALLED_DECISION');
  assert.equal(tick().gate, 'STALLED_DECISION'); assert.equal(k.loadState(dir).status, 'paused');
  assert.equal(ledger(dir).timer.phase, 'disabled'); assert.equal(calls, 1);
  assert.equal(recordCount(dir), count); assert.equal(ledger(dir).runs[runId].pause.phase, 'interrupt_requested');
  // A genuine user Resume changes the revision, and does not replay the old compensation control.
  fresh(dir, 'pause', {command: 'resume'});
  const enable = tick(); assert.equal(enable.type, 'ensure_timer'); assert.equal(enable.scheduledTaskId, 'a14-compensation-timer');
  assert.equal(enable.scheduleTask, undefined);
  assert.equal(tick([timerReceipt(enable, true)]).reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN'); assert.equal(calls, 1); assert.equal(recordCount(dir), count);
  evidence(`a14-compensation-${mode}`, {actions, enable, calls, dispatches: 0});
});
