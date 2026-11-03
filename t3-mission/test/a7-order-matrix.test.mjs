import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as k from '../kernel/index.mjs';
import { applyAutopilotCommand } from '../kernel/autopilot-commands.mjs';
import { readController, archiveObservation } from '../kernel/autopilot-store.mjs';
import { inspectDispatchRecords, prepareDispatch, dispatchWithIntent } from '../kernel/dispatch-journal.mjs';
import { callMissionTool } from '../bridge/mcp-server.mjs';
import { runCli } from '../bridge/cli.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';
const now = 1793000000000;
const accepted = { accepted:true, taskId:'original-task',childThreadId:'original-child',runtimeTransport:'t3-delegate-task' };
const refusal = { accepted:false,code:'PROVIDER_BUSY' };
// Literal oracles describe final behavior, not the implementation's classifier.
const sequences = [
 { name:'refusal-accepted', first:refusal, second:accepted, phase:'accepted', next:'poll', calls:0, sessions:1, rejected:false, failure:false },
 { name:'refusal-unique', first:refusal, recovery:1, phase:'accepted', next:'poll', calls:0, sessions:1, rejected:false, failure:false },
 { name:'refusal-zero', first:refusal, recovery:0, phase:'retryable', next:'wait_user', calls:0, sessions:1, rejected:true, failure:true },
 { name:'refusal-multiple', first:refusal, recovery:2, phase:'inflight', next:'wait_user', calls:0, sessions:1, rejected:false, failure:false },
 { name:'pending-accepted', first:{pending:true}, second:accepted, phase:'accepted', next:'poll', calls:0, sessions:1, rejected:false, failure:false },
 { name:'unknown-child-refusal', first:{pending:true,taskId:'original-task',childThreadId:'original-child'}, second:refusal, phase:'inflight', next:'recover_dispatch', calls:0, sessions:1, rejected:false, failure:true },
 { name:'unknown-empty-refusal', first:{isError:true}, second:refusal, phase:'inflight', next:'recover_dispatch', calls:0, sessions:1, rejected:false, failure:true },
 { name:'accepted-refusal', first:accepted, second:refusal, phase:'accepted', next:'poll', calls:0, sessions:1, rejected:false, failure:false },
 { name:'accepted-identity-conflict', first:accepted, second:{...accepted,taskId:'foreign-task'}, phase:'inflight', next:'wait_user', calls:0, sessions:1, rejected:false, failure:false, splitPhase:'accepted' },
 { name:'refusal-refusal', first:refusal, second:{blocked:true,code:'PROVIDER_BUSY'}, phase:'retryable', next:'sleep', calls:0, sessions:1, rejected:true, failure:true, retry:true },
];
const obs=(a,response,type='dispatch')=>({type,runId:a.runId,featureId:a.featureId,intentId:a.intentId,response});
const tick=async(d,observations=[],clock=now)=>(await k.missionTick(d,{observations,now:clock})).action;
function snapshot(d,a) {
 const state=k.loadState(d),ledger=readController(d,state.missionId),records=inspectDispatchRecords(d);
 const run=ledger.runs[a.runId];
 assert.equal(records.some(r=>r.phase==='accepted') && records.some(r=>r.intent.featureId===a.featureId && r.phase==='inflight' && r.intent.clientRequestId!==a.intentId),false,'No accepted intent may coexist with another inflight intent for the feature');
 return {state,ledger,records,run};
}
async function boot(d) {
 k.proposeMission(d,{title:'Observation order',repoPath:d,autopilot:true,ownerThreadId:'owner',pauseMode:'let_finish',milestones:[{id:'m1'}],features:[{id:'f1',title:'Original title',milestoneId:'m1',maxAttempts:3}],retryPolicy:{baseDelayMs:1000,maxDelayMs:10000}});k.approveMissionPlan(d);
 const timer=await tick(d);return tick(d,[{type:'timer',requestId:timer.requestId,response:{taskId:'timer',enabled:true}}]);
}
function reload(d) {
 return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)};console.log(JSON.stringify({state:k.loadState(process.argv[1]),records:(await import(${JSON.stringify(new URL('../kernel/dispatch-journal.mjs',import.meta.url).href)})).inspectDispatchRecords(process.argv[1])}));`,d],{encoding:'utf8'}));
}
async function settleCompensation(d,a,action,trace,resumeAllowed=false) {
 if(action.type==='interrupt_worker') {
  trace.compensationInterrupts=(trace.compensationInterrupts??0)+1;
  assert.equal(trace.compensationInterrupts,1);assert.equal(action.threadId,'original-child');
  assert.equal(action.runId,a.runId);assert.equal(action.clientRequestId,a.intentId);
  assert.equal(action.controlId,`${a.runId}:1:interrupt`);
  assert.equal(k.loadState(d).status,'paused');
  trace.compensationInterrupt=action;
  action=await tick(d,[{type:'interrupt',featureId:a.featureId,runId:a.runId,controlId:action.controlId,response:{interrupted:true,threadId:'original-child'}}]);
 }
 if(action.type==='resume_worker') {
  assert.equal(resumeAllowed,true);trace.compensationResumes=(trace.compensationResumes??0)+1;
  assert.equal(trace.compensationResumes,1);assert.equal(action.threadId,'original-child');
  assert.equal(action.runId,a.runId);assert.equal(action.controlId,`${a.runId}:1:resume`);
  assert.equal(k.loadState(d).status,'running');trace.compensationResume=action;
  action=await tick(d,[{type:'resume',featureId:a.featureId,runId:a.runId,controlId:action.controlId,response:{sent:true,threadId:'original-child'}}]);
 }
 return action;
}
for(const mode of ['same-batch','split','process-restart','pause-resume']) test('A7 observation order '+mode,async t=>{
 const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-order-')),rows=[];
 t.after(()=>{if(process.env.R9_EVIDENCE_DIR)fs.writeFileSync(path.join(root,'matrix.json'),JSON.stringify(rows,null,2));});
 for(const row of sequences)await t.test(row.name,async()=>{
  const d=path.join(root,row.name);fs.mkdirSync(d);const a=await boot(d);
  const first=obs(a,row.first),second=row.recovery===undefined?obs(a,row.second):obs(a,{threads:Array.from({length:row.recovery},(_,i)=>({...accepted,taskId:i===0?'original-task':'other-task',childThreadId:i===0?'original-child':'other-child',clientRequestId:a.intentId,parentThreadId:'owner'}))},'children');
  let action;const trace={name:row.name,expected:row,a};rows.push(trace);
  if(mode==='same-batch') action=await tick(d,[first,second]);
  else {
   // A refusal can be retried on the same run only while a durable user gate
   // prevents its failure from being consumed before the second observation.
   applyAutopilotCommand(d,'pause');trace.first=await settleCompensation(d,a,await tick(d,[first]),trace);assert.equal(trace.first.type,'wait_user');
   if(mode==='process-restart') {trace.reloaded=reload(d);assert.equal(trace.reloaded.state.activeWorker.runId,a.runId);}
   if(mode==='pause-resume') {trace.pausedSecond=await settleCompensation(d,a,await tick(d,[second]),trace);assert.equal(trace.pausedSecond.type,'wait_user');applyAutopilotCommand(d,'resume');action=await tick(d);}
   else {
    applyAutopilotCommand(d,'resume');
    action=mode==='process-restart'?JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))).action));`,d,JSON.stringify({observations:[second],now})],{encoding:'utf8'})):await tick(d,[second]);
   }
  }
  action=await settleCompensation(d,a,action,trace,mode!=='same-batch');
  trace.action=action;trace.after=snapshot(d,a);
  assert.equal(action.type,row.next);assert.equal(trace.after.records.find(r=>r.intent.clientRequestId===a.intentId).phase,mode==='same-batch'?row.phase:(row.splitPhase??row.phase));
  assert.equal(trace.after.state.sessions.length,row.sessions);assert.equal(Boolean(trace.after.run.rejectedObservationId),row.rejected);assert.equal(Boolean(trace.after.run.failure),row.failure);
  if(row.next==='poll'){assert.equal(trace.after.run.dispatchError,undefined);assert.equal(trace.after.run.terminalObservationId,undefined);}
  if(!row.retry) {assert.equal(trace.after.state.activeWorker.runId,a.runId);const later=await tick(d,[],now+86400000);assert.equal(later.type,row.next);snapshot(d,a);}
  else {assert.equal(trace.after.ledger.features.f1.providerErrors,1);assert.equal(trace.after.ledger.features.f1.nextRetryAt,'2026-10-26T07:33:21.000Z');assert.equal((await tick(d,[],now+999)).type,'sleep');const retry=await tick(d,[],now+1000);assert.equal(retry.type,'dispatch');assert.equal(retry.attempt,2);assert.notEqual(retry.runId,a.runId);assert.equal(k.loadState(d).sessions.length,2);snapshot(d,a);}
 });
});
// Literal public-entry oracles cover the new invocation, not an older refusal.
const retryOutcomes = [
 {name:'accepted',response:accepted,phase:'accepted',next:'poll',failure:false,status:200},
 {name:'unknown-child',response:{pending:true,taskId:'possible-task',childThreadId:'possible-child'},phase:'inflight',next:'recover_dispatch',failure:true,status:409},
 {name:'unknown-empty',response:{},phase:'inflight',next:'recover_dispatch',failure:true,status:409},
 {name:'conflict',response:{accepted:true,taskId:'conflict-task',childThreadId:'conflict-child',clientRequestId:'wrong-request'},phase:'inflight',next:'wait_user',failure:false,status:500},
];
async function publicRetry(d,entry,response,counter) {
 const invoke=async()=>{counter.calls++;return response;},adapter={runFeature:invoke};
 if(entry==='kernel')return k.startMissionRun(d,{},adapter).catch(error=>({error}));
 if(entry==='MCP')return callMissionTool('StartMissionRun',{missionDir:d},{kernel:k,dispatchAdapter:adapter}).catch(error=>({error}));
 if(entry==='CLI')return runCli(['StartMissionRun','--mission-dir',d],{kernel:k,dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
 const state=k.loadState(d);state.autopilot=false;
 if(entry==='HUD-resume') {
  execFileSync('git',['init','-q',d]);fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');execFileSync('git',['-C',d,'add','.gitignore']);execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);
  state.status='paused';for(const row of [state.activeWorker,state.sessions[0]]) {row.status='paused';delete row.dispatchPending;delete row.runtimeTransport;}
  adapter.resumeWorker=invoke;
 }
 k.saveState(d,state);
 const hud=await createHandlerHud({missionDir:d,runtimeAdapter:adapter});let reply;
 try{reply=await hud.post(entry==='HUD-approve'?'approve':'resume');}finally{await hud.close();}
 const restored=k.loadState(d);restored.autopilot=true;k.saveState(d,restored);applyAutopilotCommand(d,'resume');return reply;
}
for(const row of retryOutcomes)for(const entry of ['kernel','MCP','CLI','HUD-approve','HUD-resume'])for(const mode of ['same-batch','split','process-restart','pause-resume'])test('A7 public retry '+row.name+' '+entry+' '+mode,async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-entry-')),a=await boot(d),counter={calls:0};
 applyAutopilotCommand(d,'pause');await tick(d,[obs(a,refusal)]);assert.equal(inspectDispatchRecords(d)[0].phase,'retryable');
 if(mode==='process-restart')reload(d);
 if(mode==='pause-resume'){applyAutopilotCommand(d,'resume');applyAutopilotCommand(d,'pause');}
 applyAutopilotCommand(d,'resume');
 const reply=await publicRetry(d,entry,row.response,counter);if(entry.startsWith('HUD-'))assert.equal(reply.status,row.status);if(mode==='process-restart')reload(d);
 assert.equal(counter.calls,1);const after=snapshot(d,a);assert.equal(after.records[0].phase,row.phase);assert.equal(after.run.rejectedObservationId,undefined);assert.equal(Boolean(after.run.failure),row.failure);
 assert.equal((await tick(d)).type,row.next);assert.equal((await tick(d,[],now+86400000)).type,row.next);assert.equal(k.loadState(d).activeWorker.runId,a.runId);assert.equal(k.loadState(d).sessions.length,1);snapshot(d,a);
});
for(const entry of ['kernel','MCP','CLI','HUD-approve','HUD-resume'])test('A7 multiple recovery matches fence public retry '+entry,async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-multiple-')),a=await boot(d),counter={calls:0};
 const threads=[{taskId:'first-task',childThreadId:'first-child',clientRequestId:a.intentId,parentThreadId:'owner'},{taskId:'second-task',childThreadId:'second-child',clientRequestId:a.intentId,parentThreadId:'owner'}];
 assert.equal((await tick(d,[obs(a,refusal),obs(a,{threads},'children')])).type,'wait_user');
 await publicRetry(d,entry,accepted,counter);assert.equal(counter.calls,0);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');assert.equal(k.loadState(d).sessions.length,1);
});
test('A7 a legal public retry fences an older refusal while its callback is unsettled',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-unsettled-')),a=await boot(d);applyAutopilotCommand(d,'pause');await tick(d,[obs(a,refusal)]);applyAutopilotCommand(d,'resume');let calls=0;
 await k.startMissionRun(d,{}, {runFeature:async()=>{calls++;assert.equal(inspectDispatchRecords(d)[0].invocationPhase,'inflight');assert.equal((await tick(d)).type,'recover_dispatch');assert.equal(k.loadState(d).activeWorker.runId,a.runId);return accepted;}});
 assert.equal(calls,1);assert.equal(inspectDispatchRecords(d)[0].invocationPhase,'returned');assert.equal((await tick(d)).type,'poll');assert.equal(k.loadState(d).sessions.length,1);
});

