import os from "node:os";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords} from '../kernel/dispatch-journal.mjs';
import {readController,readObservations} from '../kernel/autopilot-store.mjs';
import {callMissionTool} from '../bridge/mcp-server.mjs';
import {createT3Adapter} from '../bridge/t3-adapter.mjs';
import {runCli} from '../bridge/cli.mjs';
const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), 'a9-direct-runtime-same-key-')),now=1793000000000;
const ledger=d=>readController(d,k.loadState(d).missionId);
const snapshot=d=>({state:k.loadState(d),features:k.loadFeaturesDoc(d),records:inspectDispatchRecords(d),ledger:ledger(d)});
const dump=(n,v)=>fs.writeFileSync(path.join(root,n+'.json'),JSON.stringify(v,null,2));
const tick=async(d,observations=[],time=now)=>(await k.missionTick(d,{observations,now:time})).action;
const obs=(a,response,type='dispatch')=>({type,runId:a.runId,featureId:a.featureId,intentId:a.intentId,...(type==='dispatch'?{invocationId:a.invocationId}:{}),response});
const accept=(task,child=task+'-thread',extra={})=>({accepted:true,taskId:task,childThreadId:child,...extra});
const status=(a,task,kind,extra={})=>({...obs(a,{taskId:task,childThreadId:task+'-thread',status:kind,workState:kind==='running'?'working':'result_available',hasPendingChildRuns:false,...extra},'task_status'),taskId:task});
function propose(d){k.proposeMission(d,{title:'Independent R8 boundary',repoPath:d,autopilot:true,pauseMode:'let_finish',ownerThreadId:'owner',milestones:[{id:'m1'}],features:[{id:'f1',milestoneId:'m1',maxAttempts:6}],retryPolicy:{baseDelayMs:1000,maxDelayMs:1000,maxConsecutiveProviderErrors:10},integration:{branch:'main',auto:true}});k.approveMissionPlan(d);}
async function boot(name){const d=path.join(root,name);fs.mkdirSync(d);propose(d);const t=await tick(d),a=await tick(d,[{type:'timer',requestId:t.requestId,response:{taskId:'timer',enabled:true}}]);assert.equal(a.type,'dispatch');return {d,a};}
const fresh=(d,time=now)=>JSON.parse(cp.execFileSync(process.execPath,['--input-type=module','-e',`import * as k from ${JSON.stringify(new URL('../kernel/index.mjs',import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],{now:Number(process.argv[2])})).action));`,d,String(time)],{encoding:'utf8'}));
function result(a,success=true){return {version:1,featureId:a.featureId,runId:a.runId,status:success?'success':'failure',summary:'This independently generated result records completed original work and literal verification evidence for this exact Mission run identity.',tests:success?[{command:'private-product-check',status:'passed'}]:[],discoveredIssues:[],whatWasLeftUndone:[],commit:success?'abcdef1234567':null,branch:success?'feature/original':null};}
const fenced=e=>'```mission-result\n'+JSON.stringify(e)+'\n```';

test('Direct DispatchWorkerRuntime cannot escape invocation accounting',async()=>{
 const {d,a}=await boot('direct-runtime');
 const fixture=path.join(d,'private-transport.mjs'),jobs=path.join(d,'private-jobs.json');
 fs.writeFileSync(fixture,`import fs from 'node:fs';const arg=JSON.parse(process.argv.at(-1));fs.writeFileSync(${JSON.stringify(jobs)},JSON.stringify([{key:arg.clientRequestId,taskId:'accepted-but-reply-lost'}]));console.log('{}');`);
 const saved={node:process.env.T3_ACP_MCP_NODE,entry:process.env.T3_ACP_MCP_ENTRYPOINT};
 process.env.T3_ACP_MCP_NODE=process.execPath;process.env.T3_ACP_MCP_ENTRYPOINT=fixture;
 let runtime;
 try{const state=k.loadState(d),feature=k.loadFeaturesDoc(d).features.find(f=>f.id===a.featureId);runtime=await runCli(['DispatchWorkerRuntime','--mission-dir',d,'--json',JSON.stringify({missionId:state.missionId,feature:{...feature,clientRequestId:a.intentId},slotConfig:state.activeWorker,runId:a.runId,repoPath:d})],{stdout:{write(){}},stderr:{write(){}}});}
 finally{for(const [key,v] of [['T3_ACP_MCP_NODE',saved.node],['T3_ACP_MCP_ENTRYPOINT',saved.entry]])if(v===undefined)delete process.env[key];else process.env[key]=v;}
 assert.equal(fs.existsSync(jobs),false,'No runtime request may enter transport without the outer invocation token');
 assert.equal(runtime.code,'INVALID_DISPATCH_INVOCATION');
 const before=snapshot(d);await tick(d,[obs(a,{accepted:false,code:'PROVIDER_BUSY'})]);
 const next=fresh(d,now+1000);
 dump('direct-runtime',{a,runtime,before,next,after:snapshot(d)});
 assert.equal(next.type,'dispatch','Only the accounted original refusal may release this intent; the rejected runtime made no call');

});
