import fs from 'node:fs';
import path from 'node:path';
import * as k from '../../kernel/index.mjs';
import {inspectDispatchRecords, dispatchRuntimeInvocation} from '../../kernel/dispatch-journal.mjs';
import {callMissionTool} from '../../bridge/mcp-server.mjs';
import {runCli} from '../../bridge/cli.mjs';
import {createHandlerHud} from '../hud-handler-fixture.mjs';
const [op,dir,arg='{}']=process.argv.slice(2),input=JSON.parse(arg);
const calls=[];
const adapter={runFeature:async(feature,slot,state)=>{
  const call={runId:feature.runId,key:feature.clientRequestId,invocationId:feature.invocationId};
  calls.push(call);fs.appendFileSync(path.join(dir,'entered.jsonl'),JSON.stringify(call)+'\n');
  return {accepted:true,taskId:'new-task',childThreadId:'new-thread'};
}};
try{
 let result;
 if(op==='all-entries'){
  for(const entry of ['kernel','MCP','CLI','HUD','HUDResume']) {
    try {
      if(entry==='kernel') await k.startMissionRun(dir,{},adapter);
      else if(entry==='MCP') await callMissionTool('StartMissionRun',{missionDir:dir},{dispatchAdapter:adapter});
      else if(entry==='CLI') await runCli(['StartMissionRun','--mission-dir',dir],{dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
      else { const h=await createHandlerHud({missionDir:dir,runtimeAdapter:adapter});try{await h.post(entry==='HUD'?'approve':'resume');}finally{await h.close();} }
    } catch(error) {}
  }
  result={entries:5};
 }else if(op==='tick')result=await k.missionTick(dir,input);
 else if(op==='kernel')result=await k.startMissionRun(dir,{},adapter);
 else if(op==='MCP')result=await callMissionTool('StartMissionRun',{missionDir:dir},{dispatchAdapter:adapter});
 else if(op==='CLI')result=await runCli(['StartMissionRun','--mission-dir',dir],{dispatchAdapter:adapter,stdout:{write(){}},stderr:{write(){}}});
 else if(op==='HUD'){
  const h=await createHandlerHud({missionDir:dir,runtimeAdapter:adapter});
  try{result=await h.post('approve');}finally{await h.close();}
 }else if(op==='resolve')result=k.resolveDispatchEvidence(dir,input);
 else if(op==='crash-runtime'||op==='replay-runtime'||op==='probe-runtime'){
  const record=inspectDispatchRecords(dir)[0];
  const payload={missionId:record.intent.missionId,runId:record.intent.runId,
   feature:{...record.intent.feature,clientRequestId:record.intent.clientRequestId,invocationId:record.invocations[0].invocationId},slotConfig:record.intent.target};
  Object.assign(payload,input.payloadOverride??{});
  result=await dispatchRuntimeInvocation(dir,payload,async()=>{
   if(op==='crash-runtime')process.exit(77);
   fs.appendFileSync(path.join(dir,'request-issued.txt'),'issued\n');
   return {accepted:true,taskId:'runtime-task',childThreadId:'runtime-thread'};
  },()=>{});
 }
 console.log(JSON.stringify({ok:true,result,calls}));
}catch(error){console.log(JSON.stringify({ok:false,code:error.code,message:error.message,calls}));}
