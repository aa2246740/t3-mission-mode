import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as k from '../kernel/index.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
import {readObservations} from '../kernel/autopilot-store.mjs';
import {dispatchRuntimeInvocation, dispatchWithIntent, inspectDispatchRecords} from '../kernel/dispatch-journal.mjs';
import {now, tick, observation, accepted, status, result, init, first, ledger, fenced, fresh, reapprove, finish, rejectedAttempts, rejectedHistory} from './fixtures/a10-fixture.mjs';

const kinds = ['success', 'failure', 'failed', 'cancelled', 'interrupted'];
const tuples = n => n === 0 ? [[]] : tuples(n - 1).flatMap(t => kinds.map(kind => [...t, kind]));
const permutations = values => values.length === 0 ? [[]] : values.flatMap((v, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [v, ...rest]));

for (const source of ['attempts', 'history']) for (const n of [1, 2, 3]) for (const outcomes of tuples(n))
  for (const order of permutations(Array.from({length: n}, (_, i) => i))) {
    test(`A10 ${source} ${outcomes.join('/')} terminal order ${order.join('/')}`, async () => {
      const d = init(source), attempts = await (source === 'attempts' ? rejectedAttempts(d, n) : rejectedHistory(d, n));
      for (const [i, a] of attempts.entries()) {
        a.worktreePath = d + '/original-worktree-' + i;
        fs.mkdirSync(a.worktreePath); fs.writeFileSync(a.worktreePath + '/retained.txt', 'original-' + i);
      }
      const sessions = JSON.stringify(k.loadState(d).sessions);
      await tick(d, attempts.map(a => observation(a, accepted(a))), now + 10000);
      reapprove(d);
      applyAutopilotCommand(d, 'pause'); applyAutopilotCommand(d, 'resume');
      for (const a of attempts) {
        const pending = await tick(d, [status(a, 'cancelled', {childRunId: 'obsolete-turn'}),
          status(a, 'completed', {workState: 'waiting_for_children', hasPendingChildRuns: true, pendingChildRuns: ['still-running']})], now + 10001);
        assert.notEqual(pending.type, 'dispatch');
      }
      assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
      fenced(d);
      let action;
      for (let j = 0; j < n; j++) {
        const i = order[j], a = attempts[i], outcome = outcomes[i];
        action = await tick(d, [['success', 'failure'].includes(outcome) ? result(a, outcome) : status(a, outcome)], now + 11000 + j);
        const resolutions = Object.values(ledger(d).dispatchResolutions ?? {});
        assert.equal(resolutions.length, j + 1);
        assert.equal(resolutions.find(row => row.intentId === a.intentId).terminalStatus, ['success', 'failure'].includes(outcome) ? 'completed' : outcome);
        assert.deepEqual(resolutions.find(row => row.intentId === a.intentId).response,
          (['success', 'failure'].includes(outcome) ? result(a, outcome) : status(a, outcome)).response);
        assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
        assert.equal(k.loadFeaturesDoc(d).features[0].acceptedSuccessRunId, undefined);
        assert.equal(ledger(d).lateResults, undefined);
        if (j + 1 < n) { assert.notEqual(action.type, 'dispatch'); fenced(d); }
      }
      assert.equal(action.type, 'dispatch');
      assert.equal(action.attempt, source === 'attempts' ? n + 1 : 2);
      assert.equal(JSON.stringify(k.loadState(d).sessions.slice(0, source === 'attempts' ? n : 1)), sessions);
      const log = fs.readFileSync(d + '/.mission/progress_log.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(log.filter(row => row.type === 'late_execution_resolved').length, n);
      for (const resolution of Object.values(ledger(d).dispatchResolutions)) {
        assert.deepEqual(log.find(row => row.type === 'late_execution_resolved' && row.details?.resolutionId === resolution.resolutionId).details, resolution);
      }
      await finish(d, action, now + 20000);
      for (const [i, a] of attempts.entries()) assert.equal(fs.readFileSync(a.worktreePath + '/retained.txt', 'utf8'), 'original-' + i);
    });
  }

for (const n of [1, 2, 3]) test(`A10 late success with exhausted ${n} attempt budget waits for the user`, async () => {
  const d = init('budget', n), attempts = await rejectedAttempts(d, n);
  await tick(d, attempts.map(a => observation(a, accepted(a))), now + 10000);
  fenced(d);
  const action = await tick(d, attempts.map(a => result(a)), now + 11000);
  assert.equal(action.type, 'wait_user'); assert.equal(action.reason, 'MAX_ATTEMPTS_EXCEEDED');
  assert.equal(Object.keys(ledger(d).dispatchResolutions).length, n);
  assert.equal(k.loadFeaturesDoc(d).features[0].status, 'pending');
});

test('A10 a valid runtime token and callback cannot bypass another unresolved late execution', async () => {
  const d = init('runtime'), a = await first(d);
  await tick(d, [observation(a, {accepted: false, code: 'PROVIDER_BUSY'})]);
  const b = await tick(d, [], now + 1000), record = inspectDispatchRecords(d).find(row => row.intent.runId === b.runId);
  await tick(d, [observation(a, accepted(a))], now + 1001);
  let calls = 0;
  await assert.rejects(() => dispatchRuntimeInvocation(d, {missionId: record.intent.missionId, runId: b.runId,
    feature: {...record.intent.feature, clientRequestId: b.intentId, invocationId: b.invocationId}, slotConfig: record.intent.target}, async () => {calls++;}, () => {}),
  {code: 'DISPATCH_LATE_EXECUTION_EVIDENCE'});
  await assert.rejects(() => dispatchWithIntent(d, record.intent, () => {calls++;}));
  assert.equal(calls, 0);
  assert.equal(inspectDispatchRecords(d).find(row => row.intent.runId === b.runId).invocations[0].runtimeClaimed, undefined);
  assert.equal(fresh(d, 'tick', {now: now + 1002}).result.action.type, 'poll');
});

test('A10 an obsolete latestTerminalRunId cannot settle the current original child', async () => {
  const d = init('old-terminal'), [a] = await rejectedAttempts(d, 1);
  await tick(d, [observation(a, accepted(a))], now + 1000);
  const pending = await tick(d, [status(a, 'completed', {latestTerminalRunId: 'obsolete-turn', latestTerminalStatus: 'completed', latestTerminalSummary: result(a).response.summary})], now + 1001);
  assert.equal(pending.type, 'poll'); assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
  fenced(d);
  const next = await tick(d, [result(a)], now + 1002);
  assert.equal(next.type, 'dispatch');
  await finish(d, next, now + 2000);
});

test('A10 late status without an ACK fences every entry until original-owner recovery', async () => {
  const d = init('status-before-ack'), [a] = await rejectedAttempts(d, 1);
  const action = await tick(d, [status(a, 'running')], now + 1000);
  assert.equal(action.type, 'recover_dispatch'); fenced(d);
  const recovered = await tick(d, [observation(a, {threads: [{...accepted(a), parentThreadId: 'owner', clientRequestId: a.intentId}]}, 'children')], now + 1001);
  assert.equal(recovered.type, 'poll');
  const next = await tick(d, [status(a, 'cancelled')], now + 1002);
  assert.equal(next.type, 'dispatch'); await finish(d, next, now + 2000);
});

test('A10 historical-key conflicts use the same checked manual resolution', async () => {
  const d = init('history-conflict'), [a] = await rejectedHistory(d, 1);
  await tick(d, [observation(a, accepted(a)), observation(a, {accepted: true, taskId: 'other-task', childThreadId: 'other-thread', childRunId: 'other-turn'})], now + 1000);
  fenced(d);
  const other = {...status(a, 'failed'), taskId: 'other-task', response: {...status(a, 'failed').response, taskId: 'other-task', childThreadId: 'other-thread', childRunId: 'other-turn'}};
  await tick(d, [status(a, 'cancelled'), other], now + 1001);
  const ids = readObservations(d).filter(row => row.observation.type === 'task_status').map(row => row.id);
  const res = k.resolveDispatchEvidence(d, {intentId: a.intentId, userConfirmed: true, reason: 'All current original executions stopped; select the audit record.',
    terminalObservationIds: ids, selectedTaskId: accepted(a).taskId, selectedChildThreadId: accepted(a).childThreadId});
  assert.ok(res.resolutionId);
  const audit = fs.readFileSync(d + '/.mission/progress_log.jsonl', 'utf8').trim().split('\n').map(JSON.parse).find(row => row.details?.resolutionId === res.resolutionId);
  assert.deepEqual(audit.details, ledger(d).dispatchResolutions[res.resolutionId]);
  assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
  const next = await tick(d, [], now + 2000); assert.equal(next.type, 'dispatch');
  await finish(d, next, now + 3000);
});

test('A10 late failure after normal success preserves completed feature ownership', async () => {
  const d = init('completed-late'), [a, b] = await rejectedAttempts(d, 2);
  await tick(d, [observation(a, accepted(a))], now + 10000);
  const c = await tick(d, [result(a)], now + 10001);
  assert.equal(c.type, 'dispatch'); assert.equal(c.attempt, 3);
  await tick(d, [observation(c, accepted(c))], now + 10002);
  const integration = await tick(d, [result(c)], now + 10003); assert.equal(integration.kind, 'integrate');
  const validator = await tick(d, [observation(c, {branch: 'main', sourceBranch: 'feature/original', commit: 'abcdef1234567', mergeSha: 'abcdef1234567'}, 'integration')], now + 10004);
  assert.equal(validator.type, 'dispatch');
  const completed = JSON.stringify(k.loadFeaturesDoc(d).features[0]);
  assert.equal(k.loadFeaturesDoc(d).features[0].status, 'completed');
  assert.equal((await tick(d, [observation(b, accepted(b))], now + 10005)).type, 'poll');
  const action = await tick(d, [result(b, 'failure')], now + 10006);
  assert.equal(action.type, 'recover_dispatch'); assert.equal(action.runId, validator.runId);
  assert.equal(JSON.stringify(k.loadFeaturesDoc(d).features[0]), completed);
  assert.equal(Object.values(ledger(d).dispatchResolutions).find(row => row.runId === b.runId).result.envelope.status, 'failure');
  await finish(d, validator, now + 20000);
  assert.equal(k.loadFeaturesDoc(d).features[0].attempts, 3);
});
