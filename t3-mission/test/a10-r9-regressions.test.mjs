import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords,dispatchRecordOutcome} from '../kernel/dispatch-journal.mjs';
import {readController,readObservations,archiveObservation} from '../kernel/autopilot-store.mjs';
import {missionTransaction} from '../kernel/mission-transaction.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a10-r9-')),now=1793000000000;
const tick=async(d,observations=[],time=now)=>(await k.missionTick(d,{observations,now:time})).action;
const obs=(a,response,type='dispatch')=>({type,featureId:a.featureId,runId:a.runId,intentId:a.intentId,
 ...(type==='dispatch'?{invocationId:a.invocationId}:{taskId:'task-'+a.attempt}),response});
const child=(op,d,arg={})=>{
 const z=cp.spawnSync(process.execPath,[fileURLToPath(new URL('fixtures/a10-r9-child.mjs',import.meta.url)),op,d,JSON.stringify(arg)],{encoding:'utf8'});
 let parsed;try{parsed=JSON.parse(z.stdout);}catch{}
 return {status:z.status,signal:z.signal,stdout:z.stdout,stderr:z.stderr,...parsed};
};
const save=(name,value)=>fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value,null,2)+'\n');
function init(name){const d=path.join(root,name);fs.mkdirSync(d);k.proposeMission(d,{title:name,repoPath:d,autopilot:true,pauseMode:'let_finish',ownerThreadId:'owner',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1',maxAttempts:8}],retryPolicy:{baseDelayMs:1000,maxDelayMs:1000,maxConsecutiveProviderErrors:10},integration:{branch:'main',auto:true}});k.approveMissionPlan(d);return d;}
async function first(d){const t=await tick(d);assert.equal(t.type,'ensure_timer');return tick(d,[{type:'timer',requestId:t.requestId,response:{taskId:'timer',enabled:true}}]);}
const accepted=a=>({accepted:true,taskId:'task-'+a.attempt,childThreadId:'thread-'+a.attempt,childRunId:'turn-'+a.attempt});
const status=(a,status,extra={})=>obs(a,{...accepted(a),status,workState:status==='running'?'working':'result_available',hasPendingChildRuns:false,...extra},'task_status');
function body(a,status='success',sha='abcdef1234567'){
 return {version:1,featureId:a.featureId,runId:a.runId,status,summary:'The original execution returns a complete literal result with matching identity and retained historical work. This is a private protocol fixture.',tests:[{command:'fixture-check',status:'passed'}],discoveredIssues:[],whatWasLeftUndone:[],commit:status==='success'?sha:null,branch:status==='success'?'feature/original':null,testedSha:sha,failedAssertions:[],assertionResults:{}};
}
const result=(a,state='success',sha)=>status(a,'completed',{summary:'```mission-result\n'+JSON.stringify(body(a,state,sha))+'\n```'});

for(const entry of ['kernel','MCP','CLI','HUD'])test('Unsettled late execution fences fresh public '+entry,async()=>{
 const d=init('late-start-'+entry),a=await first(d);
 await tick(d,[obs(a,{accepted:false,code:'PROVIDER_BUSY'})]);
 const beforeSession=JSON.stringify(k.loadState(d).sessions[0]);
 const late=await tick(d,[obs(a,accepted(a))],now+2000);assert.equal(late.type,'poll');
 const before=readController(d,k.loadState(d).missionId);
 const res=child(entry,d),after=k.loadState(d),afterLedger=readController(d,after.missionId);
 const afterTick=child('tick',d,{now:now+3000});
 save('late-start-'+entry,{a,late,beforeSession,before,res,after,afterLedger,afterTick,records:inspectDispatchRecords(d)});
 assert.equal(res.calls.length,0,'No new public callback may enter while the original task still lacks terminal proof');
 assert.equal(after.sessions.length,1);assert.equal(JSON.stringify(after.sessions[0]),beforeSession);
});

test('Multiple late intents remain fenced across Pause Resume and fresh Start',async()=>{
 const d=init('multiple-late-resume'),a=await first(d);
 await tick(d,[obs(a,{accepted:false,code:'PROVIDER_BUSY'})]);
 const b=await tick(d,[],now+1000);await tick(d,[obs(b,{accepted:false,code:'PROVIDER_BUSY'})],now+1001);
 await tick(d,[obs(a,accepted(a)),obs(b,accepted(b))],now+2000);
 await tick(d,[status(b,'failed')],now+2001);
 applyAutopilotCommand(d,'pause');applyAutopilotCommand(d,'resume');
 const before=readController(d,k.loadState(d).missionId),res=child('kernel',d),after=k.loadState(d);
 save('multiple-late-resume',{a,b,before,res,after,ledger:readController(d,after.missionId)});
 assert.ok(before.dispatchReconciliations[b.intentId].resolutionId);assert.equal(before.dispatchReconciliations[a.intentId].resolutionId,undefined);
 assert.equal(res.calls.length,0,'Finishing B and resuming does not settle A or grant attempt three');
});

test('Late evidence for a legitimately retargeted key has a supported reconciliation exit',async()=>{
 const d=init('retarget-late');let calls=0;
 const adapter={runFeature:async()=>{calls++;return {accepted:false,code:'PROVIDER_BUSY'};}};
 await k.startMissionRun(d,{},adapter).catch(()=>{});const old=inspectDispatchRecords(d)[0];
 k.updateMissionFeatures(d,{modelSettings:{worker:{providerInstanceId:'codex',model:'new-model',options:{}}}});
 const s=k.loadState(d);k.rejectMissionPlan(d,'Approve the new model without discarding the original invocation');
 k.proposeMission(d,{...s,features:k.loadFeaturesDoc(d).features,modelSettings:k.loadModelSettings(d)});k.approveMissionPlan(d);
 await k.startMissionRun(d,{},adapter).catch(()=>{});const current=inspectDispatchRecords(d)[0];
 assert.equal(calls,2);assert.notEqual(current.intent.clientRequestId,old.intent.clientRequestId);
 const a={featureId:'f1',runId:old.intent.runId,intentId:old.intent.clientRequestId,invocationId:old.invocations[0].invocationId,attempt:1};
 const late=child('tick',d,{now,observations:[obs(a,{accepted:true,taskId:'old-task',childThreadId:'old-thread',childRunId:'old-turn'})]});
 const terminal={type:'task_status',featureId:'f1',runId:a.runId,taskId:'old-task',response:{taskId:'old-task',childThreadId:'old-thread',childRunId:'old-turn',status:'cancelled',workState:'result_available',hasPendingChildRuns:false}};
 const stopped=child('tick',d,{now:now+1000,observations:[terminal]});
 const terminalIds=readObservations(d).filter(x=>x.observation.type==='task_status').map(x=>x.id);
 const resolution=child('resolve',d,{intentId:old.intent.clientRequestId,userConfirmed:true,reason:'The original task is now fully stopped',terminalObservationIds:terminalIds,selectedTaskId:'old-task',selectedChildThreadId:'old-thread'});
 const fresh=child('tick',d,{now:now+2000});
 save('retarget-late',{old,current,calls,late,stopped,resolution,fresh,state:k.loadState(d),observations:readObservations(d)});
 assert.equal(late.ok,true,'Evidence should produce a fenced recovery action, not poison every future MissionTick');
 assert.equal(stopped.ok,true);assert.equal(fresh.ok,true);
});

test('Runtime crash after token commit preserves UNKNOWN across fresh processes',async()=>{
 const d=init('runtime-crash'),a=await first(d);
 const scoped=[];
 for(const payloadOverride of [{missionId:'other-mission'},{runId:'other-run'},
  {feature:{id:'other-feature',clientRequestId:a.intentId,invocationId:a.invocationId}},
  {slotConfig:{...inspectDispatchRecords(d)[0].intent.target,model:'other-model'}}]){
  const response=child('probe-runtime',d,{payloadOverride});scoped.push({payloadOverride,response});
  assert.equal(response.code,'INVALID_DISPATCH_INVOCATION');assert.equal(fs.existsSync(path.join(d,'request-issued.txt')),false);
  assert.equal(inspectDispatchRecords(d)[0].invocations[0].runtimeClaimed,undefined);
 }
 const crashed=child('crash-runtime',d);assert.equal(crashed.status,77);assert.equal(fs.existsSync(path.join(d,'request-issued.txt')),false);
 const before=inspectDispatchRecords(d)[0];assert.equal(before.invocations[0].runtimeClaimed,true);assert.deepEqual(before.invocations[0].receipts,[{}]);
 const replay=child('replay-runtime',d);
 const refusal=child('tick',d,{now,observations:[obs(a,{accepted:false,code:'PROVIDER_BUSY'})]});
 const fresh=child('tick',d,{now:now+1000});
 const empty=child('tick',d,{now:now+2000,observations:[obs(a,{threads:[]},'children')]});
 save('runtime-crash',{a,scoped,crashed,before,replay,refusal,fresh,empty,record:inspectDispatchRecords(d)[0],state:k.loadState(d)});
 assert.equal(replay.code,'INVALID_DISPATCH_INVOCATION');assert.equal(fs.existsSync(path.join(d,'request-issued.txt')),false);
 assert.equal(refusal.result.action.type,'recover_dispatch');assert.equal(fresh.result.action.type,'recover_dispatch');
 assert.equal(empty.result.action.type,'wait_user');assert.equal(k.loadFeaturesDoc(d).features[0].attempts,1);
 assert.equal(dispatchRecordOutcome(d,inspectDispatchRecords(d)[0]).outcome,'UNKNOWN');
});

test('Mixed late success and failure are audit records and normal attempts can finish',async()=>{
 const d=init('late-failure-after-success'),a=await first(d);
 await tick(d,[obs(a,{accepted:false,code:'PROVIDER_BUSY'})]);const b=await tick(d,[],now+1000);
 await tick(d,[obs(b,{accepted:false,code:'PROVIDER_BUSY'})],now+1001);
 const before=JSON.stringify(k.loadState(d).sessions);
 await tick(d,[obs(a,accepted(a)),obs(b,accepted(b))],now+2000);
 const lateSuccess=await tick(d,[result(a)],now+2001);
 assert.equal(lateSuccess.type,'poll');assert.equal(k.loadFeaturesDoc(d).features[0].status,'pending');
 assert.equal(k.loadFeaturesDoc(d).features[0].integration,undefined);
 const action=await tick(d,[result(b,'failure')],now+3002);
 assert.equal(action.type,'dispatch');assert.equal(action.attempt,3);
 const ledger=readController(d,k.loadState(d).missionId),resolutions=Object.values(ledger.dispatchResolutions);
 assert.deepEqual(resolutions.map(r=>r.result.envelope.status).sort(),['failure','success']);
 assert.equal(JSON.stringify(k.loadState(d).sessions.slice(0,2)),before);
 assert.equal(k.loadState(d).lateResultAdoptions,undefined);assert.equal(ledger.lateResults,undefined);
 for(const r of resolutions)assert.equal(typeof r.result.raw,'string');
 await finish(d,action,now+4000);
 save('late-failure-after-success',{a,b,lateSuccess,action,resolutions,state:k.loadState(d)});
});

async function finish(d,action,time){
 for(let i=0;i<4&&action.type==='dispatch';i++){
  const a=action;
  await tick(d,[obs(a,accepted(a))],time++);
  action=await tick(d,[result(a)],time++);
  if(action.kind==='integrate')action=await tick(d,[obs(a,{branch:'main',sourceBranch:'feature/original',commit:'abcdef1234567',mergeSha:'abcdef1234567'},'integration')],time++);
 }
 assert.equal(action.type,'disable_timer');
 await tick(d,[{type:'timer_disabled',requestId:action.requestId,response:{taskId:action.scheduledTaskId,enabled:false}}],time++);
 assert.equal((await tick(d,[],time)).type,'done');
}

test('A full working-status archive still accepts the original terminal proof',async()=>{
 const d=init('status-capacity'),a=await first(d);await tick(d,[obs(a,accepted(a))]);
 missionTransaction(d,()=>{for(let i=0;i<3000;i++)archiveObservation(d,status(a,'running',{progressSequence:i}));});
 const count=readObservations(d).filter(x=>x.observation.runId===a.runId).length;assert.equal(count,2);
 const progress=readObservations(d).find(x=>x.progressCount);assert.equal(progress.progressCount,3000);assert.equal(progress.observation.response.progressSequence,2999);
 const complete=child('tick',d,{now:now+400000000,observations:[result(a)]});
 const bare=child('tick',d,{now:now+400000001});
 save('status-capacity',{count,complete,bare,state:k.loadState(d),feature:k.loadFeaturesDoc(d).features[0]});
 assert.equal(complete.ok,true,'Routine polling must leave a supported path to ingest the terminal result');
});
