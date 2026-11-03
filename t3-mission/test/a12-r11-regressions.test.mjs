import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as k from '../kernel/index.mjs';
import {inspectDispatchRecords} from '../kernel/dispatch-journal.mjs';
import {readController,readObservations} from '../kernel/autopilot-store.mjs';
import {init,first,tick,now,observation,accepted,status,fresh,reapprove,ledger} from './fixtures/a10-fixture.mjs';
const save=(name,x)=>fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR,name+'.json'),JSON.stringify(x,null,2)+'\n');

test('R11 durable unprocessed status survives identity ambiguity after archive crash',async()=>{
 const d=init('archive-crash');
 await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>({accepted:false,code:'PROVIDER_BUSY'})}));
 const old=inspectDispatchRecords(d)[0];reapprove(d,'replacement-model');
 await k.startMissionRun(d,{}, {runFeature:async()=>({accepted:true,taskId:'shared-task',childThreadId:'shared-thread',childRunId:'shared-turn'})});
 const current=inspectDispatchRecords(d)[0];
 const a={featureId:'f1',runId:current.intent.runId,intentId:current.intent.clientRequestId,...current.receipt};
 const untagged=status(a,'running');delete untagged.intentId;
 const child=cp.spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/a12-archive-crash-child.mjs',import.meta.url)),d,JSON.stringify([untagged])],{encoding:'utf8'});
 assert.equal(child.status,77,child.stderr);
 const rows=readObservations(d),before=ledger(d);
 const persisted=rows.find(r=>r.observation.type==='task_status');
 assert.ok(persisted);assert.equal(before.observations[persisted.id],undefined);
 const historical={...a,intentId:old.intent.clientRequestId,invocationId:old.invocations[0].invocationId};
 const replies=[];
 replies.push(fresh(d,'tick',{observations:[observation(historical,accepted(historical))],now:now+1001}));
 replies.push(fresh(d,'tick',{observations:[status(historical,'cancelled')],now:now+1002}));
 replies.push(fresh(d,'tick',{observations:[status(a,'running')],now:now+1003}));
 replies.push(fresh(d,'tick',{now:now+1004}));
 save('archive-crash-ambiguous',{d,old,current,untagged,archiveCrash:{exit:child.status,stderr:child.stderr},persisted,before,replies,after:ledger(d),rows:readObservations(d)});
 assert.equal(replies[1].ok,true,'Explicit historical proof must allow supported recovery after an interrupted raw-archive commit');
 assert.equal(replies[2].ok,true,'Explicit current status must allow supported recovery');
 assert.equal(replies[3].ok,true,'A prior unowned archive must not poison all future ticks');
});

for (const kind of ['no-crash','no-new-identity'])test('R11 archive ambiguity positive control '+kind,async()=>{
 const d=init('archive-positive-'+kind);
 await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>({accepted:false,code:'PROVIDER_BUSY'})}));
 const old=inspectDispatchRecords(d)[0];reapprove(d,'replacement-model');
 await k.startMissionRun(d,{}, {runFeature:async()=>({accepted:true,taskId:'shared-task',childThreadId:'shared-thread',childRunId:'shared-turn'})});
 const current=inspectDispatchRecords(d)[0],a={featureId:'f1',runId:current.intent.runId,intentId:current.intent.clientRequestId,...current.receipt};
 const untagged=status(a,'running');delete untagged.intentId;
 if(kind==='no-crash')await tick(d,[untagged],now+1000);
 else {
  const child=cp.spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/a12-archive-crash-child.mjs',import.meta.url)),d,JSON.stringify([untagged])],{encoding:'utf8'});
  assert.equal(child.status,77,child.stderr);
 }
 const historical={...a,intentId:old.intent.clientRequestId,invocationId:old.invocations[0].invocationId};
 const replies=kind==='no-crash'?[fresh(d,'tick',{observations:[observation(historical,accepted(historical))],now:now+1001}),fresh(d,'tick',{observations:[status(historical,'cancelled')],now:now+1002})]:[fresh(d,'tick',{now:now+1001})];
 save('archive-positive-'+kind,{d,replies,ledger:ledger(d)});
 for(const r of replies)assert.equal(r.ok,true);
});

