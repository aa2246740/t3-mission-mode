import test from 'node:test';
import assert from 'node:assert/strict';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords, dispatchRuntimeInvocation} from '../kernel/dispatch-journal.mjs';
import {readObservations} from '../kernel/autopilot-store.mjs';
import {init, first, tick, now, observation, accepted, status, result, ledger, fresh, reapprove} from './fixtures/a10-fixture.mjs';

const proofs = [
  {name: 'matching', stopped: true},
  {name: 'mismatching', stopped: false, extra: {latestTerminalRunId: 'obsolete-turn'}},
  // A10 also accepts a complete top-level terminal without a latest-terminal summary.
  {name: 'missing', stopped: true, omitLatest: true},
  {name: 'pending-child', stopped: false, extra: {hasPendingChildRuns: true, pendingChildRuns: [{taskId: 'pending-task', childRunId: 'pending-turn'}]}},
  {name: 'latest-running', stopped: false, newerRunning: true},
  {name: 'mismatching-without-summary', stopped: false, extra: {latestTerminalRunId: 'obsolete-turn'}, omitSummary: true},
  {name: 'missing-current-child', stopped: false, omitChild: true},
];

async function enterRuntime(d, action) {
  let calls = 0;
  if (action.type === 'dispatch') {
    const rec = inspectDispatchRecords(d).find(row => row.intent.runId === action.runId);
    await dispatchRuntimeInvocation(d, {missionId: rec.intent.missionId, runId: action.runId,
      feature: {...rec.intent.feature, clientRequestId: action.intentId, invocationId: action.invocationId}, slotConfig: rec.intent.target},
    async () => { calls++; return {accepted: true, taskId: 'next-task', childThreadId: 'next-thread'}; }, () => {});
  }
  return calls;
}

for (const proof of proofs) for (const mode of ['same-process', 'fresh-node']) {
  test(`A11 shared terminal proof ${proof.name} ${mode}`, async () => {
    const outcomes = [];
    for (const path of ['automatic', 'manual']) {
      const d = init('proof-' + path + '-' + proof.name), a = await first(d);
      await tick(d, [observation(a, {accepted: false, code: 'PROVIDER_BUSY'})]);
      const b = {...a, taskId: 'second-task', childThreadId: 'second-thread', childRunId: 'second-turn'};
      await tick(d, [observation(a, accepted(a)), ...(path === 'manual' ? [observation(b, accepted(b))] : [])], now + 1000);
      const ta = status(a, 'completed', {latestTerminalRunId: 'turn-1', latestTerminalStatus: 'completed',
        latestTerminalSummary: result(a).response.summary, ...proof.extra});
      if (proof.omitLatest) delete ta.response.latestTerminalRunId;
      if (proof.omitSummary) delete ta.response.latestTerminalSummary;
      if (proof.omitChild) delete ta.response.childRunId;
      const submit = observations => mode === 'fresh-node'
        ? fresh(d, 'tick', {observations, now: now + 1001}).result.action : tick(d, observations, now + 1001);
      let action = await submit([ta, ...(path === 'manual' ? [status(b, 'cancelled')] : []),
        ...(proof.newerRunning ? [status(a, 'running')] : [])]);
      let error;
      if (path === 'manual') {
        const ids = readObservations(d).filter(row => row.observation.type === 'task_status' && row.observation.response.status !== 'running').map(row => row.id);
        const input = {intentId: a.intentId, terminalObservationIds: ids, selectedTaskId: 'task-1', selectedChildThreadId: 'thread-1',
          userConfirmed: true, reason: 'Choose only after every current original execution has stopped.'};
        if (mode === 'fresh-node') {
          const resolved = fresh(d, 'resolve', input);
          if (!resolved.ok) error = resolved.code;
        } else {
          try { k.resolveDispatchEvidence(d, input); } catch (cause) { error = cause.code; }
        }
        assert.equal(error, proof.stopped ? undefined : 'DISPATCH_RESOLUTION_UNSETTLED');
        action = fresh(d, 'tick', {now: now + 2000}).result.action;
      }
      const current = ledger(d), gate = current.dispatchReconciliations[a.intentId];
      const resolutions = Object.values(current.dispatchResolutions ?? {});
      assert.equal(Boolean(gate.resolutionId), proof.stopped);
      assert.equal(resolutions.length, proof.stopped ? 1 : 0);
      assert.equal(action.type, proof.stopped ? 'dispatch' : path === 'manual' ? 'wait_user' : 'poll');
      assert.equal(await enterRuntime(d, action), proof.stopped ? 1 : 0);
      if (!proof.stopped) {
        const blocked = fresh(d, 'kernel');
        assert.deepEqual(blocked.calls, []);
        assert.equal(k.loadState(d).sessions.length, 1);
      } else assert.equal(action.attempt, 2);
      outcomes.push(Boolean(gate.resolutionId));
    }
    assert.deepEqual(outcomes, [proof.stopped, proof.stopped]);
  });
}

