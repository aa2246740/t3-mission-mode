import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as k from '../../kernel/index.mjs';
import {applyAutopilotCommand} from '../../kernel/autopilot-commands.mjs';
import {tick, fixture, ledger, recordCount, observe, fresh, timerReceipt, terminalObservation, envelope} from './a13-fixture.mjs';
const [op, dir, raw = '{}'] = process.argv.slice(2), input = JSON.parse(raw);
let result;
if (op === 'tick') result = await tick(dir, input.observations ?? []);
else if (op === 'stall') {
  const phase = {handoff: 'handoff', incomplete_work: 'partial', integrate: 'integration', result_unparseable: 'scrutiny'}[input.kind];
  const d = fixture(phase);
  try {
    let initial;
    if (input.kind === 'result_unparseable') {
      const state = k.loadState(d), status = structuredClone(ledger(d).runs[state.activeWorker.runId].lastStatus);
      delete status.content; delete status.structuredContent; delete status.observationId;
      status.latestTerminalRunId = 'unconfirmed-other-turn';
      initial = await tick(d, [{type: 'task_status', featureId: state.activeWorker.featureId, runId: state.activeWorker.runId, taskId: status.taskId, response: status}]);
    }
    const count = recordCount(d), sessions = k.loadState(d).sessions.length, actions = [];
    for (let i = 1; i <= input.count; i++) {
      let observations = [];
      if (i === 2 && input.change !== 'none') {
        if (input.change === 'observation') {
          const state = k.loadState(d);
          observations = [{type: 'owner', response: {parentThreadId: state.ownerThreadId, note: 'new independent observation'}}];
        } else if (input.change === 'approval') { k.rejectMissionPlan(d, 'Explicit new approval'); k.approveMissionPlan(d); }
        else k.updateMissionFeatures(d, {modelSettings: {worker: {providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: {reasoningEffort: 'high'}}}});
      }
      const action = i === 1 && initial ? initial : fresh(d, 'tick', {observations}).result;
      actions.push(action);
      const effectiveCount = input.change === 'none' || i === 1 ? i : i - 1;
      if (effectiveCount < 3) {
        assert.equal(action.type, 'orchestrator_decision'); assert.equal(action.kind, input.kind);
        assert.equal(ledger(d).timer.phase, 'confirmed');
      } else if (ledger(d).timer.phase === 'disable_requested') {
        assert.equal(action.type, 'disable_timer');
        assert.deepEqual(action.updateScheduledTask, {scheduledTaskId: ledger(d).timer.scheduledTaskId, enabled: false});
        assert.equal(action.nextAction.gate, 'STALLED_DECISION');
        const wait = fresh(d, 'tick', {observations: [timerReceipt(action, false)]}).result;
        actions.push(wait);
        assert.equal(wait.type, 'wait_user'); assert.equal(wait.gate, 'STALLED_DECISION');
        assert.equal(wait.originalDecision.kind, input.kind);
      } else { assert.equal(action.type, 'wait_user'); assert.equal(action.gate, 'STALLED_DECISION'); }
      assert.equal(recordCount(d), count); assert.equal(k.loadState(d).sessions.length, sessions);
    }
    result = {actions, dispatches: recordCount(d) - count, timerPhase: ledger(d).timer.phase};
  } finally { fs.rmSync(d, {recursive: true, force: true}); }
} else if (op === 'pause') result = applyAutopilotCommand(dir, input.command);
else throw new Error('Unknown A13 fixture operation ' + op);
console.log(JSON.stringify({result}));