for (const shape of ['canonical','encoded','thread-alias'])for(const tagged of [false,true])test('R11 same-batch recovery ownership '+shape+' tagged='+tagged,async()=>{
 const d=init('recovery-index-'+shape+'-'+tagged),a=await first(d);
 await tick(d,[observation(a,{})],now+1000);
 const suffix=':delegated-task:'+encodeURIComponent('command:mcp:original-owner:delegate-task:'+a.intentId);
 const taskId=shape==='encoded'?'node'+suffix:'recovered-task',threadId=shape==='encoded'?'thread'+suffix:'recovered-thread';
 const child=shape==='canonical'?{taskId,childThreadId:threadId,clientRequestId:a.intentId,parentThreadId:'owner'}:
  shape==='thread-alias'?{taskId,threadId,clientRequestId:a.intentId,parentThreadId:'owner'}:{id:threadId,parentThreadId:'owner'};
 const task=status({...a,taskId,childThreadId:threadId},'running');if(!tagged)delete task.intentId;
 const before=readObservations(d);
 const reply=fresh(d,'tick',{now:now+1001,observations:[observation(a,{threads:[child]},'children'),task]});
 const recovery=fresh(d,'tick',{now:now+1002,observations:[observation(a,{threads:[child]},'children'),status({...a,taskId,childThreadId:threadId},'running')]});
 save('recovery-index-'+shape+'-'+tagged,{d,a,child,task,before,reply,recovery,ledger:ledger(d)});
 assert.equal(recovery.ok,true,'Explicit intent must recover the same original task');
 assert.equal(reply.ok,true,'All accepted recovery page representations must feed the same ownership index');
 assert.equal(reply.result.action.type,'sleep');assert.equal(ledger(d).runs[a.runId].lastStatus.taskId,taskId);assert.deepEqual(reply.calls,[]);
 const next=fresh(d,'tick',{now:now+1003});assert.equal(next.ok,true);assert.equal(next.result.action.type,'poll');assert.equal(next.result.action.taskId,taskId);assert.deepEqual(next.calls,[]);
});

test('R11 durable unprocessed status survives identity ambiguity after SIGKILL',async()=>{
 const d=init('archive-crash');
 await assert.rejects(()=>k.startMissionRun(d,{}, {runFeature:async()=>({accepted:false,code:'PROVIDER_BUSY'})}));
 const old=inspectDispatchRecords(d)[0];reapprove(d,'replacement-model');
 await k.startMissionRun(d,{}, {runFeature:async()=>({accepted:true,taskId:'shared-task',childThreadId:'shared-thread',childRunId:'shared-turn'})});
 const current=inspectDispatchRecords(d)[0];
 const a={featureId:'f1',runId:current.intent.runId,intentId:current.intent.clientRequestId,...current.receipt};
 const untagged=status(a,'running');delete untagged.intentId;
 const child=cp.spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/a12-archive-crash-child.mjs',import.meta.url)),d,JSON.stringify([untagged]),'SIGKILL'],{encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL',child.stderr);
 const rows=readObservations(d),before=ledger(d);
 const persisted=rows.find(r=>r.observation.type==='task_status');
 assert.ok(persisted);assert.equal(before.observations[persisted.id],undefined);
 const historical={...a,intentId:old.intent.clientRequestId,invocationId:old.invocations[0].invocationId};
 const replies=[];
 replies.push(fresh(d,'tick',{observations:[observation(historical,accepted(historical))],now:now+1001}));
 replies.push(fresh(d,'tick',{observations:[status(historical,'cancelled')],now:now+1002}));
 replies.push(fresh(d,'tick',{observations:[status(a,'running')],now:now+1003}));
 replies.push(fresh(d,'tick',{now:now+1004}));
 save('archive-sigkill-ambiguous',{d,old,current,untagged,archiveCrash:{exit:child.status,signal:child.signal,stderr:child.stderr},persisted,before,replies,after:ledger(d),rows:readObservations(d)});
 assert.equal(replies[1].ok,true,'Explicit historical proof must allow supported recovery after an interrupted raw-archive commit');
 assert.equal(replies[2].ok,true,'Explicit current status must allow supported recovery');
 assert.equal(replies[3].ok,true,'A prior unowned archive must not poison all future ticks');
});
