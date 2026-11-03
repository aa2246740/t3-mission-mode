// Migrated from validator-r8/r8-final-matrix.test.mjs. Assertions retain the reviewer's semantics.
import os from 'node:os';
import fs from 'node:fs';import path from 'node:path';import test,{after} from 'node:test';import assert from 'node:assert/strict';
import * as k from '../kernel/index.mjs';
import {callMissionTool} from '../bridge/mcp-server.mjs';
const O=os.tmpdir(), E=process.env.R9_EVIDENCE_DIR || O,rows=[];
const valid={accepted:true,resumed:true,taskId:'matrix-task',childThreadId:'matrix-thread',childRunId:'matrix-child-run',runtimeTransport:'t3-delegate-task'};
const names=['state.json','features.json','model-settings.json','progress_log.jsonl'];
const bytes=d=>Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(d,'.mission',n),'utf8')]));
const journals=d=>fs.readdirSync(path.join(d,'.mission')).filter(n=>/^dispatch-.*\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(d,'.mission',n),'utf8')));
function record(id,fn){test(id,async()=>{const row={id};try{await fn(row);row.pass=true;}catch(e){row.pass=false;row.error=e.stack;throw e;}finally{rows.push(row);fs.appendFileSync(path.join(E,'r8-final-matrix.jsonl'),JSON.stringify(row)+'\n');}});}
after(()=>fs.writeFileSync(path.join(E,'r8-final-matrix.json'),JSON.stringify(rows,null,2)+'\n'));
async function setup(row,mode){const d=fs.mkdtempSync(path.join(O,'matrix-'));row.dir=d;k.proposeMission(d,{repoPath:d,title:'R8 final frozen boundary',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1'}],modelSettings:{skipScrutiny:true,skipUserTesting:true,worker:{providerInstanceId:'codex',model:'gpt-6.1-sol',reasoningEffort:'max'}}});k.approveMissionPlan(d);
 if(mode==='initial')return d;
 await k.startMissionRun(d,{},mode==='attached'?{runFeature:async()=>valid}:{});
 const s=k.loadState(d);s.status='paused';s.pausedAt='old-pause';for(const r of [s.activeWorker,s.sessions[0]]){r.status='paused';if(mode==='legacy'){delete r.dispatchPending;delete r.runtimeTransport;delete r.delegatedBy;}}k.saveState(d,s);return d;
}
async function start(entry,d,mode,hook,pauseWorker){const a=['legacy','attached'].includes(mode)?{resumeWorker:hook}:{runFeature:hook};if(pauseWorker)a.pauseWorker=pauseWorker;return entry==='kernel'?k.startMissionRun(d,{},a):callMissionTool('StartMissionRun',{missionDir:d},{kernel:k,dispatchAdapter:a});}
for(const entry of ['kernel','MCP'])for(const mode of ['initial','pending','legacy','attached'])for(const gate of ['reject','reproposal','handoff','awaiting_input','feature','session','new-pause','completed'])record('Owner bytes after await '+entry+' '+mode+' '+gate,async row=>{
 const d=await setup(row,mode);let calls=0,owner,pauseCalls=0;
 const hook=async()=>{calls++;
  if(gate==='reject')k.rejectMissionPlan(d,'Keep plan approval closed');
  else if(gate==='reproposal')k.proposeMission(d,{repoPath:d,features:k.loadFeaturesDoc(d).features,modelSettings:k.loadModelSettings(d)});
  else if(gate==='completed'){const w=k.loadState(d).activeWorker;k.endFeatureRun(d,{runId:w.runId,featureId:'f1',successState:'success',validatorsPassed:true,handoff:{whatWasImplemented:'The private current feature was fully completed by its owner before the transport callback returned its receipt.'}});}
  else{const s=k.loadState(d);s.revision++;if(gate==='handoff')s.lastHandoffNeedsAttention=true;if(gate==='awaiting_input')s.status='awaiting_input';if(gate==='session')s.sessions[0].featureId='replacement-feature';if(gate==='new-pause'){s.status='paused';s.pausedAt='new-user-pause';s.activeWorker.status='paused';s.sessions[0].status='paused';}k.saveState(d,s);if(gate==='feature'){const doc=k.loadFeaturesDoc(d);doc.features[0].runId='replacement-run';k.saveFeaturesDoc(d,doc);}}
  owner=bytes(d);return valid;
 };
 try{row.result=await start(entry,d,mode,hook,gate==='new-pause'?async worker=>{pauseCalls++;assert.equal(worker.taskId,valid.taskId);return{paused:true};}:undefined);}catch(e){row.thrown={code:e.code,message:e.message};}
 row.calls=calls;row.ownerBytes=owner;row.afterBytes=bytes(d);row.journal=journals(d);assert.equal(calls,1);
 if(gate==='new-pause'){
  const final=k.loadState(d),ownerState=JSON.parse(owner['state.json']);
  assert.equal(pauseCalls,1);assert.equal(final.status,'paused');assert.equal(final.pausedAt,ownerState.pausedAt);
  assert.equal(final.activeWorker.status,'paused');assert.equal(final.sessions[0].status,'paused');
  for(const rec of [final.activeWorker,final.sessions[0],k.loadFeaturesDoc(d).features[0]]){
   for(const key of ['taskId','childThreadId','childRunId'])assert.equal(rec[key],valid[key]);
   for(const key of ['providerInstanceId','model','options'])assert.deepEqual(rec[key],final.activeWorker[key]);
  }
  for(const name of ['model-settings.json','progress_log.jsonl'])assert.equal(row.afterBytes[name],owner[name]);
 }else assert.deepEqual(row.afterBytes,owner);
 if(mode!=='attached')assert.equal(row.journal[0].phase,'accepted');
});
