import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';
import { mergeInvocationEvidence } from '../kernel/schema.mjs';
import { beginDispatchInvocation, inspectDispatchRecords, dispatchRecordOutcome } from '../kernel/dispatch-journal.mjs';
import { applyAutopilotCommand } from '../kernel/autopilot-commands.mjs';
import { readController } from '../kernel/autopilot-store.mjs';
import { callMissionTool } from '../bridge/mcp-server.mjs';
import { runCli } from '../bridge/cli.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';
const now=1793000000000;
const raw={accepted:{accepted:true,taskId:'same-task',childThreadId:'same-child'},refused:{accepted:false,code:'PROVIDER_BUSY'},isError:{isError:true},empty:{},pending:{pending:true,taskId:'same-task',childThreadId:'same-child'},lost:undefined};
const names=Object.keys(raw);
const vectors=n=>n===0?[[]]:vectors(n-1).flatMap(t=>names.map(name=>[...t,name]));
const permutations=a=>a.length===0?[[]]:a.flatMap((v,i)=>permutations(a.filter((_,j)=>j!==i)).map(t=>[v,...t]));
// Independent oracle uses only the test's six named facts and call attribution.
function oracle(types,arrivals) {
 const owned=types.map(()=>[]);let accepted=false;
 for(const event of arrivals){if(types[event.i]==='accepted')accepted=true;if(event.tagged||types.length===1)owned[event.i].push(types[event.i]);}
 const returned=owned.map(a=>a.length>0);
 return {outcome:accepted?'ACCEPTED':owned.every(a=>a.length>0&&a.every(x=>x==='refused'))?'NOT_ACCEPTED':'UNKNOWN',returned};
}
// These literal minimum cases also protect the oracle from a mistaken premise.
const examples=[
 [['refused','empty'],[{i:1,tagged:true},{i:0,tagged:true}],'UNKNOWN'],
 [['refused','lost'],[{i:0,tagged:true}],'UNKNOWN'],
 [['refused','refused'],[{i:1,tagged:true},{i:0,tagged:true}],'NOT_ACCEPTED'],
 [['refused','refused'],[{i:1,tagged:false},{i:0,tagged:false}],'UNKNOWN'],
 [['accepted','lost'],[{i:0,tagged:false}],'ACCEPTED'],
 [['refused'],[{i:0,tagged:false}],'NOT_ACCEPTED'],
];
for(const [types,arrivals,wanted] of examples)test('A8 literal oracle '+JSON.stringify([types,arrivals]),()=>assert.equal(oracle(types,arrivals).outcome,wanted));

