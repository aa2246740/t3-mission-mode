import {readController} from '../kernel/autopilot-store.mjs';
import {preSendFailure} from '../bridge/t3-adapter.mjs';
import os from "node:os";
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords,dispatchRecordOutcome} from '../kernel/dispatch-journal.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
import {callMissionTool} from '../bridge/mcp-server.mjs';
import {runCli} from '../bridge/cli.mjs';
import {createHandlerHud} from '../test/hud-handler-fixture.mjs';
const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), 'a9-public-invocations-')),now=1793000000000;
const raws={refused:{accepted:false,code:'PROVIDER_BUSY'},accepted:{accepted:true,taskId:'same-task',childThreadId:'same-thread'},empty:{},isError:{isError:true},pending:{pending:true,taskId:'same-task',childThreadId:'same-thread'},lost:undefined,'runtime-accepted':{accepted:true,taskId:'same-task',childThreadId:'same-thread'},'runtime-refused':{accepted:false,code:'PROVIDER_BUSY'},'runtime-unknown':{},presend:{accepted:false,code:'NO_T3_TRANSPORT',preSend:true}};
const tick=async(d,o=[],time=now)=>(await k.missionTick(d,{observations:o,now:time})).action;
const fresh=(d,time)=>JSON.parse(cp.execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],{now:Number(process.argv[2])})).action));`,d,String(time)],{encoding:'utf8'}));
for(const entry of ['kernel','MCP','CLI','HUD-approve','HUD-resume'])test('Real public callback registration '+entry,async t=>{
 for(const n of [1,2,3])for(const [kind,raw] of Object.entries(raws))await t.test(n+' calls ending '+kind,async()=>{
  const label=entry+'-'+n+'-'+kind,d=path.join(root,label);fs.mkdirSync(d);
  if(entry==='HUD-resume'){cp.execFileSync('git',['init','-q',d]);fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');cp.execFileSync('git',['-C',d,'add','.gitignore']);cp.execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@local.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);}
  k.proposeMission(d,{title:'Real callback ownership',repoPath:d,autopilot:false,ownerThreadId:'owner',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1',maxAttempts:5}],retryPolicy:{baseDelayMs:1000,maxDelayMs:1000}});
  if(entry!=='HUD-approve')k.approveMissionPlan(d);
  if(entry==='HUD-resume'){await k.startMissionRun(d);const s=k.loadState(d);s.status='paused';s.pausedAt='legacy';for(const row of [s.activeWorker,...s.sessions]){row.status='paused';for(const key of ['dispatchPending','runtimeTransport','delegatedBy'])delete row[key];}k.saveState(d,s);}
  let calls=0;
  const invoke=async()=>{calls++;const r=inspectDispatchRecords(d)[0];assert.equal(r.invocations.at(-1).phase,'inflight');if(calls<n)return raws.refused;if(kind==='lost')throw new Error('No returned receipt');if(kind.startsWith('runtime-'))throw Object.assign(new Error('Explicit runtime result'),{runtimeResult:raw});if(kind==='presend')throw preSendFailure(Object.assign(new Error('Missing transport before send'),{code:'NO_T3_TRANSPORT'}));return raw;};
  const adapter={runFeature:invoke,resumeWorker:invoke};let h;
  if(entry.startsWith('HUD'))h=await createHandlerHud({missionDir:d,runtimeAdapter:adapter});
  try{for(let i=0;i<n;i++){
   if(entry==='kernel')await k.startMissionRun(d,{},adapter).catch(()=>{});
   else if(entry==='MCP')await callMissionTool('StartMissionRun',{missionDir:d},{dispatchAdapter:adapter}).catch(()=>{});
   else if(entry==='CLI')await runCli(['StartMissionRun','--mission-dir',d],{dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
   else await h.post(entry==='HUD-resume'?'resume':'approve',{commandId:'call-'+i});
  }}finally{if(h)await h.close();}
  const refused=['refused','runtime-refused','presend'].includes(kind),accepted=['accepted','runtime-accepted'].includes(kind);
  const record=inspectDispatchRecords(d)[0],verdict=dispatchRecordOutcome(d,record);
  assert.equal(calls,n);assert.equal(record.invocations.length,n);
  assert.equal(verdict.outcome,refused?'NOT_ACCEPTED':accepted?'ACCEPTED':'UNKNOWN');
  const s=k.loadState(d);s.autopilot=true;k.saveState(d,s);applyAutopilotCommand(d,'resume');
  let action=await tick(d);if(action.type==='ensure_timer')action=await tick(d,[{type:'timer',requestId:action.requestId,response:{taskId:'timer',enabled:true}}]);
  const future=fresh(d,now+1000);
  fs.writeFileSync(path.join(root,label+'.json'),JSON.stringify({entry,n,kind,calls,record,verdict,action,future,state:k.loadState(d)},null,2));
  assert.equal(action.type,refused?'sleep':accepted?'poll':'recover_dispatch');
  assert.equal(future.type,refused?'dispatch':accepted?'poll':'recover_dispatch');
  const budget=readController(d,k.loadState(d).missionId).features?.f1;
  assert.equal(budget?.providerErrors,refused?1:undefined);
  assert.equal(budget?.nextRetryAt,refused?'2026-10-26T07:33:21.000Z':undefined);
  assert.equal(k.loadFeaturesDoc(d).features[0].attempts,refused?2:1);
  assert.equal(inspectDispatchRecords(d).length,refused?2:1);
  assert.equal(calls,n);
 });
});