const owners = [
  {name: 'historical', owner: 'old', nextTask: 'current-task', resolutions: 1},
  {name: 'current', owner: 'current', nextTask: 'old-task', resolutions: 0},
  {name: 'unmatched', owner: 'none', nextTask: 'old-task', resolutions: 0, error: 'TASK_STATUS_OWNERSHIP_UNRESOLVED'},
  {name: 'ambiguous', owner: 'both', nextTask: 'shared-task', resolutions: 0, error: 'TASK_STATUS_OWNERSHIP_AMBIGUOUS'},
  {name: 'same-task-distinct-thread', owner: 'old', sharedTask: true, nextTask: 'shared-task', resolutions: 1},
  {name: 'explicit-intent-wins', owner: 'old', sameIdentity: true, tagged: true, nextTask: 'shared-task', resolutions: 1},
];

for (const row of owners) for (const mode of ['same-process', 'fresh-node']) {
  test(`A11 task_status ownership ${row.name} ${mode}`, async () => {
    const d = init('owner-' + row.name);
    let calls = 0;
    await assert.rejects(() => k.startMissionRun(d, {}, {runFeature: async () => {calls++; return {accepted: false, code: 'PROVIDER_BUSY'}; }}));
    const old = inspectDispatchRecords(d)[0];
    reapprove(d, 'replacement-model');
    const shared = row.owner === 'both' || row.sameIdentity;
    const currentTask = shared || row.sharedTask ? 'shared-task' : 'current-task';
    await k.startMissionRun(d, {}, {runFeature: async () => {calls++; return {accepted: true, taskId: currentTask,
      childThreadId: shared ? 'shared-thread' : 'current-thread', childRunId: 'current-turn'}; }});
    const a = {featureId: 'f1', runId: old.intent.runId, intentId: old.intent.clientRequestId,
      invocationId: old.invocations[0].invocationId, attempt: 1, taskId: shared || row.sharedTask ? 'shared-task' : 'old-task',
      childThreadId: shared ? 'shared-thread' : 'old-thread', childRunId: shared ? 'current-turn' : 'old-turn'};
    const late = await tick(d, [observation(a, accepted(a))], now + 1000);
    if (late.type === 'ensure_timer') await tick(d, [{type: 'timer', requestId: late.requestId, response: {taskId: 'timer', enabled: true}}]);
    const current = inspectDispatchRecords(d)[0];
    const owner = row.owner === 'current' ? {...a, ...current.receipt, intentId: current.intent.clientRequestId}
      : row.owner === 'none' ? {...a, taskId: 'unmatched-task', childThreadId: 'unmatched-thread'} : a;
    const input = status(owner, row.owner === 'current' ? 'running' : 'cancelled');
    if (!row.tagged) delete input.intentId;
    const before = ledger(d), archived = readObservations(d);
    let action, error;
    if (mode === 'fresh-node') {
      const reply = fresh(d, 'tick', {observations: [input], now: now + 1001});
      if (reply.ok) action = reply.result.action; else error = reply.code;
      assert.deepEqual(reply.calls, []);
    } else {
      try { action = await tick(d, [input], now + 1001); } catch (cause) { error = cause.code; }
    }
    assert.equal(error, row.error);
    if (action?.type === 'ensure_timer') {
      const observations = [{type: 'timer', requestId: action.requestId, response: {taskId: 'timer', enabled: true}}];
      action = mode === 'fresh-node' ? fresh(d, 'tick', {observations, now: now + 1001}).result.action : await tick(d, observations, now + 1001);
    }
    const after = ledger(d), run = after.runs[a.runId];
    assert.equal(run.statusError, undefined);
    if (row.owner === 'current') {
      assert.equal(run.lastStatus.taskId, 'current-task');
      assert.equal(run.lastStatus.status, 'running');
      assert.equal(after.observations[run.lastStatus.observationId].outcome, 'applied');
    } else assert.deepEqual(after.runs, before.runs);
    const resolutions = Object.values(after.dispatchResolutions ?? {});
    assert.equal(resolutions.length, row.resolutions);
    if (row.resolutions) {
      assert.equal(resolutions[0].intentId, a.intentId);
      assert.equal(resolutions[0].response.status, 'cancelled');
      assert.equal(resolutions[0].response.childThreadId, shared ? 'shared-thread' : 'old-thread');
    }
    if (row.error) assert.deepEqual(readObservations(d), archived);
    else { assert.equal(action.type, 'poll'); assert.equal(action.taskId, row.nextTask); }
    const next = fresh(d, 'tick', {now: now + 1002});
    assert.equal(next.ok, true);
    assert.equal(next.result.action.type, 'poll');
    assert.equal(next.result.action.taskId, row.nextTask);
    assert.deepEqual(next.calls, []);
    const bound = fresh(d, 'kernel');
    assert.deepEqual(bound.calls, []);
    assert.equal(calls, 2);
  });
}

