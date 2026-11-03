import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as k from '../kernel/index.mjs';
import * as schema from '../kernel/schema.mjs';
import { prepareDispatch, dispatchWithIntent, inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';
import { callT3McpTool, runFeature, delegateMissionTask } from '../bridge/t3-adapter.mjs';
import { runCli } from '../bridge/cli.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';

const child = { taskId: 'decision-task', childThreadId: 'decision-thread', childRunId: 'decision-child' };
const target = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max' } };
const now = 1793000000000;
const containers = { root: x => x, response: x => ({ response: x }), delegation: x => ({ delegation: x }), structured: x => ({ structuredContent: x }), content: x => ({ content: [{ type: 'text', text: JSON.stringify(x) }] }) };
// These are independent literal expectations, including effects and the next action.
const accepted = { outcome: 'ACCEPTED', phase: 'accepted', calls: 1, next: 'poll' };
const unknown = { outcome: 'UNKNOWN', phase: 'inflight', calls: 1, next: 'recover_dispatch' };
const refused = { outcome: 'NOT_ACCEPTED', phase: 'retryable', calls: 2, next: 'sleep', failure: 'provider_rejection' };
const conflict = { outcome: 'CONFLICT', phase: 'inflight', calls: 1, next: 'wait_user' };
const bodies = [
  ['empty', {}, unknown], ['null', null, unknown], ['accepted', child, accepted], ['accepted-no-id', { accepted: true }, unknown],
  ['isError-only', { isError: true }, unknown], ['pending-bare', { pending: true }, refused], ['dispatchPending-bare', { dispatchPending: true }, refused],
  ['refused-child', { ok: false, ...child }, unknown], ['pending-child', { pending: true, ...child }, unknown],
  ['refused-task-only', { accepted: false, taskId: child.taskId }, unknown], ['pending-thread-only', { dispatchPending: true, threadId: child.childThreadId }, unknown],
  ['refused-childRun-only', { started: false, childRunId: child.childRunId }, unknown],
  ['positive-refusal', { accepted: true, ok: false }, unknown], ['positive-pending', { accepted: true, pending: true }, unknown],
  ['refused-pid', { ok: false, workerPid: 2147483647 }, unknown], ['pending-pid', { pending: true, workerPid: 2147483647 }, unknown],
  ['refused-daemon', { ok: false, daemonStateFile: '/fixture-only' }, unknown], ['pending-daemon', { pending: true, daemonStateFile: '/fixture-only' }, unknown],
  ['refused-handoff', { ok: false, handoff: {} }, unknown], ['pending-handoff', { pending: true, handoff: {} }, unknown],
  ['bare-ok', { ok: false }, refused], ['bare-accepted', { accepted: false }, refused], ['bare-started', { started: false }, refused], ['bare-canStart', { canStart: false }, refused],
  ['bare-blocked', { blocked: true }, refused], ['bare-blocked-status', { status: 'blocked_by_conflicts' }, refused], ['bare-blocked-action', { action: 'blocked_by_conflicts' }, refused],
  ['bare-dispatched', { dispatched: false }, refused], ['bare-outcome', { dispatchOutcome: 'rejected' }, refused],
  ['busy', { accepted: false, code: 'PROVIDER_BUSY' }, refused],
  ['auth', { accepted: false, message: '401 Unauthorized' }, { ...refused, next: 'wait_user', failure: 'provider_auth' }],
  ['rate', { accepted: false, message: '429 rate limit', retryAfterSeconds: 7 }, { ...refused, failure: 'provider_rate', delay: 7000 }],
  ['permission-code', { accepted: false, code: 'PERMISSION_DENIED' }, { ...refused, next: 'wait_user', failure: 'provider_auth' }],
  ['http-auth', { ok: false, status: 403 }, { ...refused, next: 'wait_user', failure: 'provider_auth' }],
  ['rate-code', { started: false, code: 'RATE_LIMITED', headers: { 'Retry-After': '3' } }, { ...refused, failure: 'provider_rate', delay: 3000 }],
  ['task-description', { ...child, task: 'A task description is not an envelope' }, accepted],
  ['runtime-conflict', { ok: false, workerPid: 1, response: { workerPid: 2 } }, conflict],
  ['alias-conflict', { ...child, threadId: 'foreign' }, conflict], ['target-conflict', { ...child, model: 'foreign-model' }, conflict],
  ['scope-conflict', { ...child, featureId: 'foreign-feature' }, conflict],
  ['array-response', { ok: false, response: [{ ...child, accepted: true }] }, unknown],
  ['array-structured', { ok: false, structuredContent: [{ ...child, accepted: true }] }, unknown],
  ['array-text', { ok: false, content: [{ type: 'text', text: JSON.stringify([{ ...child, accepted: true }]) }] }, unknown],
  ['invalid-text', { ok: false, content: [{ type: 'text', text: '{' }] }, unknown],
  ['invalid-structured', { ok: false, structuredContent: true }, unknown],
  ['null-response', { ok: false, response: null }, unknown], ['null-structured', { ok: false, structuredContent: null }, unknown],
  ['invalid-content', { ok: false, content: null }, unknown],
];
const shapes = [['undefined', undefined, unknown], ['array-root', [], unknown], ['scalar-root', 42, unknown], ...Object.entries(containers).flatMap(([container, wrap]) => bodies.map(([name, body, expected]) => [container + '/' + name, wrap(body), expected]))];
const entries = ['decision', 'journal', 'journal-thrown', 'journal-recovery', 'runner', 'hud-custom', 'hud-hook', 'hud-default', 'bridge', 'bridge-feature', 'bridge-delegate', 'cli', 'controller'];
const tick = async (dir, observations = [], clock = now) => (await k.missionTick(dir, { observations, now: clock })).action;
const obs = (a, response, type = 'dispatch') => ({ type, runId: a.runId, featureId: a.featureId, intentId: a.intentId, response });
function disk(dir) {
  return { state: k.loadState(dir), features: k.loadFeaturesDoc(dir), records: inspectDispatchRecords(dir),
    ledger: fs.existsSync(path.join(dir, '.mission/autopilot/controller.json')) ? JSON.parse(fs.readFileSync(path.join(dir, '.mission/autopilot/controller.json'))) : null };
}
function seed(dir, entry) {
  fs.mkdirSync(dir);
  k.proposeMission(dir, { title: 'A6 decision fixture', repoPath: dir, autopilot: entry === 'controller', ownerThreadId: 'decision-owner', milestones: [{ id: 'm1' }], features: [{ id: 'f1', milestoneId: 'm1' }], assertions: [{ id: 'VAL-1', milestoneId: 'm1' }], modelSettings: { worker: target }, retryPolicy: { baseDelayMs: 1000, maxDelayMs: 10000 } });
  if (!entry.startsWith('hud-')) k.approveMissionPlan(dir);
}
function privateProtocol(dir, raw) {
  const calls = path.join(dir, 'calls.txt'), file = path.join(dir, 'private-protocol.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'call\\n');console.log(${JSON.stringify(JSON.stringify(raw) ?? 'null')});`);
  const previous = [process.env.T3_ACP_MCP_NODE, process.env.T3_ACP_MCP_ENTRYPOINT];
  process.env.T3_ACP_MCP_NODE = process.execPath; process.env.T3_ACP_MCP_ENTRYPOINT = file;
  return () => {
    for (const [i, key] of ['T3_ACP_MCP_NODE', 'T3_ACP_MCP_ENTRYPOINT'].entries()) previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i];
    return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  };
}
for (const entry of entries) test('A6 decision matrix ' + entry, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-decision-')), rows = [];
  t.after(() => { if (process.env.R9_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, 'decision-' + entry + '.json'), JSON.stringify({ entry, cases: rows.length, rows }, null, 2)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [index, [name, raw, expected]] of shapes.entries()) await t.test(name, async () => {
    const dir = path.join(root, 'case-' + index); let calls = 0;
    const row = { name, rawDefined: raw !== undefined, raw, expected }; rows.push(row);
    const tolerate = async fn => { try { return await fn(); } catch (e) { (row.errors ??= []).push({ code: e.code, message: e.message }); } };
    const invoke = async () => { calls++; return raw; };
    try {
      if (entry === 'decision') {
        row.decision = schema.decideDispatchOutcome(raw, { expectedIdentity: { featureId: 'f1', ...target } });
        assert.equal(row.decision.outcome, expected.outcome); assert.equal(row.decision.raw, raw);
      } else if (entry.startsWith('bridge')) {
        row.result = entry === 'bridge' ? await callT3McpTool('delegate_task', {}, { transportClient: invoke }, { retainRaw: true })
          : entry === 'bridge-feature' ? await runFeature({ id: 'f1', description: 'Private bridge fixture' }, target, { missionId: 'fixture', activeWorker: { runId: 'fixture-run' } }, { transportClient: invoke })
          : await delegateMissionTask({ missionId: 'fixture', featureId: 'f1', runId: 'fixture-run', task: 'Private bridge fixture', target }, { transportClient: invoke });
        if (entry === 'bridge') assert.deepEqual(row.result, raw);
        assert.equal(calls, 1);
        assert.equal(schema.decideDispatchOutcome(row.result, { expectedIdentity: { featureId: 'f1', ...target } }).outcome, expected.outcome);
      } else {
        seed(dir, entry);
        if (entry === 'controller') {
          const timer = await tick(dir), a = await tick(dir, [{ type: 'timer', requestId: timer.requestId, response: { taskId: 'decision-timer', enabled: true } }]);
          row.dispatch = a;
          row.next = await tick(dir, [obs(a, raw)]); row.after = disk(dir);
          assert.equal(row.after.ledger.runs[a.runId].dispatchDecision.outcome, expected.outcome);
          assert.equal(row.after.records[0].phase, expected.phase); assert.equal(row.next.type, expected.next);
          if (expected.outcome === 'UNKNOWN') {
            assert.equal((await tick(dir)).type, 'recover_dispatch');
            const recovery = await tick(dir, [obs(a, { threads: [{ ...child, clientRequestId: a.intentId, parentThreadId: 'decision-owner' }] }, 'children')]);
            row.recovered = recovery; assert.equal(recovery.type, 'poll'); assert.equal(recovery.taskId, child.taskId);
            assert.equal(k.loadState(dir).sessions.length, 1); assert.equal(inspectDispatchRecords(dir)[0].intent.clientRequestId, a.intentId);
          } else if (expected.outcome === 'NOT_ACCEPTED') {
            const budget = row.after.ledger.features.f1, delay = expected.delay ?? 1000;
            assert.equal(budget.providerErrors, 1); assert.equal(row.after.ledger.consecutiveProviderErrors, 1);
            assert.equal(budget.nextRetryAt, new Date(now + delay).toISOString());
            assert.equal(row.after.ledger.runs[a.runId].consumed, true); assert.equal(row.after.state.sessions[0].handoff.providerFailure.kind, expected.failure);
            if (expected.failure === 'provider_auth') {
              assert.equal(budget.blocked, 'PROVIDER_AUTH_REQUIRED');
              const state = k.loadState(dir); k.rejectMissionPlan(dir, 'Explicit credential recovery');
              k.proposeMission(dir, { ...state, features: k.loadFeaturesDoc(dir).features }); k.approveMissionPlan(dir);
            }
            assert.equal((await tick(dir, [], now + delay - 1)).type, 'sleep');
            row.retry = await tick(dir, [], now + delay); assert.equal(row.retry.type, 'dispatch'); assert.equal(row.retry.attempt, 2); assert.notEqual(row.retry.intentId, a.intentId);
            assert.equal(disk(dir).ledger.features.f1.providerErrors, 1);
          } else if (expected.outcome === 'CONFLICT') {
            assert.equal((await tick(dir, [], now + 86400000)).type, 'wait_user'); assert.equal(k.loadState(dir).sessions.length, 1);
          } else assert.equal(row.next.taskId, child.taskId);
          row.final = disk(dir);
        } else {
          if (entry.startsWith('journal') || entry === 'cli') await k.startMissionRun(dir);
          if (entry.startsWith('journal')) {
            const s = k.loadState(dir), intent = prepareDispatch(dir, { state: s, feature: k.loadFeaturesDoc(dir).features[0], worker: s.activeWorker, target: s.activeWorker });
            const execute = entry === 'journal-thrown' ? async () => { calls++; throw Object.assign(new Error('Private transport exception'), { runtimeResult: raw }); } : invoke;
            await tolerate(() => dispatchWithIntent(dir, intent, execute));
            if (entry === 'journal-recovery') row.recovery = inspectDispatchRecords(dir);
            await tolerate(() => dispatchWithIntent(dir, intent, execute));
          } else if (entry === 'runner') {
            await tolerate(() => k.startMissionRun(dir, {}, { runFeature: invoke })); await tolerate(() => k.startMissionRun(dir, {}, { runFeature: invoke }));
          } else {
            const restore = (entry === 'hud-default' || entry === 'cli') && privateProtocol(dir, raw);
            try {
              if (entry === 'cli') {
                const s = k.loadState(dir), args = ['DispatchWorkerRuntime', '--mission-dir', dir, '--json', JSON.stringify({ missionId: s.missionId, runId: s.activeWorker.runId, activeWorker: s.activeWorker, feature: k.loadFeaturesDoc(dir).features[0], slotConfig: target })];
                const adapter = { runFeature: async (feature, slotConfig, state) => {
                  const response = await runCli(['DispatchWorkerRuntime', '--mission-dir', dir, '--json', JSON.stringify({missionId:state.missionId,runId:feature.runId,feature,slotConfig})], {stdout:{write(){}},stderr:{write(){}}});
                  row.result ??= response;
                  return response.result;
                } };
                await tolerate(() => k.startMissionRun(dir, {}, adapter));
                await tolerate(() => k.startMissionRun(dir, {}, adapter));
              } else {
                const hud = await createHandlerHud({ missionDir: dir, ...(entry === 'hud-default' ? {} : { runtimeAdapter: entry === 'hud-hook' ? { startMissionRun: invoke } : { runFeature: invoke } }) });
                try { row.result = await hud.post('approve', { commandId: 'first' }); row.repeat = await hud.post('approve', { commandId: 'second' }); } finally { await hud.close(); }
              }
            } finally { if (restore) calls = restore(); }
          }
          row.after = disk(dir); row.calls = calls;
          if (entry === 'cli') {
            assert.equal(calls, expected.calls, 'CLI retries only a decided nonacceptance');
            row.decision = schema.decideDispatchOutcome(row.result.result ?? row.result.controlReceipt?.raw, { expectedIdentity: { featureId: 'f1', ...target } });
            assert.equal(row.decision.outcome, expected.outcome);
          }
          else { assert.equal(calls, expected.calls); assert.equal(row.after.records[0].phase, expected.phase); }
          if (['runner', 'hud-custom', 'hud-hook', 'hud-default'].includes(entry)) assert.equal(Boolean(row.after.state.activeWorker.taskId), expected.outcome === 'ACCEPTED');
        }
      }
      row.pass = true;
    } catch (e) { row.pass = false; row.assertion = e.stack; throw e; }
  });
});