test('A7 a later UNKNOWN with execution evidence refences an earlier retryable refusal',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-promote-')),a=await boot(d);
 applyAutopilotCommand(d,'pause');await tick(d,[obs(a,refusal)]);assert.equal(inspectDispatchRecords(d)[0].phase,'retryable');
 await tick(d,[obs(a,{pending:true,taskId:'possible-task',childThreadId:'possible-child'})]);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');
 applyAutopilotCommand(d,'resume');assert.equal((await tick(d)).type,'recover_dispatch');let calls=0;try{await k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return accepted;}});}catch(error){assert.equal(error.code,'DISPATCH_OUTCOME_UNKNOWN');}
 assert.equal(calls,0);assert.equal(readController(d,k.loadState(d).missionId).runs[a.runId].rejectedObservationId,undefined);snapshot(d,a);
});

test('A7 working status sleeps on the original accepted run after a stale refusal',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-working-')),a=await boot(d);
 assert.equal((await tick(d,[obs(a,refusal),obs(a,accepted)])).type,'poll');
 const action=await tick(d,[{type:'task_status',featureId:a.featureId,runId:a.runId,taskId:'original-task',response:{taskId:'original-task',childThreadId:'original-child',status:'running',workState:'working',hasPendingChildRuns:false}}]);
 assert.equal(action.type,'sleep');assert.equal(k.loadState(d).activeWorker.runId,a.runId);assert.equal(k.loadState(d).sessions.length,1);assert.equal(inspectDispatchRecords(d)[0].phase,'accepted');snapshot(d,a);
});

