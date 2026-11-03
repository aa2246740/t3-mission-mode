import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as k from '../kernel/index.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
import {parseMissionResult} from '../kernel/mission-result.mjs';
import {buildDelegateTask} from '../kernel/mission-brief.mjs';
import {fixture, fresh, tick, ledger, recordCount, observe, timerReceipt, terminalObservation, envelope, verifyProvenance, journals, observations, evidence} from './fixtures/a13-fixture.mjs';

function owned(t, phase = 'scrutiny', policy) {
  const dir = fixture(phase, policy); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir;
}
test('A13 RA1 original receipts retain all 31 source hashes', verifyProvenance);
test('A13 RA1 F1 partial offers recovery linked to its real handoff and stops the timer', async t => {
  const dir = owned(t, 'partial'), count = recordCount(dir);
  let action = fresh(dir).result;
  assert.equal(action.kind, 'incomplete_work');
  assert.equal(action.context.items[0].id, 'F1:discovered_issue:0');
  assert.match(action.context.instruction, /UpdateMissionFeatures.*recover-and-finish.*resolvesHandoffItemIds/);
  assert.match(action.context.result.discoveredIssues[0], /Operation not permitted/);
  assert.equal(fresh(dir).result.kind, 'incomplete_work');
  action = fresh(dir).result; assert.equal(action.type, 'disable_timer');
  const wait = fresh(dir, 'tick', {observations: [timerReceipt(action, false)]}).result;
  assert.equal(wait.gate, 'STALLED_DECISION'); assert.equal(ledger(dir).timer.phase, 'disabled');
  assert.equal(recordCount(dir), count);
  k.updateMissionFeatures(dir, {updateFeatures: [{id: 'F1', kind: 'repair', title: 'Recover and finish F1', resolvesHandoffItemIds: ['F1:discovered_issue:0']}]});
  const enabled = fresh(dir).result;
  assert.equal(enabled.type, 'ensure_timer'); assert.equal(enabled.scheduleTask, undefined);
  assert.equal(enabled.updateScheduledTask.enabled, true); assert.equal(enabled.scheduledTaskId, action.scheduledTaskId);
  const repair = fresh(dir, 'tick', {observations: [timerReceipt(enabled, true)]}).result;
  assert.equal(repair.type, 'dispatch'); assert.equal(repair.featureId, 'F1'); assert.equal(repair.attempt, 2);
  assert.equal(k.loadState(dir).sessions[0].handoff.successState, 'partial');
});
test('A13 RA1 F2 reports unknown dirty files, waits, then retries integration with the same timer', async t => {
  const dir = owned(t, 'integration'), count = recordCount(dir), active = k.loadState(dir).activeWorker;
  assert.equal(fresh(dir).result.kind, 'integrate');
  const dirtyFiles = ['README.md', 'src/cli.mjs', 'test/cli.test.mjs'];
  const blocked = {type: 'integration', featureId: 'F2', runId: active.runId, response: {blocked: true, reason: 'Unknown uncommitted RA-1 files; preserve their content.', dirtyFiles}};
  const stop = fresh(dir, 'tick', {observations: [blocked]}).result;
  assert.equal(stop.type, 'disable_timer'); assert.equal(stop.nextAction.gate, 'INTEGRATION_BLOCKED');
  const wait = fresh(dir, 'tick', {observations: [timerReceipt(stop, false)]}).result;
  assert.equal(wait.type, 'wait_user'); assert.equal(wait.gate, 'INTEGRATION_BLOCKED'); assert.deepEqual(wait.dirtyFiles, dirtyFiles);
  assert.equal(ledger(dir).timer.phase, 'disabled'); assert.equal(recordCount(dir), count);
  const resume = fresh(dir).result;
  assert.equal(resume.type, 'ensure_timer'); assert.equal(resume.scheduledTaskId, stop.scheduledTaskId); assert.equal(resume.scheduleTask, undefined);
  const integrate = fresh(dir, 'tick', {observations: [timerReceipt(resume, true)]}).result;
  assert.equal(integrate.kind, 'integrate'); assert.equal(integrate.context.commit, '9e7d1aac987689609879a3025976c794d347432a');
  assert.equal(recordCount(dir), count);
});
test('A13 every orchestrator decision can stall, including integration_conflict', async t => {
  const dir = owned(t, 'integration'), state = k.loadState(dir), count = recordCount(dir);
  const conflict = {type: 'integration', featureId: 'F2', runId: state.activeWorker.runId, response: {
    branch: 'mission/toy-calc', sourceBranch: 't3/calc-cli-tests-readme', commit: '9e7d1aac987689609879a3025976c794d347432a', mergeSha: 'abcdef1234567'}};
  assert.equal(fresh(dir, 'tick', {observations: [conflict]}).result.kind, 'integration_conflict');
  assert.equal(fresh(dir).result.kind, 'integration_conflict');
  const stop = fresh(dir).result;
  assert.equal(stop.type, 'disable_timer'); assert.equal(stop.nextAction.originalDecision.kind, 'integration_conflict');
  assert.equal(fresh(dir, 'tick', {observations: [timerReceipt(stop, false)]}).result.gate, 'STALLED_DECISION');
  assert.equal(ledger(dir).timer.phase, 'disabled'); assert.equal(recordCount(dir), count);
});
test('A13 undefined decision fields survive durable comparison in fresh Node', async t => {
  const dir = owned(t), state = k.loadState(dir), count = recordCount(dir);
  const status = structuredClone(ledger(dir).runs[state.activeWorker.runId].lastStatus);
  for (const key of ['content', 'structuredContent', 'observationId', 'summary', 'latestTerminalSummary']) delete status[key];
  status.latestTerminalRunId = 'unconfirmed-old-turn';
  const missing = {type: 'task_status', featureId: state.activeWorker.featureId, runId: state.activeWorker.runId, taskId: status.taskId, response: status};
  const first = fresh(dir, 'tick', {observations: [missing]}).result;
  assert.equal(first.kind, 'result_unparseable'); assert.equal(first.context.reason, 'Task summary is missing');
  const second = fresh(dir).result; assert.equal(second.kind, 'result_unparseable');
  const stop = fresh(dir).result;
  evidence('stall-undefined-comparison', {first, second, third: stop, repeat: ledger(dir).decisionRepeat});
  assert.equal(stop.type, 'disable_timer'); assert.equal(stop.nextAction.repeatCount, 3);
  assert.equal(stop.nextAction.originalDecision.kind, 'result_unparseable');
  assert.equal(fresh(dir, 'tick', {observations: [timerReceipt(stop, false)]}).result.gate, 'STALLED_DECISION');
  assert.equal(ledger(dir).timer.phase, 'disabled'); assert.equal(recordCount(dir), count);
});

