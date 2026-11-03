import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as k from '../kernel/index.mjs';
import {applyAutopilotCommand} from '../kernel/autopilot-commands.mjs';
import {init,tick as baseTick} from './fixtures/a10-fixture.mjs';
import {fresh,ledger,recordCount,timerReceipt} from './fixtures/a13-fixture.mjs';
const save=(name,value,dir)=>fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR ?? dir,name+'.json'),JSON.stringify(value,null,2)+'\n');
async function compensation(t,mode,response){
 const dir=init('r13-'+mode);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=k.loadState(dir);s.pauseMode=mode;k.saveState(dir,s);
 const timer=await baseTick(dir);let calls=0;
 await k.startMissionRun(dir,{}, {runFeature:async()=>{applyAutopilotCommand(dir,'pause');return {accepted:true,taskId:'r13-original-task',childThreadId:'r13-original-child',childRunId:'r13-original-turn'};},pauseWorker:async()=>{calls++;return response;}});
 const action=fresh(dir,'tick',{observations:[{type:'timer',requestId:timer.requestId,response:{taskId:'r13-original-timer',enabled:true}}]}).result;
 return {dir,action,calls,count:recordCount(dir)};
}
for (const mode of ['let_finish','interrupt']) test(`R13 confirmed compensation needs no second control mode=${mode}`,async t=>{
 const {dir,action,calls,count}=await compensation(t,mode,{paused:true,threadId:'r13-original-child'});
 save('confirmed-'+mode,{action,calls,state:k.loadState(dir),ledger:ledger(dir)},dir);
 assert.equal(calls,1);assert.equal(recordCount(dir),count);assert.equal(action.type,'wait_user');assert.equal(action.reason,'USER_PAUSED');
});
for (const mode of ['let_finish','interrupt']) test(`R13 Resume cannot bypass an unresolved compensating Pause mode=${mode}`,async t=>{
 const {dir,action,calls,count}=await compensation(t,mode,{pending:true});
 assert.equal(action.reason,'WORKER_CONTROL_OUTCOME_UNKNOWN');
 const before=ledger(dir);applyAutopilotCommand(dir,'resume');
 const resumed=fresh(dir).result;
 save('resume-unknown-'+mode,{beforeAction:action,resumed,calls,before,state:k.loadState(dir),after:ledger(dir)},dir);
 assert.equal(calls,1);assert.equal(recordCount(dir),count);
 assert.equal(resumed.type,'wait_user');assert.equal(resumed.reason,'WORKER_CONTROL_OUTCOME_UNKNOWN');
});