test('A7 acceptance arriving after an already consumed refusal fences the next attempt and preserves history',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-late-')),a=await boot(d);
 assert.equal((await tick(d,[obs(a,refusal)])).type,'sleep');const oldSession=k.loadState(d).sessions[0];
 const after=await tick(d,[obs(a,accepted)]);assert.equal(after.type,'poll');assert.equal(after.reconciliation,true);assert.equal(inspectDispatchRecords(d)[0].phase,'accepted');
 assert.equal((await tick(d,[],now+86400000)).type,'poll');assert.deepEqual(k.loadState(d).sessions[0],oldSession);assert.equal(k.loadState(d).sessions.length,1);snapshot(d,a);
});

test('A7 retargeting cannot erase archived execution evidence before controller replay',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-retarget-')),a=await boot(d);applyAutopilotCommand(d,'pause');await tick(d,[obs(a,refusal)]);applyAutopilotCommand(d,'resume');
 archiveObservation(d,obs(a,{pending:true,taskId:'possible-task',childThreadId:'possible-child'}));const state=k.loadState(d),feature=k.loadFeaturesDoc(d).features[0];
 assert.throws(()=>prepareDispatch(d,{state,feature,worker:state.activeWorker,target:{providerInstanceId:'other-provider',model:'other-model',options:{}}}),{code:'DISPATCH_TARGET_CONFLICT'});
 assert.equal(inspectDispatchRecords(d)[0].intent.clientRequestId,a.intentId);assert.equal((await tick(d)).type,'recover_dispatch');snapshot(d,a);
});