for (const kind of ['handoff', 'integrate', 'result_unparseable', 'incomplete_work'])
for (const count of [1, 2, 3, 4])
for (const change of ['none', 'observation', 'approval', 'update'])
test(`A13 stall ${kind} count=${count} change=${change}`, () => {
  const result = fresh('-', 'stall', {kind, count, change}).result;
  assert.equal(result.dispatches, 0);
  evidence(`stall-${kind}-${count}-${change}`, result);
});

for (const phase of ['handoff', 'partial', 'integration', 'scrutiny'])
for (const change of ['observation', 'approval', 'update']) test(`A13 stalled ${phase} recovers after ${change} using its original timer`, async t => {
  const dir = owned(t, phase), count = recordCount(dir);
  if (phase === 'scrutiny') {
    const state = k.loadState(dir), status = structuredClone(ledger(dir).runs[state.activeWorker.runId].lastStatus);
    delete status.content; delete status.structuredContent; delete status.observationId;
    status.latestTerminalRunId = 'unconfirmed-stale-turn';
    await tick(dir, [{type: 'task_status', featureId: state.activeWorker.featureId, runId: state.activeWorker.runId, taskId: status.taskId, response: status}]);
  } else await tick(dir);
  await tick(dir); const stop = fresh(dir).result; assert.equal(stop.type, 'disable_timer');
  assert.equal(fresh(dir, 'tick', {observations: [timerReceipt(stop, false)]}).result.gate, 'STALLED_DECISION');
  let observations = [];
  if (change === 'observation') observations = [{type: 'owner', response: {parentThreadId: k.loadState(dir).ownerThreadId, note: 'New state evidence after user intervention'}}];
  else if (change === 'approval') { k.rejectMissionPlan(dir, 'User requests a fresh approval'); k.approveMissionPlan(dir); }
  else k.updateMissionFeatures(dir, {modelSettings: {worker: {providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: {reasoningEffort: 'high'}}}});
  const enable = fresh(dir, 'tick', {observations}).result;
  assert.equal(enable.type, 'ensure_timer'); assert.equal(enable.scheduledTaskId, stop.scheduledTaskId); assert.equal(enable.scheduleTask, undefined);
  const action = fresh(dir, 'tick', {observations: [timerReceipt(enable, true)]}).result;
  assert.equal(action.type, 'orchestrator_decision');
  assert.equal(action.kind, {handoff: 'handoff', partial: 'incomplete_work', integration: 'integrate', scrutiny: 'result_unparseable'}[phase]);
  assert.equal(ledger(dir).decisionRepeat.count, 1); assert.equal(recordCount(dir), count);
  evidence(`recovery-${phase}-${change}`, {stop, enable, action, dispatches: 0});
});

