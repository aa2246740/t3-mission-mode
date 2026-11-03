// Migrated from validator-r8/r8-independent.test.mjs. Assertions retain the reviewer's semantics.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as k from '../kernel/index.mjs';
import {callMissionTool} from '../bridge/mcp-server.mjs';
const O=os.tmpdir(), E=process.env.R9_EVIDENCE_DIR || O,rows=[];
const receipt={accepted:true,resumed:true,taskId:'r8-known-task',childThreadId:'r8-known-thread',runtimeTransport:'t3-delegate-task'};
const names=['state.json','features.json','model-settings.json','progress_log.jsonl'];
const bytes=dir=>Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(dir,'.mission',n),'utf8')]));
function record(id,fn){test(id,async()=>{const row={id};try{await fn(row);row.pass=true;}catch(e){row.pass=false;row.error=e.stack;throw e;}finally{rows.push(row);fs.writeFileSync(path.join(E,'r8-independent.json'),JSON.stringify(rows,null,2)+'\n');}});}
function fixture(row){const dir=fs.mkdtempSync(path.join(O,'independent-'));row.dir=dir;k.proposeMission(dir,{repoPath:dir,title:'R8 independent pre-dispatch gates',features:[{id:'f1',milestoneId:'m1',title:'F1'}],milestones:[{id:'m1'}],modelSettings:{skipScrutiny:true,skipUserTesting:true,worker:{providerInstanceId:'codex',model:'gpt-6.1-sol',reasoningEffort:'max'}}});k.approveMissionPlan(dir);return dir;}
async function start(entry,dir,adapter){return entry==='kernel'?k.startMissionRun(dir,{},adapter):callMissionTool('StartMissionRun',{missionDir:dir},{kernel:k,dispatchAdapter:adapter});}
function journals(dir){return fs.readdirSync(path.join(dir,'.mission')).filter(n=>/^dispatch-.*\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(dir,'.mission',n),'utf8')));}

for(const entry of ['kernel','MCP'])for(const gate of ['awaiting_input','planning','feature-completed','feature-replaced','session-replaced','session-completed','worker-completed'])record('Preexisting gate must prevent executor '+entry+' '+gate,async row=>{
 const dir=fixture(row);await k.startMissionRun(dir);const s=k.loadState(dir),doc=k.loadFeaturesDoc(dir);
 if(['awaiting_input','planning'].includes(gate))s.status=gate;
 if(gate==='feature-completed')doc.features[0].status='completed';
 if(gate==='feature-replaced')doc.features[0].runId='replacement-run';
 if(gate==='session-replaced')s.sessions[0].featureId='replacement-feature';
 if(gate==='session-completed')s.sessions[0].status='completed';
 if(gate==='worker-completed')s.activeWorker.status='completed';
 k.saveState(dir,s);k.saveFeaturesDoc(dir,doc);row.before=bytes(dir);let calls=0;
 try{row.result=await start(entry,dir,{runFeature:async()=>{calls++;return receipt;}});}catch(e){row.thrown={code:e.code,message:e.message};}
 row.calls=calls;row.after=bytes(dir);row.journals=journals(dir);
 assert.equal(calls,0,'A closed or stale run gate must be checked before the child-creating hook');assert.deepEqual(row.after,row.before);
});

for(const entry of ['kernel','MCP'])record('Public reproposal and reapproval cannot dispatch completed replacement '+entry,async row=>{
 const dir=fixture(row);await k.startMissionRun(dir);const old=k.loadState(dir).activeWorker.runId;
 k.proposeMission(dir,{repoPath:dir,title:'Plan updated by owner',features:[{id:'f1',milestoneId:'m1',title:'Already completed replacement',status:'completed'}],modelSettings:k.loadModelSettings(dir)});
 k.approveMissionPlan(dir);row.before=bytes(dir);let calls=0;
 row.result=await start(entry,dir,{runFeature:async()=>{calls++;return receipt;}});row.calls=calls;row.oldRunId=old;row.after=bytes(dir);row.journals=journals(dir);
 assert.equal(calls,0);assert.deepEqual(row.after,row.before);
});