test('A7 formal Bind refuses an identity contradicting retained UNKNOWN child evidence',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-bind-conflict-')),a=await boot(d);
 await tick(d,[obs(a,{pending:true,taskId:'possible-task',childThreadId:'possible-child'})]);const state=k.loadState(d);
 assert.throws(()=>k.bindFeatureDispatch(d,{featureId:'f1',runId:a.runId,expectedRevision:state.revision,...accepted}),{code:'DISPATCH_RECEIPT_CONFLICT'});
 assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');assert.equal(k.loadState(d).activeWorker.taskId,undefined);snapshot(d,a);
});

test('A7 a normal unknown retry result is not released by a previous bare pending',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-pending-unknown-'));k.proposeMission(d,{title:'Pending then unknown',repoPath:d,features:[{id:'f1'}]});k.approveMissionPlan(d);
 await k.startMissionRun(d,{}, {runFeature:async()=>({pending:true})});assert.equal(inspectDispatchRecords(d)[0].phase,'retryable');let calls=0;
 await k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return {ok:true,worktreePath:'/private/tmp'};}});assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');
 await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return accepted;}}),{code:'DISPATCH_OUTCOME_UNKNOWN'});assert.equal(calls,1);assert.equal(k.loadState(d).sessions.length,1);
});