test('A8 exhaustive one to three calls, every result vector, arrival order and legacy attribution mask',()=>{
 const rows=[];let prefixes=0;
 for(let n=1;n<=3;n++)for(const types of vectors(n))for(const order of permutations(types.map((_,i)=>i).filter(i=>types[i]!=='lost')))for(let mask=0;mask<2**order.length;mask++){
  const invocations=types.map((_,i)=>({invocationId:'call-'+i,phase:'inflight',receipts:[]})),unowned=[],arrivals=[];
  for(let j=0;j<=order.length;j++){
   if(j){const i=order[j-1],tagged=Boolean(mask&(1<<(j-1)));arrivals.push({i,tagged});if(tagged||n===1){invocations[i].phase='returned';invocations[i].receipts.push(raw[types[i]]);}else unowned.push(raw[types[i]]);}
   const expected=oracle(types,arrivals),actual=mergeInvocationEvidence(invocations,unowned);
   assert.equal(actual.outcome,expected.outcome,JSON.stringify({types,arrivals}));
   assert.deepEqual(actual.invocations.map(x=>x.phase==='returned'),expected.returned);
   assert.equal(actual.outcome==='NOT_ACCEPTED',expected.outcome==='NOT_ACCEPTED','New key requires every call to be reliably refused');prefixes++;
  }
  rows.push({types,order,mask,outcome:oracle(types,arrivals).outcome});
 }
 if(process.env.R9_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR,'a8-invocation-exhaustive.json'),JSON.stringify({prefixes,cells:rows.length,literalExamples:examples,rows}));
});
const tick=async(d,observations=[],time=now)=>(await k.missionTick(d,{observations,now:time})).action;
async function boot(d){k.proposeMission(d,{title:'Invocation ownership',repoPath:d,autopilot:true,pauseMode:'let_finish',ownerThreadId:'owner',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1',maxAttempts:3}],retryPolicy:{baseDelayMs:1000,maxDelayMs:1000}});k.approveMissionPlan(d);const t=await tick(d);return tick(d,[{type:'timer',requestId:t.requestId,response:{taskId:'timer',enabled:true}}]);}
const fresh=(d,observations=[],time=now)=>JSON.parse(cp.execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)}; console.log(JSON.stringify((await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))).action));`,d,JSON.stringify({observations,now:time})],{encoding:'utf8'}));
async function replay(d,entry,counter){
 const invoke=async()=>{counter.calls++;return raw.accepted;},adapter={runFeature:invoke};
 if(entry==='controller')return;
 if(entry==='kernel')return k.startMissionRun(d,{},adapter).catch(()=>{});
 if(entry==='MCP')return callMissionTool('StartMissionRun',{missionDir:d},{kernel:k,dispatchAdapter:adapter}).catch(()=>{});
 if(entry==='CLI')return runCli(['StartMissionRun','--mission-dir',d],{kernel:k,dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
 const state=k.loadState(d);state.autopilot=false;
 if(entry==='HUD-resume'){
  cp.execFileSync('git',['init','-q',d]);fs.writeFileSync(path.join(d,'.gitignore'),'.mission/\n');cp.execFileSync('git',['-C',d,'add','.gitignore']);cp.execFileSync('git',['-C',d,'-c','user.name=Fixture','-c','user.email=fixture@local.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','fixture']);
  state.status='paused';for(const row of [state.activeWorker,...state.sessions]){row.status='paused';delete row.dispatchPending;delete row.runtimeTransport;}adapter.resumeWorker=invoke;
 }
 k.saveState(d,state);const h=await createHandlerHud({missionDir:d,runtimeAdapter:adapter});try{await h.post(entry==='HUD-resume'?'resume':'approve');}finally{await h.close();}
 const current=k.loadState(d);current.autopilot=true;k.saveState(d,current);applyAutopilotCommand(d,'resume');
}
// Disk-backed transitions cover every pair, three-call unknown/refusal cases,
// accepted dominance, all-refused, missing returns, and both legacy/tagged calls.
const transitions=[['refused','empty'],['empty','refused'],['refused','isError'],['isError','refused'],['pending','refused'],['refused','pending'],['refused','lost'],['refused','refused'],['accepted','lost'],['refused','empty','refused'],['refused','refused','refused'],['refused','accepted','lost']];
async function settleCompensation(d,a,action,mode,controls,resumeAllowed=false) {
 const drive=observations=>mode==='fresh-node'?fresh(d,observations):tick(d,observations);
 if(action.type==='interrupt_worker') {
  controls.interrupts=(controls.interrupts??0)+1;assert.equal(controls.interrupts,1);
  controls.epoch=controls.pauseEpoch;assert.equal(action.threadId,'same-child');
  assert.equal(action.runId,a.runId);assert.equal(action.clientRequestId,a.intentId);
  assert.equal(action.controlId,`${a.runId}:${controls.epoch}:interrupt`);assert.equal(k.loadState(d).status,'paused');
  action=await drive([{type:'interrupt',featureId:a.featureId,runId:a.runId,controlId:action.controlId,response:{interrupted:true,threadId:'same-child'}}]);
 }
 if(action.type==='resume_worker') {
  assert.equal(resumeAllowed,true);controls.resumes=(controls.resumes??0)+1;assert.equal(controls.resumes,1);
  assert.equal(action.threadId,'same-child');assert.equal(action.runId,a.runId);
  assert.equal(action.controlId,`${a.runId}:${controls.epoch}:resume`);assert.equal(k.loadState(d).status,'running');
  action=await drive([{type:'resume',featureId:a.featureId,runId:a.runId,controlId:action.controlId,response:{sent:true,threadId:'same-child'}}]);
 }
 return action;
}
for(const entry of ['controller','kernel','MCP','CLI','HUD-approve','HUD-resume'])for(const mode of ['same-batch','split','fresh-node','pause-resume'])test(`A8 attributed disk transitions ${entry} ${mode}`,async t=>{
 for(const types of transitions)for(const legacy of [false,true])await t.test(types.join('-')+(legacy?' legacy':' tagged'),async()=>{
  const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a8-calls-')),a=await boot(d);
  const intent=inspectDispatchRecords(d)[0].intent,ids=[a.invocationId];
  assert.equal(typeof ids[0],'string');for(let i=1;i<types.length;i++)ids.push(beginDispatchInvocation(d,intent));
  const order=types.map((_,i)=>i).reverse().filter(i=>types[i]!=='lost'),arrivals=order.map(i=>({i,tagged:!legacy}));
  const observations=order.map(i=>({type:'dispatch',featureId:a.featureId,runId:a.runId,intentId:a.intentId,...(legacy?{}:{invocationId:ids[i]}),response:raw[types[i]]}));
  applyAutopilotCommand(d,'pause');const controls={pauseEpoch:1};
  if(mode==='same-batch')await settleCompensation(d,a,await tick(d,observations),mode,controls);
  else for(const o of observations){await settleCompensation(d,a,mode==='fresh-node'?fresh(d,[o]):await tick(d,[o]),mode,controls);if(mode==='pause-resume'){applyAutopilotCommand(d,'resume');applyAutopilotCommand(d,'pause');controls.pauseEpoch++;}}
  const expected=oracle(types,arrivals),record=inspectDispatchRecords(d)[0];
  assert.equal(dispatchRecordOutcome(d,record).outcome,expected.outcome);
  assert.equal(record.invocations.length,types.length);assert.deepEqual(record.invocations.map(row=>row.phase==='returned'),expected.returned);
  const calls={calls:0};applyAutopilotCommand(d,'resume');
  if(controls.interrupts)await settleCompensation(d,a,mode==='fresh-node'?fresh(d):await tick(d),mode,controls,true);
  // Uncertain and accepted replays must never call the executor. Proven refusals
  // are consumed by the controller below, preserving backoff and attempt count.
  if(expected.outcome!=='NOT_ACCEPTED')await replay(d,entry,calls);
  assert.equal(calls.calls,entry==='HUD-resume'&&expected.outcome==='ACCEPTED'?1:0,'Bound Resume confirms the same child; uncertain dispatch never creates one');
  const action=mode==='fresh-node'?fresh(d):await tick(d);
  assert.equal(action.type,expected.outcome==='ACCEPTED'?'poll':expected.outcome==='NOT_ACCEPTED'?'sleep':'recover_dispatch');
  const future=mode==='fresh-node'?fresh(d,[],now+1000):await tick(d,[],now+1000),records=inspectDispatchRecords(d);
  assert.equal(future.type,expected.outcome==='NOT_ACCEPTED'?'dispatch':expected.outcome==='ACCEPTED'?'poll':'recover_dispatch');
  assert.equal(records.some(r=>r.phase==='accepted')&&records.some(r=>r.phase==='inflight'&&r.intent.clientRequestId!==a.intentId),false);
  if(expected.outcome!=='NOT_ACCEPTED'){assert.equal(records.length,1);assert.equal(records[0].intent.clientRequestId,a.intentId);assert.equal(k.loadState(d).activeWorker.runId,a.runId);}else{assert.notEqual(future.intentId,a.intentId);assert.equal(readController(d,k.loadState(d).missionId).features.f1.providerErrors,1);}
 });
});
