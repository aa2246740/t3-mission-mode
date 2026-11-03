import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords, dispatchRuntimeInvocation, beginDispatchInvocation} from '../kernel/dispatch-journal.mjs';
import {archiveObservation, readObservations} from '../kernel/autopilot-store.mjs';
import {missionTransaction, writeTransactionFile} from '../kernel/mission-transaction.mjs';
import {now, tick, init, first, observation, accepted, status, result, finish, reapprove, ledger, rejectedAttempts} from './fixtures/a10-fixture.mjs';

for (const maxAttempts of [1, 2, 3, 5, 17]) for (const maxConsecutiveProviderErrors of [1, 2, 3, 5, 11])
  test(`A10 invocation budget precedes capacity ${maxAttempts}/${maxConsecutiveProviderErrors}`, async () => {
    const d = init('invocation-budget', maxAttempts), state = k.loadState(d);
    k.proposeMission(d, {...state, features: k.loadFeaturesDoc(d).features,
      retryPolicy: {...state.retryPolicy, maxConsecutiveProviderErrors}}); k.approveMissionPlan(d);
    let calls = 0;
    const adapter = {runFeature: async () => {calls++; return {accepted: false, code: 'PROVIDER_BUSY'};}};
    const expected = Math.min(maxAttempts, maxConsecutiveProviderErrors);
    for (let i = 0; i < expected; i++) await assert.rejects(() => k.startMissionRun(d, {}, adapter));
    await assert.rejects(() => k.startMissionRun(d, {}, adapter), {code: 'DISPATCH_RETRY_BUDGET_EXHAUSTED'});
    reapprove(d, 'retarget-after-budget');
    await assert.rejects(() => k.startMissionRun(d, {}, adapter), {code: 'DISPATCH_RETRY_BUDGET_EXHAUSTED'});
    assert.equal(calls, expected); assert.equal(inspectDispatchRecords(d)[0].invocations.length, expected);
    assert.ok(expected < 1024);
    const timer = await tick(d);
    const consumed = await tick(d, [{type: 'timer', requestId: timer.requestId, response: {taskId: 'timer', enabled: true}}]);
    assert.ok(['sleep', 'wait_user'].includes(consumed.type));
    assert.equal(k.loadState(d).activeWorker, null);
  });

test('A10 5000 progress updates retain one latest raw status and terminal facts', async () => {
  const d = init('progress'), a = await first(d);
  await tick(d, [observation(a, accepted(a))]);
  missionTransaction(d, () => {
    for (let i = 0; i < 5000; i++) archiveObservation(d, status(a, 'running', {progressSequence: i}));
  });
  const rows = readObservations(d).filter(row => row.observation.runId === a.runId);
  assert.equal(rows.length, 2); assert.equal(rows.find(row => row.progressCount).progressCount, 5000);
  assert.equal(rows.find(row => row.progressCount).observation.response.progressSequence, 4999);
  const action = await tick(d, [result(a)], now + 1000);
  assert.equal(action.kind, 'integrate');
  assert.deepEqual(readObservations(d).filter(row => row.observation.runId === a.runId && row.observation.response.status === 'completed').map(row => row.observation.response), [result(a).response]);
});

test('A10 new child identity and refusal raw records are never compacted as progress', async () => {
  const d = init('new-identity'), a = await first(d);
  await tick(d, [observation(a, accepted(a))]);
  missionTransaction(d, () => {
    for (let i = 0; i < 600; i++) archiveObservation(d, status(a, 'running', {childRunId: 'distinct-' + i}));
    archiveObservation(d, status(a, 'running', {accepted: false, error: 'original refusal'}));
    archiveObservation(d, result(a));
  });
  const rows = readObservations(d).filter(row => row.observation.runId === a.runId);
  assert.equal(rows.length, 603);
  assert.equal(rows.some(row => row.progressCount !== undefined), false);
  const next = await tick(d, [], now + 2000);
  assert.equal(next.kind, 'integrate');
});

test('A10 corruption guard blocks callbacks while terminal and acceptance can still be archived', async () => {
  const d = init('corruption');
  await assert.rejects(() => k.startMissionRun(d, {}, {runFeature: async () => ({accepted: false, code: 'PROVIDER_BUSY'})}));
  const record = inspectDispatchRecords(d)[0], base = path.join(d, '.mission');
  const filename = fs.readdirSync(base).find(name => /^dispatch-.*\.json$/.test(name));
  missionTransaction(d, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(base, filename)));
    raw.unattributedEvidence = Array.from({length: 65536}, () => ({accepted: false}));
    writeTransactionFile(path.join(base, filename), JSON.stringify(raw));
  });
  let calls = 0;
  await assert.rejects(() => k.startMissionRun(d, {}, {runFeature: async () => {calls++;}}), {code: 'DISPATCH_EVIDENCE_LIMIT'});
  assert.equal(calls, 0);
  const a = {featureId: 'f1', runId: record.intent.runId, intentId: record.intent.clientRequestId, invocationId: record.invocations[0].invocationId, attempt: 1};
  archiveObservation(d, observation(a, accepted(a)));
  archiveObservation(d, result(a));
  assert.equal(readObservations(d).filter(row => row.observation.runId === a.runId).length, 2);
});