for(const entry of ['StartMissionRun','claim'])test('A7 prepared intent respects archived UNKNOWN before '+entry,async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-prepared-'));k.proposeMission(d,{title:'Prepared evidence fence',repoPath:d,features:[{id:'f1'}]});k.approveMissionPlan(d);await k.startMissionRun(d);
 const state=k.loadState(d),intent=prepareDispatch(d,{state,feature:k.loadFeaturesDoc(d).features[0],worker:state.activeWorker,target:state.activeWorker});assert.equal(inspectDispatchRecords(d)[0].phase,'prepared');
 archiveObservation(d,{type:'dispatch',featureId:'f1',runId:intent.runId,intentId:intent.clientRequestId,response:{pending:true,taskId:'possible-task',childThreadId:'possible-child'}});let calls=0;
 if(entry==='StartMissionRun')await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return accepted;}}),{code:'DISPATCH_OUTCOME_UNKNOWN'});
 else {const {claimDispatchIntent}=await import('../kernel/dispatch-journal.mjs');assert.equal(claimDispatchIntent(d,intent),false);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');}
 assert.equal(calls,0);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');assert.equal(k.loadState(d).sessions.length,1);assert.equal(k.loadState(d).activeWorker.runId,intent.runId);
});

test('A7 archived runtime identity cannot become accepted without ownership verification',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-unverified-runtime-'));k.proposeMission(d,{title:'Unverified runtime',repoPath:d,features:[{id:'f1'}]});k.approveMissionPlan(d);await k.startMissionRun(d);
 const state=k.loadState(d),intent=prepareDispatch(d,{state,feature:k.loadFeaturesDoc(d).features[0],worker:state.activeWorker,target:state.activeWorker});
 archiveObservation(d,{type:'dispatch',featureId:'f1',runId:intent.runId,intentId:intent.clientRequestId,response:{accepted:true,workerPid:2147483647,daemonStateFile:path.join(d,'missing-runtime.json')}});let calls=0;
 await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return accepted;}}),{code:'DISPATCH_OUTCOME_UNKNOWN'});assert.equal(calls,0);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');
});

test('A7 a late acknowledgement of a genuinely ended accepted run stays stale',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-ended-ack-')),a=await boot(d);await tick(d,[obs(a,accepted)]);
 k.updateMissionFeatures(d,{updateFeatures:[{id:'f1',maxAttempts:1}]});
 k.endFeatureRun(d,{featureId:'f1',runId:a.runId,successState:'failure',validatorsPassed:false,returnToOrchestrator:true,handoff:{whatWasImplemented:'The existing accepted task finished with a real failure before this delayed acknowledgement arrived.',tests:[],discoveredIssues:[],whatWasLeftUndone:[]}});
 const before=k.loadState(d).sessions[0],action=await tick(d,[obs(a,{...accepted,message:'Late acknowledgement of the original finished task'})]);
 assert.equal(action.type,'wait_user');assert.equal(action.reason,'MAX_ATTEMPTS_EXCEEDED');assert.equal(readController(d,k.loadState(d).missionId).dispatchEvidenceError,undefined);assert.deepEqual(k.loadState(d).sessions[0],before);assert.equal(inspectDispatchRecords(d).length,1);assert.equal(inspectDispatchRecords(d)[0].phase,'accepted');
});

test('A7 a refusal archived before a public invocation cannot release its later normal UNKNOWN',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-archive-order-')),a=await boot(d);applyAutopilotCommand(d,'pause');await tick(d,[obs(a,refusal)]);applyAutopilotCommand(d,'resume');archiveObservation(d,obs(a,{blocked:true,code:'PROVIDER_BUSY'}));let calls=0;
 await k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return {};}});assert.equal(calls,1);assert.equal((await tick(d)).type,'recover_dispatch');assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');assert.equal(k.loadState(d).activeWorker.runId,a.runId);
});