for (const retries of [0, 1, 2, 3]) test(`A13 RA1 scrutiny correction retries=${retries}`, async t => {
  const dir = owned(t), count = recordCount(dir), start = k.loadState(dir), runId = start.activeWorker.runId;
  const originalSummary = ledger(dir).runs[runId].lastStatus.summary;
  const invalid = envelope(originalSummary);
  assert.equal(invalid.assertionResults['VAL-007'], 'partial');
  let action;
  if (retries === 0) {
    const corrected = {...invalid, status: 'success', discoveredIssues: [], whatWasLeftUndone: [], failedAssertions: [], assertionResults: {...invalid.assertionResults, 'VAL-007': 'passed'}};
    const observation = terminalObservation(dir, corrected, 0);
    observation.response.childRunId = start.activeWorker.childRunId;
    observation.response.latestTerminalRunId = start.activeWorker.childRunId;
    action = fresh(dir, 'tick', {observations: [observation]}).result;
  } else {
    action = fresh(dir).result;
    for (let attempt = 1; attempt <= Math.min(retries, 2); attempt++) {
      assert.equal(action.type, 'resume_worker'); assert.equal(action.threadId, start.activeWorker.childThreadId); assert.equal(action.runId, runId);
      assert.match(action.message, /VAL-007.*partial.*passed or failed/);
      assert.equal(action.delegateTask, undefined); assert.equal(action.clientRequestId, undefined);
      assert.equal(fresh(dir).result.reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN');
      assert.equal(recordCount(dir), count);
      const poll = fresh(dir, 'tick', {observations: [observe('resume', action, {threadId: action.threadId, accepted: true})]}).result;
      assert.equal(poll.type, 'poll'); assert.equal(poll.taskId, start.activeWorker.taskId);
      const old = observations.find(row => row.sequence === 13).observation;
      assert.equal(fresh(dir, 'tick', {observations: [old]}).result.type, 'sleep');
      const corrected = {...invalid, status: 'success', discoveredIssues: [], whatWasLeftUndone: [], failedAssertions: [], assertionResults: {...invalid.assertionResults, 'VAL-007': 'passed'}};
      action = fresh(dir, 'tick', {observations: [terminalObservation(dir, attempt === retries ? corrected : invalid, attempt)]}).result;
    }
  }
  if (retries <= 2) {
    assert.equal(action.type, 'dispatch'); assert.equal(action.featureId, 'user-testing-validator-M1');
    assert.equal(k.loadState(dir).assertions.find(row => row.id === 'VAL-007').stageResults.scrutiny, 'passed');
    assert.equal(k.loadState(dir).sessions.filter(row => row.runId === runId).length, 1);
    // Only the next planned validator is new; no correction dispatch exists.
    assert.equal(recordCount(dir), count + 1);
  } else {
    assert.equal(action.type, 'disable_timer'); assert.equal(action.nextAction.gate, 'RESULT_UNPARSEABLE');
    const wait = fresh(dir, 'tick', {observations: [timerReceipt(action, false)]}).result;
    assert.equal(wait.type, 'wait_user'); assert.equal(wait.gate, 'RESULT_UNPARSEABLE');
    assert.equal(fresh(dir).result.gate, 'RESULT_UNPARSEABLE'); assert.equal(ledger(dir).timer.phase, 'disabled');
    assert.equal(recordCount(dir), count);
  }
});

test('A13 pending correction Resume survives user Pause without overwriting its control identity', async t => {
  const dir = owned(t), count = recordCount(dir), correction = fresh(dir).result;
  assert.equal(correction.type, 'resume_worker');
  applyAutopilotCommand(dir, 'pause');
  assert.equal(fresh(dir).result.reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN');
  assert.equal(ledger(dir).runs[correction.runId].pause.epoch, 'result-format-1');
  const interrupt = fresh(dir, 'tick', {observations: [observe('resume', correction, {threadId: correction.threadId, sent: true})]}).result;
  assert.equal(interrupt.type, 'interrupt_worker');
  assert.equal(k.loadState(dir).status, 'paused');
  assert.equal(fresh(dir, 'tick', {observations: [observe('interrupt', interrupt, {threadId: interrupt.threadId, interrupted: true})]}).result.gate, 'pause');
  applyAutopilotCommand(dir, 'resume');
  const resume = fresh(dir).result;
  assert.equal(resume.type, 'resume_worker'); assert.equal(resume.threadId, correction.threadId);
  const refused = fresh(dir, 'tick', {observations: [observe('resume', resume, {threadId: resume.threadId, accepted: false, code: 'REFUSED'})]}).result;
  assert.equal(refused.type, 'wait_user'); assert.equal(ledger(dir).runs[resume.runId].pause.phase, 'resume_requested');
  assert.equal(recordCount(dir), count);
});
test('A13 new terminal during a correction needs the original Resume confirmation', async t => {
  const dir = owned(t), count = recordCount(dir), correction = fresh(dir).result;
  const invalid = envelope(ledger(dir).runs[correction.runId].lastStatus.summary);
  const corrected = {...invalid, status: 'success', discoveredIssues: [], whatWasLeftUndone: [], failedAssertions: [], assertionResults: {...invalid.assertionResults, 'VAL-007': 'passed'}};
  const terminal = terminalObservation(dir, corrected, 1);
  const unknown = fresh(dir, 'tick', {observations: [terminal]}).result;
  assert.equal(unknown.type, 'wait_user'); assert.equal(recordCount(dir), count);
  assert.equal(k.loadState(dir).assertions[6].stageResults?.scrutiny, undefined);
  const next = fresh(dir, 'tick', {observations: [observe('resume', correction, {threadId: correction.threadId, sent: true}), terminal]}).result;
  assert.equal(next.featureId, 'user-testing-validator-M1');
  assert.equal(k.loadState(dir).assertions[6].stageResults.scrutiny, 'passed');
});
for (const mode of ['interrupt', 'let_finish']) test(`A13 acknowledged correction survives ${mode} Pause and Resume`, async t => {
  const dir = owned(t), state = k.loadState(dir); state.pauseMode = mode; k.saveState(dir, state);
  const count = recordCount(dir), correction = fresh(dir).result;
  const invalid = envelope(ledger(dir).runs[correction.runId].lastStatus.summary);
  assert.equal(fresh(dir, 'tick', {observations: [observe('resume', correction, {threadId: correction.threadId, sent: true})]}).result.type, 'poll');
  applyAutopilotCommand(dir, 'pause');
  const paused = fresh(dir).result;
  if (mode === 'interrupt') {
    assert.equal(paused.type, 'interrupt_worker');
    assert.equal(fresh(dir, 'tick', {observations: [observe('interrupt', paused, {threadId: paused.threadId, interrupted: true})]}).result.gate, 'pause');
  } else assert.equal(paused.gate, 'pause');
  assert.equal(k.loadState(dir).status, 'paused'); assert.equal(recordCount(dir), count);
  applyAutopilotCommand(dir, 'resume');
  const resumed = fresh(dir).result;
  if (mode === 'interrupt') {
    assert.equal(resumed.type, 'resume_worker'); assert.equal(resumed.threadId, correction.threadId);
    assert.equal(fresh(dir).result.reason, 'WORKER_CONTROL_OUTCOME_UNKNOWN');
    assert.equal(fresh(dir, 'tick', {observations: [observe('resume', resumed, {threadId: resumed.threadId, sent: true})]}).result.type, 'poll');
  } else assert.equal(resumed.type, 'poll');
  assert.equal(recordCount(dir), count); assert.equal(ledger(dir).runs[correction.runId].resultFormatRetries, 1);
  const corrected = {...invalid, status: 'success', discoveredIssues: [], whatWasLeftUndone: [], failedAssertions: [], assertionResults: {...invalid.assertionResults, 'VAL-007': 'passed'}};
  const next = fresh(dir, 'tick', {observations: [terminalObservation(dir, corrected, 2)]}).result;
  assert.equal(next.featureId, 'user-testing-validator-M1');
  assert.equal(recordCount(dir), count + 1); assert.equal(k.loadState(dir).assertions[6].stageResults.scrutiny, 'passed');
});
for (const shape of ['missing-field', 'missing-fence', 'wrong-run']) test(`A13 worker malformed ${shape} resumes only its original run`, async t => {
  const dir = owned(t, 'integration'), state = k.loadState(dir), count = recordCount(dir), worker = state.activeWorker;
  const value = envelope(ledger(dir).runs[worker.runId].lastStatus.summary);
  const malformed = structuredClone(value);
  if (shape === 'missing-field') delete malformed.tests;
  if (shape === 'wrong-run') malformed.runId = 'wrong-run';
  const status = terminalObservation(dir, malformed, 0);
  status.response.childRunId = worker.childRunId; status.response.latestTerminalRunId = worker.childRunId;
  if (shape === 'missing-fence') status.response.latestTerminalSummary = 'Completed without the required result envelope.';
  const correction = fresh(dir, 'tick', {observations: [status]}).result;
  assert.equal(correction.type, 'resume_worker'); assert.equal(correction.threadId, worker.childThreadId); assert.equal(correction.runId, worker.runId);
  assert.equal(correction.delegateTask, undefined); assert.equal(correction.clientRequestId, undefined); assert.equal(recordCount(dir), count);
  const poll = fresh(dir, 'tick', {observations: [observe('resume', correction, {threadId: correction.threadId, sent: true})]}).result;
  assert.equal(poll.type, 'poll'); assert.equal(poll.taskId, worker.taskId);
  const integrate = fresh(dir, 'tick', {observations: [terminalObservation(dir, value, 1)]}).result;
  assert.equal(integrate.kind, 'integrate'); assert.equal(integrate.context.runId, worker.runId); assert.equal(recordCount(dir), count);
});
for (const maximum of [0, 1]) test(`A13 configured result format budget ${maximum} stops without a new dispatch`, async t => {
  const dir = owned(t, 'scrutiny', {maxResultFormatRetries: maximum}), count = recordCount(dir);
  let action = fresh(dir).result;
  if (maximum === 1) {
    assert.equal(action.type, 'resume_worker');
    const invalid = envelope(ledger(dir).runs[action.runId].lastStatus.summary);
    assert.equal(fresh(dir, 'tick', {observations: [observe('resume', action, {threadId: action.threadId, sent: true})]}).result.type, 'poll');
    action = fresh(dir, 'tick', {observations: [terminalObservation(dir, invalid, 1)]}).result;
  }
  assert.equal(action.type, 'disable_timer'); assert.equal(action.nextAction.gate, 'RESULT_UNPARSEABLE');
  assert.equal(fresh(dir, 'tick', {observations: [timerReceipt(action, false)]}).result.gate, 'RESULT_UNPARSEABLE');
  assert.equal(ledger(dir).timer.phase, 'disabled'); assert.equal(recordCount(dir), count);
});
test('A13 configured stall threshold and duplicate raw observations do not replenish the count', t => {
  const dir = owned(t, 'integration', {maxStalledDecisionRepeats: 2});
  const raw = observations.find(row => row.sequence === 10).observation;
  assert.equal(fresh(dir).result.kind, 'integrate');
  const stop = fresh(dir, 'tick', {observations: [raw]}).result;
  assert.equal(stop.type, 'disable_timer'); assert.equal(stop.nextAction.repeatCount, 2);
  assert.equal(recordCount(dir), 4);
});
test('A13 approved policy accepts both limits and rejects invalid budget values', t => {
  for (const retryPolicy of [{maxResultFormatRetries: -1}, {maxResultFormatRetries: 1.5}, {maxStalledDecisionRepeats: 0}, {maxStalledDecisionRepeats: 1.5}]) {
    const dir = owned(t, 'partial');
    assert.throws(() => k.proposeMission(dir, {title: 'Invalid retry policy', retryPolicy}), {code: 'INVALID_AUTOPILOT_POLICY'});
  }
  const dir = owned(t, 'partial');
  k.proposeMission(dir, {...k.loadState(dir), features: k.loadFeaturesDoc(dir).features, retryPolicy: {maxResultFormatRetries: 1, maxStalledDecisionRepeats: 4}});
  assert.deepEqual(k.loadState(dir).retryPolicy, {maxResultFormatRetries: 1, maxStalledDecisionRepeats: 4});
});
test('A13 worker and validator briefs constrain worktree writes, Git approval and stage assertions', t => {
  const dir = owned(t), state = k.loadState(dir);
  const worker = buildDelegateTask(state, journals[0].intent.feature, journals[0].intent).task;
  assert.match(worker, /only inside the worktree T3 created for you.*current working directory/);
  assert.match(worker, /main checkout.*read-only integration reference/);
  assert.match(worker, /git add and git commit.*own worktree/);
  assert.match(worker, /can and should request require_escalated.*specific local Git operation/);
  assert.match(worker, /exact refusal and return partial/);
  assert.doesNotMatch(worker, /Repository:/);
  const validator = buildDelegateTask(state, journals[4].intent.feature, journals[4].intent).task;
  assert.match(validator, /read-only.*Do not write to any directory/);
  assert.match(validator, /assertionResults values must be exactly "passed" or "failed"/);
  assert.match(validator, /independently available.*Do not depend on another stage's receipts/);
  assert.doesNotMatch(validator, /request require_escalated/);
});
test('A13 validator rejects illegal values even on undeclared assertion entries', t => {
  const dir = owned(t), worker = k.loadState(dir).activeWorker;
  const value = envelope(ledger(dir).runs[worker.runId].lastStatus.summary);
  value.assertionResults['VAL-007'] = 'passed'; value.failedAssertions = [];
  value.assertionResults.EXTRA = 'partial';
  assert.throws(() => parseMissionResult('```mission-result\n' + JSON.stringify(value) + '\n```', {feature: {id: worker.featureId, kind: 'scrutiny', milestoneId: 'M1'}, runId: worker.runId, assertions: k.loadState(dir).assertions}), /EXTRA.*partial.*passed or failed/);
});
