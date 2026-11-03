import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as k from '../kernel/index.mjs';
const root=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(),'a7-recovery-coordinate-'));
for(const change of ['title','owner']) test('Recovery preserves original '+change,async()=>{
 const dir=path.join(root,change);fs.mkdirSync(dir);
 k.proposeMission(dir,{title:'Coordinates',repoPath:dir,autopilot:true,ownerThreadId:'original-owner',milestones:[{id:'m1'}],features:[{id:'f1',title:'Original title',milestoneId:'m1'}]});k.approveMissionPlan(dir);
 let a=(await k.missionTick(dir)).action;
 const dispatch=(await k.missionTick(dir,{observations:[{type:'timer',requestId:a.requestId,response:{taskId:'timer',enabled:true}}]})).action;
 const obs=response=>({type:'dispatch',featureId:dispatch.featureId,runId:dispatch.runId,intentId:dispatch.intentId,response});
 await k.missionTick(dir,{observations:[obs({isError:true,message:'lost reply'})]});
 if(change==='title')k.updateMissionFeatures(dir,{updateFeatures:[{id:'f1',title:'Renamed after dispatch'}]});
 else {const s=k.loadState(dir); k.rejectMissionPlan(dir,'Transfer owner explicitly');k.proposeMission(dir,{...s,ownerThreadId:'new-owner',features:k.loadFeaturesDoc(dir).features});k.approveMissionPlan(dir);}
 const recovery=(await k.missionTick(dir)).action;
 const originalChild={taskId:'original-task',childThreadId:'original-child',clientRequestId:dispatch.intentId,parentThreadId:'original-owner',title:dispatch.delegateTask.title};
 const page={threads:[originalChild].filter(x=>x.title.includes(recovery.t3ThreadList.titleContains))};
 const after=(await k.missionTick(dir,{observations:[{type:'children',featureId:dispatch.featureId,runId:dispatch.runId,intentId:dispatch.intentId,response:page}]})).action;
 fs.writeFileSync(path.join(root,change+'.json'),JSON.stringify({dispatch,recovery,originalChild,page,after,state:k.loadState(dir)},null,2));
 assert.equal(after.type,'poll','An unchanged original child must remain recoverable after a plan metadata edit');
 assert.equal(after.taskId,'original-task');
});