test('A11 a previously unique untagged archive cannot block later intent-tagged reconciliation', async () => {
  const d = init('ownership-changed');
  let calls = 0;
  await assert.rejects(() => k.startMissionRun(d, {}, {runFeature: async () => {calls++; return {accepted: false, code: 'PROVIDER_BUSY'}; }}));
  const old = inspectDispatchRecords(d)[0];
  reapprove(d, 'replacement-model');
  await k.startMissionRun(d, {}, {runFeature: async () => {calls++; return {accepted: true,
    taskId: 'shared-task', childThreadId: 'shared-thread', childRunId: 'shared-turn'}; }});
  const current = inspectDispatchRecords(d)[0];
  const a = {featureId: 'f1', runId: old.intent.runId, intentId: current.intent.clientRequestId, attempt: 1, ...current.receipt};
  const running = status(a, 'running'); delete running.intentId;
  let action = await tick(d, [running], now + 1000);
  if (action.type === 'ensure_timer') action = await tick(d, [{type: 'timer', requestId: action.requestId, response: {taskId: 'timer', enabled: true}}]);
  const before = ledger(d).runs;
  const historical = {...a, intentId: old.intent.clientRequestId, invocationId: old.invocations[0].invocationId};
  const late = fresh(d, 'tick', {observations: [observation(historical, accepted(historical))], now: now + 1001});
  assert.equal(late.ok, true);
  assert.equal(late.result.action.type, 'poll');
  assert.equal(late.result.action.intentId, old.intent.clientRequestId);
  assert.deepEqual(late.calls, []);
  const terminal = fresh(d, 'tick', {observations: [status(historical, 'cancelled')], now: now + 1002});
  assert.equal(terminal.ok, true);
  assert.equal(terminal.result.action.type, 'sleep');
  const next = fresh(d, 'tick', {now: now + 1003});
  assert.equal(next.ok, true);
  assert.equal(next.result.action.type, 'poll');
  assert.equal(next.result.action.taskId, 'shared-task');
  assert.deepEqual(next.calls, []);
  const after = ledger(d);
  assert.deepEqual(after.runs, before);
  assert.equal(Object.values(after.dispatchResolutions).length, 1);
  assert.equal(Object.values(after.dispatchResolutions)[0].intentId, old.intent.clientRequestId);
  assert.equal(Object.values(after.dispatchResolutions)[0].response.status, 'cancelled');
  assert.equal(calls, 2);
});