test('A10 more than 512 terminal proofs remain usable in manual audit resolution', async () => {
  const d = init('many-terminals'), [a] = await rejectedAttempts(d, 1);
  missionTransaction(d, () => {
    for (let i = 0; i < 600; i++) {
      const original = {...a, taskId: 'conflict-' + i, childThreadId: 'thread-' + i, childRunId: 'turn-' + i};
      archiveObservation(d, observation(original, accepted(original)));
      archiveObservation(d, status(original, 'cancelled'));
    }
  });
  assert.equal((await tick(d, [], now + 1000)).type, 'wait_user');
  const ids = readObservations(d).filter(row => row.observation.type === 'task_status').map(row => row.id);
  assert.equal(ids.length, 600);
  const res = k.resolveDispatchEvidence(d, {intentId: a.intentId, userConfirmed: true, reason: 'Every original current execution is stopped; retain the audit proof.',
    terminalObservationIds: ids, selectedTaskId: 'conflict-0', selectedChildThreadId: 'thread-0'});
  assert.equal(ledger(d).dispatchResolutions[res.resolutionId].terminalObservationIds.length, 600);
  const next = await tick(d, [], now + 1001); assert.equal(next.type, 'dispatch');
  await finish(d, next, now + 2000);
});

test('A10 reducing a previously approved large budget cannot turn old refusals into a permanent capacity fence', async () => {
  const d=init('budget-reduction',1100), initial=k.loadState(d);
  k.proposeMission(d,{...initial,features:k.loadFeaturesDoc(d).features,retryPolicy:{baseDelayMs:1000,maxDelayMs:1000,maxConsecutiveProviderErrors:1100}});k.approveMissionPlan(d);
  let calls=0;
  const adapter={runFeature:async()=>{calls++;return {accepted:false,code:'PROVIDER_BUSY'};}};
  for(let i=0;i<1025;i++){
    await assert.rejects(()=>k.startMissionRun(d,{},adapter));
    if((i+1)%100===0)console.log('# actual public callbacks '+(i+1));
  }
  assert.equal(calls,1025);assert.equal(inspectDispatchRecords(d)[0].invocations.length,1025);
  const state=k.loadState(d);k.rejectMissionPlan(d,'Approve a smaller future budget without discarding any refusal facts.');
  k.proposeMission(d,{...state,features:k.loadFeaturesDoc(d).features.map(f=>({...f,maxAttempts:5})),retryPolicy:{baseDelayMs:1000,maxDelayMs:1000,maxConsecutiveProviderErrors:5}});k.approveMissionPlan(d);
  await assert.rejects(()=>k.startMissionRun(d,{},adapter),{code:'DISPATCH_RETRY_BUDGET_EXHAUSTED'});
  assert.equal(calls,1025);
  const timer=await tick(d);
  await tick(d,[{type:'timer',requestId:timer.requestId,response:{taskId:'timer',enabled:true}}]);
  const next=await tick(d,[],now+1000);assert.equal(next.type,'dispatch');assert.equal(next.attempt,2);
  await finish(d,next,now+2000);
});

for(const smallerBudget of [false,true]) test(`A10 registered runtime checks ${smallerBudget?'reduced budget before':'current'} corruption before transport`,async()=>{
 const d=init('runtime-capacity',smallerBudget?5:1);
 let a,record;
 if(smallerBudget){
  await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>({accepted:false,code:'PROVIDER_BUSY'})}));
  record=inspectDispatchRecords(d)[0];
  const invocationId=beginDispatchInvocation(d,record.intent);
  a={featureId:record.intent.featureId,runId:record.intent.runId,intentId:record.intent.clientRequestId,invocationId};
  const state=k.loadState(d);k.rejectMissionPlan(d,'Lower future budgets, retain original reservations and facts.');
  k.proposeMission(d,{...state,features:k.loadFeaturesDoc(d).features.map(f=>({...f,maxAttempts:1})),retryPolicy:{baseDelayMs:1000,maxDelayMs:1000,maxConsecutiveProviderErrors:1}});k.approveMissionPlan(d);
 }else{a=await first(d);record=inspectDispatchRecords(d)[0];}
 const base=path.join(d,'.mission'),file=path.join(base,fs.readdirSync(base).find(n=>/^dispatch-.*\.json$/.test(n)));
 missionTransaction(d,()=>{const raw=JSON.parse(fs.readFileSync(file));raw.unattributedEvidence=Array.from({length:65536},()=>({accepted:false}));writeTransactionFile(file,JSON.stringify(raw));});
 let calls=0;
 let error;try{await dispatchRuntimeInvocation(d,{missionId:record.intent.missionId,runId:a.runId,feature:{...record.intent.feature,clientRequestId:a.intentId,invocationId:a.invocationId},slotConfig:record.intent.target},async()=>{calls++;return {accepted:false,code:'PROVIDER_BUSY'};},()=>{});}catch(cause){error=cause;}
 assert.equal(calls,0);assert.equal(error?.code,smallerBudget?'DISPATCH_RETRY_BUDGET_EXHAUSTED':'DISPATCH_EVIDENCE_LIMIT');
 assert.equal(inspectDispatchRecords(d)[0].invocations.find(row=>row.invocationId===a.invocationId).runtimeClaimed,undefined);
 assert.deepEqual(error.runtimeResult,{accepted:false,preSend:true,code:smallerBudget?'DISPATCH_RETRY_BUDGET_EXHAUSTED':'DISPATCH_EVIDENCE_LIMIT'});
 let action=await tick(d,[observation(a,error.runtimeResult)]);
 if(action.type==='ensure_timer')action=await tick(d,[{type:'timer',requestId:action.requestId,response:{taskId:'timer',enabled:true}}]);
 assert.equal(action.type,'wait_user');assert.equal(k.loadState(d).activeWorker,null);

});
