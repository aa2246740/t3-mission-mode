import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';
import { inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';
const bytes=d=>Object.fromEntries(['state.json','features.json','model-settings.json','progress_log.jsonl'].map(file=>[file,fs.readFileSync(path.join(d,'.mission',file),'utf8')]));
const cases=[
 {name:'throw',status:500,phase:'inflight',calls:1},
 {name:'empty-unknown',status:409,phase:'inflight',calls:1,raw:{}},
 {name:'null-unknown',status:409,phase:'inflight',calls:1,raw:null},
 {name:'unknown',status:409,phase:'inflight',calls:1,raw:{pending:true,taskId:'possible-task',childThreadId:'possible-child'}},
 {name:'conflict',status:500,phase:'inflight',calls:1,raw:{taskId:'one',response:{taskId:'two'},childThreadId:'child'}},
 {name:'target-conflict',status:500,phase:'inflight',calls:1,raw:{taskId:'one',childThreadId:'child',model:'foreign-model'}},
 {name:'onCommand-throw',status:500,phase:null,calls:0},
];
for(const action of ['approve','resume'])for(const adapter of ['default','custom','start-hook'])for(const row of cases)test(`A7 HUD status ${action} ${adapter} ${row.name}`,async t=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-status-'));
 cp.execFileSync('git',['init','-q',d]);fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');cp.execFileSync('git',['-C',d,'add','.gitignore']);cp.execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);
 k.proposeMission(d,{title:'HUD error provenance',repoPath:d,features:[{id:'f1'}]});
 if(action==='resume') {
  k.approveMissionPlan(d);await k.startMissionRun(d);const state=k.loadState(d);state.status='paused';state.pausedAt='legacy';for(const record of [state.activeWorker,...state.sessions]){record.status='paused';delete record.dispatchPending;delete record.runtimeTransport;delete record.delegatedBy;}k.saveState(d,state);
 }
 const before=bytes(d);let calls=0,notifyCalls=0,atCallback;
 const invoke=async()=>{calls++;atCallback=bytes(d);if(row.name==='throw')throw new Error('Actual callback exception');return row.raw;};
 const original=cp.execFile;
 if(adapter==='default')cp.execFile=(...args)=>{calls++;atCallback=bytes(d);const callback=args.at(-1);queueMicrotask(()=>row.name==='throw'?callback(new Error('Actual default callback exception'),'','plain process failure'):callback(null,JSON.stringify(row.raw),''));};
 const options={missionDir:d,...(row.name==='onCommand-throw'?{onCommand:async()=>{notifyCalls++;throw new Error('Actual onCommand exception');}}:{})};
 if(adapter==='custom')options.runtimeAdapter={[action==='approve'?'runFeature':'resumeWorker']:invoke};
 if(adapter==='start-hook')options.runtimeAdapter={startMissionRun:invoke};
 const hud=await createHandlerHud(options);let reply;
 try{reply=await hud.post(action,{commandId:'one'});}finally{await hud.close();cp.execFile=original;}
 const records=inspectDispatchRecords(d),after=bytes(d);
 assert.equal(reply.status,row.status);assert.equal(calls,row.calls);assert.equal(notifyCalls,row.name==='onCommand-throw'?1:0);assert.equal(records[0]?.phase??null,row.phase);
 assert.deepEqual(after,action==='resume'||row.name==='onCommand-throw'?before:atCallback,'A failure preserves the last durable business bytes');
 if(row.name==='throw') {assert.equal(records[0].lastOutcome.hookFailed,true);assert.equal(records[0].lastOutcome.hookSource,adapter==='start-hook'?'startMissionRun':action==='approve'?'runFeature':'resumeWorker');}
 if(row.name!=='onCommand-throw') {
  // Reopen through a new handler; no uncertain dispatch callback can repeat.
  let repeats=0;const again=await createHandlerHud({missionDir:d,runtimeAdapter:{runFeature:async()=>{repeats++;return {};},resumeWorker:async()=>{repeats++;return {};},startMissionRun:async()=>{repeats++;return {};}}});
  try{await again.post(action,{commandId:'two'});}finally{await again.close();}
  assert.equal(repeats,0);assert.equal(inspectDispatchRecords(d)[0].phase,'inflight');assert.deepEqual(bytes(d),after);
 }
 fs.writeFileSync(path.join(d,'evidence.json'),JSON.stringify({action,adapter,expected:row,reply,calls,notifyCalls,before,atCallback,after,records},null,2));
});

test('A7 hook origin marking preserves an accepted runtimeResult on the thrown error',async()=>{
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a7-throw-accepted-'));k.proposeMission(d,{title:'Thrown receipt evidence',repoPath:d,features:[{id:'f1'}]});let calls=0;
 const hud=await createHandlerHud({missionDir:d,runtimeAdapter:{runFeature:async()=>{calls++;throw Object.assign(new Error('Failure after acceptance'),{runtimeResult:{accepted:true,taskId:'accepted-task',childThreadId:'accepted-child',runtimeTransport:'t3-delegate-task'}});}}});
 try{const response=await hud.post('approve');assert.equal(response.status,500);assert.equal(calls,1);assert.equal(inspectDispatchRecords(d)[0].phase,'accepted');assert.equal(inspectDispatchRecords(d)[0].receipt.taskId,'accepted-task');}
 finally{await hud.close();}
 let repeats=0;const replay=await createHandlerHud({missionDir:d,runtimeAdapter:{runFeature:async()=>{repeats++;return {};}}});
 try{assert.equal((await replay.post('approve')).status,200);}finally{await replay.close();}
 assert.equal(repeats,0);assert.equal(k.loadState(d).activeWorker.taskId,'accepted-task');assert.equal(k.loadState(d).sessions.length,1);
});
