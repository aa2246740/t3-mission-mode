import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';import {inspectDispatchRecords} from '../kernel/dispatch-journal.mjs';
const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??process.env.TMPDIR,'a8-r7-')),now=1793000000000;
const tick=async(d,o=[],n=now)=>(await k.missionTick(d,{observations:o,now:n})).action;
const fresh=(d,o=[],n=now)=>JSON.parse(cp.execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)};console.log(JSON.stringify(await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))));`,d,JSON.stringify({observations:o,now:n})],{encoding:'utf8'})).action;
for(const mode of ['same-batch','split','process-restart','pause-resume'])test('An older owner refusal cannot release newer UNKNOWN '+mode,async()=>{
 const d=path.join(root,mode);fs.mkdirSync(d);k.proposeMission(d,{title:'Causal order',repoPath:d,autopilot:true,ownerThreadId:'owner',pauseMode:'let_finish',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1',maxAttempts:3}],retryPolicy:{baseDelayMs:1000,maxDelayMs:10000}});k.approveMissionPlan(d);const t=await tick(d),a=await tick(d,[{type:'timer',requestId:t.requestId,response:{taskId:'timer',enabled:true}}]);
 // This private backend has exactly the requested T3 idempotency semantics.
 const jobs=new Map(),events=[];const backend=(key,accept)=>{if(jobs.has(key)){events.push({key,event:'existing'});return jobs.get(key);}if(!accept){events.push({key,event:'refused'});return {accepted:false,code:'PROVIDER_BUSY'};}const child={accepted:true,taskId:'fixture-task-'+(jobs.size+1),childThreadId:'fixture-child-'+(jobs.size+1)};jobs.set(key,child);events.push({key,event:'accepted',child});return child;};
 const oldReply=backend(a.intentId,false);backend(a.intentId,true); // The later call accepts, but its reply is lost.
 const o=(response)=>({type:'dispatch',runId:a.runId,featureId:a.featureId,intentId:a.intentId,response});
 const newer=o({isError:true,message:'newer invocation response lost',producedAt:'2026-10-26T07:33:20Z'}),older=o({...oldReply,producedAt:'2026-10-26T07:33:00Z'});
 let first;
 if(mode==='same-batch')first=await tick(d,[newer,older]);
 else {applyAutopilotCommand(d,'pause');await tick(d,[newer]);if(mode==='pause-resume'){await tick(d,[older]);applyAutopilotCommand(d,'resume');first=await tick(d);}else{applyAutopilotCommand(d,'resume');first=mode==='process-restart'?fresh(d,[older]):await tick(d,[older]);}}
 const future=fresh(d,[],now+86400000);if(future.type==='dispatch')backend(future.intentId,true);
 fs.writeFileSync(path.join(root,mode+'.json'),JSON.stringify({mode,a,newer,older,events,jobs:[...jobs],first,future,state:k.loadState(d),records:inspectDispatchRecords(d)},null,2));
 assert.equal(jobs.size,1,'The backend deduplicates only the same clientRequestId; an unproven newer outcome must not create a new key');assert.notEqual(future.type,'dispatch');
});
