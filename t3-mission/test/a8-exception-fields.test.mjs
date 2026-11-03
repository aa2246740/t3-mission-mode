import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';import { inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';import { createHandlerHud } from './hud-handler-fixture.mjs';
const accepted={accepted:true,taskId:'real-task',childThreadId:'real-child',runtimeTransport:'t3-delegate-task'};
const rows=[
 {name:'diagnostic-identity',fields:{taskId:'diagnostic-task',childThreadId:'diagnostic-child'},phase:'inflight',next:409,calls:1},
 {name:'diagnostic-refusal',fields:{dispatchOutcome:'rejected'},phase:'inflight',next:409,calls:1},
 {name:'explicit-accepted',fields:{runtimeResult:accepted},phase:'accepted',next:200,calls:1},
 {name:'explicit-rejected',fields:{runtimeResult:{accepted:false,code:'PROVIDER_BUSY'}},phase:'retryable',next:200,calls:2},
 {name:'explicit-unknown',fields:{runtimeResult:{}},phase:'inflight',next:409,calls:1},
 {name:'ordinary',fields:{},phase:'inflight',next:409,calls:1},
];
const projections=d=>{const state=k.loadState(d);return [state.activeWorker,state.sessions[0],k.loadFeaturesDoc(d).features[0]];};
for(const action of ['approve','resume'])for(const hook of ['runtime','start-hook'])for(const row of rows)test(`A8 exception ${action} ${hook} ${row.name}`,async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a8-throw-'));cp.execFileSync('git',['init','-q',d]);fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');cp.execFileSync('git',['-C',d,'add','.gitignore']);cp.execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@local.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);
 k.proposeMission(d,{title:'Thrown metadata',repoPath:d,features:[{id:'f1'}]});
 if(action==='resume'){k.approveMissionPlan(d);await k.startMissionRun(d);const state=k.loadState(d);state.status='paused';state.pausedAt='legacy';for(const p of [state.activeWorker,...state.sessions]){p.status='paused';delete p.dispatchPending;delete p.runtimeTransport;delete p.delegatedBy;}k.saveState(d,state);}
 let calls=0;const invoke=async()=>{calls++;const record=inspectDispatchRecords(d)[0];assert.equal(record.invocations.at(-1).phase,'inflight');throw Object.assign(new Error('Actual callback failed'),row.fields);};
 const key=hook==='start-hook'?'startMissionRun':action==='approve'?'runFeature':'resumeWorker';let h=await createHandlerHud({missionDir:d,runtimeAdapter:{[key]:invoke}});
 let first;try{first=await h.post(action,{commandId:'first'});}finally{await h.close();}
 let record=inspectDispatchRecords(d)[0];assert.equal(first.status,500);assert.equal(record.phase,row.phase);assert.equal(record.lastOutcome.hookFailed,true);assert.equal(record.lastOutcome.hookSource,key);assert.equal(record.invocations.length,1);assert.equal(record.invocations[0].phase,Object.hasOwn(row.fields,'runtimeResult')?'returned':'inflight');
 if(row.name==='diagnostic-identity'){assert.equal(record.invocations[0].exception.executionEvidence.taskId,'diagnostic-task');assert.equal(record.receipt,undefined);}
 for(const p of projections(d)){assert.notEqual(p.taskId,'diagnostic-task');assert.notEqual(p.childThreadId,'diagnostic-child');}
 h=await createHandlerHud({missionDir:d,runtimeAdapter:{[key]:async()=>{calls++;return accepted;}}});let second;try{second=await h.post(action,{commandId:'second'});}finally{await h.close();}
 assert.equal(second.status,row.next);assert.equal(calls,row.calls);record=inspectDispatchRecords(d)[0];assert.equal(record.phase,row.phase==='inflight'?'inflight':'accepted');
 for(const p of projections(d)){assert.equal(p.taskId,row.phase==='inflight'?undefined:'real-task');assert.notEqual(p.childThreadId,'diagnostic-child');}
 if(process.env.R9_EVIDENCE_DIR)fs.writeFileSync(path.join(d,'exception-matrix.json'),JSON.stringify({action,hook,case:row.name,first,second,calls,record,projections:projections(d)},null,2));
});
