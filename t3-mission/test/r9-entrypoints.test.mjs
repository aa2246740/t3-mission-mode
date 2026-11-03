import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as k from '../kernel/index.mjs';
import { callMissionTool } from '../bridge/mcp-server.mjs';
import { runCli } from '../bridge/cli.mjs';
import { createMissionHudServer } from '../hud/server.mjs';
import { saveContractEvidence } from './hud-handler-fixture.mjs';
const receipt = { accepted: true, resumed: true, taskId: 'r9-task', childThreadId: 'r9-thread', runtimeTransport: 't3-delegate-task' };
const bytes = d => Object.fromEntries(['state.json','features.json','model-settings.json','progress_log.jsonl'].map(n => [n, fs.readFileSync(path.join(d,'.mission',n),'utf8')]));
const journals = d => fs.readdirSync(path.join(d,'.mission')).filter(n => /^dispatch-.*\.json$/.test(n)).map(n => fs.readFileSync(path.join(d,'.mission',n),'utf8'));
async function fixture(t, mode = 'initial') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(),'r9-entry-'));
  t.after(() => fs.rmSync(d,{recursive:true,force:true}));
  execFileSync('git',['init','-q',d]);
  fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');
  execFileSync('git',['-C',d,'add','.gitignore']);
  execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);
  k.proposeMission(d,{repoPath:d,features:[{id:'f1',milestoneId:'m1'}],modelSettings:{skipScrutiny:true,skipUserTesting:true}});
  k.approveMissionPlan(d);
  if (mode === 'initial') return d;
  await k.startMissionRun(d,{},mode === 'attached' ? {runFeature:async()=>receipt} : {});
  const s = k.loadState(d); s.status='paused'; s.pausedAt='old-pause';
  for (const row of [s.activeWorker,s.sessions[0]]) { row.status='paused'; if(mode==='legacy') delete row.dispatchPending; }
  k.saveState(d,s); return d;
}
async function start(entry,d,adapter) {
  if(entry==='kernel') return k.startMissionRun(d,{},adapter);
  if(entry==='MCP') return callMissionTool('StartMissionRun',{missionDir:d},{kernel:k,dispatchAdapter:adapter});
  return runCli(['StartMissionRun','--mission-dir',d],{kernel:k,dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
}
function closeGate(d,gate) {
  const s=k.loadState(d), doc=k.loadFeaturesDoc(d);
  if(['planning','awaiting_input'].includes(gate)) s.status=gate;
  if(gate==='feature-completed') doc.features[0].status='completed';
  if(gate==='feature-replaced') doc.features[0].runId='replacement';
  if(gate==='session-completed') s.sessions[0].status='completed';
  if(gate==='session-replaced') s.sessions[0].featureId='replacement';
  if(gate==='session-duplicate') s.sessions.push({...s.sessions[0]});
  if(gate==='session-number') s.sessions[0].workerNumber=100;
  if(gate==='worker-completed') s.activeWorker.status='completed';
  if(gate==='handoff') s.lastHandoffNeedsAttention=true;
  k.saveState(d,s); k.saveFeaturesDoc(d,doc);
}
for(const entry of ['kernel','MCP','CLI']) for(const mode of ['pending','legacy','attached'])
for(const gate of ['planning','awaiting_input','feature-completed','feature-replaced','session-completed','session-replaced','session-duplicate','session-number','worker-completed','handoff'])
test(`R9 preflight ${entry} ${mode} ${gate}`,async t=>{
  const d=await fixture(t,mode); closeGate(d,gate); const before=bytes(d), beforeJournal=journals(d); let calls=0;
  const hook=async()=>{calls++;return receipt;}; let result, error;
  try { result=await start(entry,d,{runFeature:hook,resumeWorker:hook}); } catch(e) { error=e; }
  assert.equal(calls,0); assert.deepEqual(bytes(d),before); assert.deepEqual(journals(d),beforeJournal);
  assert.ok(result?.code || result?.result?.code || error?.code, 'A closed gate must return a dispatch reason');
});
for(const entry of ['kernel','MCP','CLI']) for(const status of ['planning','awaiting_input'])
test(`R9 initial preflight ${entry} ${status}`,async t=>{
  const d=await fixture(t); const s=k.loadState(d);s.status=status;k.saveState(d,s);const before=bytes(d);let calls=0;
  await start(entry,d,{runFeature:async()=>{calls++;return receipt;}});
  assert.equal(calls,0);assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),[]);
});
for(const entry of ['kernel','MCP']) for(const mode of ['initial','pending','legacy','attached'])
test(`R9 newer running owner commit ${entry} ${mode}`,async t=>{
 const d=await fixture(t,mode);let owner,calls=0;
 const hook=async()=>{calls++;const s=k.loadState(d);s.revision++;s.status='running';s.activeWorker.status='running';s.sessions[0].status='running';s.ownerDecision='continue under owner';k.saveState(d,s);owner=bytes(d);return receipt;};
 await start(entry,d,{runFeature:hook,resumeWorker:hook});assert.equal(calls,1);assert.deepEqual(bytes(d),owner);
 assert.equal(JSON.parse(journals(d)[0]).phase,'accepted');
});
for(const entry of ['kernel','MCP']) for(const mode of ['initial','pending'])
test(`R9 owner Start reconciles a late Pause receipt ${entry} ${mode}`,async t=>{
 const d=await fixture(t,mode);
 const originalRun=k.loadState(d).activeWorker?.runId;
 const target={slot:'worker',providerInstanceId:'codex',model:'gpt-6.1-sol',options:{reasoningEffort:'max',serviceTier:'priority'}};
 k.saveModelSettings(d,{...k.loadModelSettings(d),worker:target});
 const lateReceipt={...receipt,childRunId:'r9-child-run'};
 let owner,calls=0,instructedRun;
 const pauses=[],resumes=[];
 const hook=async(_feature,slot,state)=>{
   calls++;instructedRun=state.activeWorker.runId;
   assert.deepEqual({slot:slot.slot,providerInstanceId:slot.providerInstanceId,model:slot.model,options:slot.options},target);
   const s=k.loadState(d);s.revision++;s.status='paused';s.pausedAt='new-pause';s.ownerDecision='preserve this Pause';
   for(const row of [s.activeWorker,s.sessions[0]]){row.status='paused';row.pausedAt='new-pause';row.ownerNote='preserve this run note';}
   k.saveState(d,s);k.appendProgressLog(d,{type:'owner_pause',message:'Owner paused during dispatch'});owner=bytes(d);return lateReceipt;
 };
 await start(entry,d,{runFeature:hook,pauseWorker:async worker=>{pauses.push(structuredClone(worker));return {paused:true};}});
 const ownerState=JSON.parse(owner['state.json']),ownerDoc=JSON.parse(owner['features.json']);
 const acceptedJournal=journals(d),journal=JSON.parse(acceptedJournal[0]);
 saveContractEvidence(`entrypoint-${entry}-${mode}`,{entry,mode,calls,pauses,owner,actual:bytes(d),journal,instructedRun,originalRun});
 assert.equal(calls,1);assert.equal(acceptedJournal.length,1);assert.equal(journal.phase,'accepted');
 if(originalRun)assert.equal(instructedRun,originalRun);
 assert.equal(journal.intent.runId,instructedRun);
 assert.deepEqual(journal.intent.target,{providerInstanceId:'codex',model:'gpt-6.1-sol',options:{reasoningEffort:'max',serviceTier:'priority'}});
 const identity={taskId:'r9-task',childThreadId:'r9-thread',childRunId:'r9-child-run',runtimeTransport:'t3-delegate-task',clientRequestId:journal.intent.clientRequestId};
 for(const key of ['taskId','childThreadId','childRunId'])assert.equal(journal.receipt[key],identity[key]);
 const expectedWorker={...ownerState.activeWorker,...identity,...target};delete expectedWorker.dispatchPending;
 const expectedSession={...ownerState.sessions[0],...identity,...target};delete expectedSession.dispatchPending;
 const expectedFeature={...ownerDoc.features[0],...identity,...target,target:journal.intent.target};delete expectedFeature.dispatchPending;
 assert.equal(pauses.length,1);assert.deepEqual(pauses[0],expectedWorker);
 assert.deepEqual(k.loadState(d),{...ownerState,revision:ownerState.revision+1,activeWorker:expectedWorker,sessions:[expectedSession]});
 assert.deepEqual(k.loadFeaturesDoc(d),{...ownerDoc,features:[expectedFeature]});
 assert.equal(bytes(d)['model-settings.json'],owner['model-settings.json']);
 assert.equal(bytes(d)['progress_log.jsonl'],owner['progress_log.jsonl']);
 await start(entry,d,{runFeature:hook,resumeWorker:async worker=>{resumes.push(structuredClone(worker));return {resumed:true,...identity};}});
 assert.equal(calls,1);assert.equal(pauses.length,1);assert.deepEqual(resumes,[expectedWorker]);
 const resumed=k.loadState(d);assert.equal(resumed.status,'running');assert.equal(resumed.sessions.length,1);
 saveContractEvidence(`entrypoint-${entry}-${mode}-resumed`,{entry,mode,calls,pauses,resumes,resumed,journal:journals(d)});
 for(const row of [resumed.activeWorker,resumed.sessions[0],k.loadFeaturesDoc(d).features[0]]){
   assert.equal(row.runId,instructedRun);assert.equal(row.status,'running');
   for(const [key,value] of Object.entries({...identity,...target}))assert.deepEqual(row[key],value);
 }
 assert.equal(bytes(d)['model-settings.json'],owner['model-settings.json']);
 assert.equal(bytes(d)['progress_log.jsonl'].startsWith(owner['progress_log.jsonl']),true);
 assert.deepEqual(journals(d),acceptedJournal);
});
// Exercise the actual HUD request handler without opening a socket. This is route evidence, not HTTP acceptance.
async function route(d, action, adapter) {
 const original=http.Server.prototype.listen;
 http.Server.prototype.listen=function(){queueMicrotask(()=>this.emit('listening'));return this;};
 let hud;
 try { hud=await createMissionHudServer({missionDir:d,port:0,dispatchAdapter:adapter}); }
 finally { http.Server.prototype.listen=original; }
 try {
  return await new Promise((resolve,reject)=>{
   const req=Readable.from([Buffer.from('{}')]);req.method='POST';req.url='/api/mission/'+action;req.headers={host:'127.0.0.1','content-type':'application/json'};
   const res={writeHead(status){this.status=status;},end(body){try{resolve({status:this.status,body:JSON.parse(body)});}catch(e){reject(e);}},setHeader(){}};
   hud.server.emit('request',req,res);
  });
 } finally { await hud.close(); }
}
for(const action of ['approve','resume']) for(const mode of ['pending','legacy','attached'])
for(const gate of ['feature-completed','feature-replaced','session-completed','session-replaced','session-duplicate','session-number','worker-completed','handoff'])
test(`R9 HUD handler preflight ${action} ${mode} ${gate}`,async t=>{
 const d=await fixture(t,mode);closeGate(d,gate);const before=bytes(d), beforeJournal=journals(d);let calls=0;
 const hook=async()=>{calls++;return receipt;};const r=await route(d,action,{runFeature:hook,resumeWorker:hook,startMissionRun:hook});
 assert.equal(calls,0);assert.equal(r.status,409);assert.ok(r.body.code);assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),beforeJournal);
});
test('R9 HUD handler all-completed plan needs no executor',async t=>{
 const d=await fixture(t);const doc=k.loadFeaturesDoc(d);doc.features[0].status='completed';k.saveFeaturesDoc(d,doc);let calls=0;
 const r=await route(d,'approve',{startMissionRun:async()=>{calls++;return receipt;}});assert.equal(calls,0);assert.equal(r.status,200);
});
for(const gate of ['planning','awaiting_input','handoff','feature-completed','feature-replaced','active-worker'])
test(`R9 direct feature dispatch preflight ${gate}`,async t=>{
 const d=await fixture(t);const candidate=k.loadFeaturesDoc(d).features[0];
 const s=k.loadState(d);s.status='running';k.saveState(d,s);
 if(gate==='active-worker') await k.startMissionRun(d);
 else if(gate.startsWith('feature-')){const doc=k.loadFeaturesDoc(d);if(gate==='feature-completed')doc.features[0].status='completed';else doc.features[0].title='replaced';k.saveFeaturesDoc(d,doc);}
 else {const state=k.loadState(d);if(gate==='handoff')state.lastHandoffNeedsAttention=true;else state.status=gate;k.saveState(d,state);}
 const before=bytes(d), beforeJournal=journals(d);let calls=0;
 const result=await k.dispatchFeatureToWorker(d,candidate,0,k.loadModelSettings(d),{runFeature:async()=>{calls++;return receipt;}});
 assert.equal(calls,0);assert.equal(result.code,'MISSION_NOT_DISPATCHABLE');assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),beforeJournal);
});
for(const gate of ['planning','awaiting_input','feature-completed','session-duplicate'])
test(`R9 raw runtime CLI Mission gate ${gate}`,async t=>{
 const d=await fixture(t,'pending');closeGate(d,gate);const s=k.loadState(d),before=bytes(d),beforeJournal=journals(d);
 const result=await runCli(['DispatchWorkerRuntime','--mission-dir',d,'--json',JSON.stringify({missionId:s.missionId,runId:s.activeWorker.runId,feature:{id:'f1'},slotConfig:k.loadModelSettings(d).worker})],{stdout:{write(){}},stderr:{write(){}}});
 assert.equal(result.result.code,'MISSION_NOT_DISPATCHABLE');assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),beforeJournal);
});
for(const change of ['none','new-pause','owner-revision'])
test(`R9 staged runtime CLI preserves ${change}`,async t=>{
 const d=await fixture(t,'pending'),state=k.loadState(d),paths=k.getMissionPaths(d);
 const {createHash}=await import('node:crypto');
 const base=Object.fromEntries(['statePath','featuresPath','modelSettingsPath','progressLogPath'].map(key=>[key,createHash('sha256').update(fs.readFileSync(paths[key])).digest('hex')]));
 const payload={missionId:state.missionId,runId:state.activeWorker.runId,feature:k.loadFeaturesDoc(d).features[0],slotConfig:k.loadModelSettings(d).worker,dispatchPreflight:{state,features:k.loadFeaturesDoc(d).features,base}};
 if(change!=='none'){const s=k.loadState(d);s.revision++;if(change==='new-pause')s.pausedAt='late-owner-pause';k.saveState(d,s);}
 const before=bytes(d),beforeJournal=journals(d);
 const result=await runCli(['DispatchWorkerRuntime','--mission-dir',d,'--json',JSON.stringify(payload)],{stdout:{write(){}},stderr:{write(){}}});
 assert.equal(result.result.code,change==='none'?'NO_T3_TRANSPORT':'MISSION_NOT_DISPATCHABLE');
 if(change!=='none')assert.equal(result.result.reason,'MISSION_STATE_CHANGED');
 assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),beforeJournal);
});
test('R9 default HUD handler and CLI accept a valid initial staged dispatch',async t=>{
 const d=await fixture(t);const r=await route(d,'approve');assert.equal(r.status,200);assert.equal(k.loadState(d).activeWorker.dispatchPending,true);
});
for(const gate of ['orphaned-running-feature','duplicate-feature'])
test(`R9 initial inconsistent selection ${gate}`,async t=>{
 const d=await fixture(t);const doc=k.loadFeaturesDoc(d);
 if(gate==='orphaned-running-feature')doc.features[0].status='running';else doc.features.push({...doc.features[0]});
 k.saveFeaturesDoc(d,doc);const before=bytes(d);let calls=0;
 const result=await k.startMissionRun(d,{}, {runFeature:async()=>{calls++;return receipt;}});
 assert.equal(calls,0);assert.equal(result.code,'MISSION_NOT_DISPATCHABLE');assert.deepEqual(bytes(d),before);assert.deepEqual(journals(d),[]);
});
