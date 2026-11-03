import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const target='candidate';
assert.ok(['candidate','a13'].includes(target));
const from=name=>import(new URL(`../${name}`,import.meta.url));
const k=await from('kernel/index.mjs');
const {applyAutopilotCommand}=await from('kernel/autopilot-commands.mjs');
const {init,tick:baseTick}=await from('test/fixtures/a10-fixture.mjs');
const {fresh,ledger,recordCount}=await from('test/fixtures/a13-fixture.mjs');
const {createHandlerHud}=await from('test/hud-handler-fixture.mjs');
async function setup(t,mode,confirmation){
 const dir=init('r13-lifecycle-'+mode);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=k.loadState(dir);state.pauseMode=mode;k.saveState(dir,state);
 const timer=await baseTick(dir);let pauses=0,resumes=0;let physical='working';
 await k.startMissionRun(dir,{}, {runFeature:async()=>{applyAutopilotCommand(dir,'pause');return {accepted:true,taskId:'r13-task',childThreadId:'r13-child',childRunId:'r13-turn'};},pauseWorker:async()=>{pauses++;physical='paused';return confirmation==='confirmed'?{paused:true,threadId:'r13-child'}:{pending:true};}});
 const first=fresh(dir,'tick',{observations:[{type:'timer',requestId:timer.requestId,response:{taskId:'r13-timer',enabled:true}}]}).result;
 const hud=await createHandlerHud({missionDir:dir,runtimeAdapter:{resumeWorker:async()=>{resumes++;physical='working';return {threadId:'r13-child',resumed:true};}}});
 let reply;try{reply=await hud.post('resume');}finally{await hud.close();}
 const actions=Array.from({length:5},()=>fresh(dir).result);
 const effects=fs.readdirSync(path.join(dir,'.mission/.txn/effects')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'.mission/.txn/effects',n))));
 const raw={target,mode,confirmation,first,reply,actions,pauses,resumes,physical,effects,state:k.loadState(dir),ledger:ledger(dir),dispatches:recordCount(dir)};
 fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR ?? dir,`${target}-${mode}-${confirmation}.json`),JSON.stringify(raw,null,2)+'\n');
 return raw;
}
for(const mode of ['interrupt','let_finish'])for(const confirmation of ['confirmed','pending'])test(`R13 ${target} ${mode} ${confirmation} compensation retains same-child Resume protocol`,async t=>{
 const raw=await setup(t,mode,confirmation);
 assert.equal(raw.pauses,1);assert.equal(raw.reply.status,200);
 if(confirmation==='confirmed'){
  assert.notEqual(raw.first.type,'interrupt_worker','The same Pause epoch has already confirmed its one compensation control');
  assert.ok(raw.actions.some(a=>a.type==='resume_worker'),'A child physically paused by compensation needs the same-child Resume action');
 }else{
  assert.ok(raw.actions.every(a=>!['poll','dispatch','orchestrator_decision'].includes(a.type)),'The unresolved original Pause must remain a control fence after logical Resume');
 }
});
