import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as k from '../kernel/index.mjs';
import { inspectDispatchRecords, dispatchRecordOutcome } from '../kernel/dispatch-journal.mjs';
const fixtures = new URL('./fixtures/a9-legacy/', import.meta.url);
for (const name of fs.readdirSync(fixtures).filter(name => name.endsWith('.json'))) for (const retarget of [false, true]) {
  test(`A9 actual legacy ${name} retarget=${retarget} cannot infer return provenance`, async () => {
    const fixture = JSON.parse(fs.readFileSync(new URL(name, fixtures)));
    const d = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), 'a9-legacy-'));
    fs.mkdirSync(path.join(d, '.mission'));
    for (const [file, bytes] of Object.entries(fixture.files)) {
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.hashes[file]);
      fs.writeFileSync(path.join(d, '.mission', file), bytes);
    }
    const before = inspectDispatchRecords(d);
    if (fixture.version === 'baseline') assert.equal(before.length, 0);
    else {
      assert.equal(before.length, 1);
      assert.equal(dispatchRecordOutcome(d, before[0]).outcome, 'UNKNOWN');
      assert.equal(before[0].invocations[0].phase, 'inflight');
      assert.deepEqual(before[0].invocations[0].receipts, []);
    }
    if (retarget) {
      k.updateMissionFeatures(d, { modelSettings: { worker: { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: {} } } });
      const state = k.loadState(d);
      k.rejectMissionPlan(d, 'New approval does not prove an old callback stopped');
      k.proposeMission(d, { ...state, features: k.loadFeaturesDoc(d).features, modelSettings: k.loadModelSettings(d) });
      k.approveMissionPlan(d);
    }
    let calls = 0;
    await assert.rejects(() => k.startMissionRun(d, {}, { runFeature: async () => {
      calls++; return { accepted: true, taskId: 'must-not-run', childThreadId: 'must-not-run' };
    } }));
    assert.equal(calls, 0);
    const after = inspectDispatchRecords(d);
    if (fixture.version !== 'baseline') assert.equal(after[0].intent.clientRequestId, before[0].intent.clientRequestId);
  });
}

test('A9 a deterministic legacy invocation ID is not an outer runtime token',async()=>{
 const {runCli}=await import('../bridge/cli.mjs');
 const fixture=JSON.parse(fs.readFileSync(new URL('a7-thrown.json',fixtures)));
 const d=fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR??os.tmpdir(),'a9-legacy-token-'));fs.mkdirSync(path.join(d,'.mission'));
 for(const [name,bytes]of Object.entries(fixture.files))fs.writeFileSync(path.join(d,'.mission',name),bytes);
 const record=inspectDispatchRecords(d)[0],state=k.loadState(d),calls=path.join(d,'calls.txt'),shim=path.join(d,'private.mjs');
 fs.writeFileSync(shim,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'entered');console.log('{}');`);
 const prior=[process.env.T3_ACP_MCP_NODE,process.env.T3_ACP_MCP_ENTRYPOINT];process.env.T3_ACP_MCP_NODE=process.execPath;process.env.T3_ACP_MCP_ENTRYPOINT=shim;
 try{
  const result=await runCli(['DispatchWorkerRuntime','--mission-dir',d,'--json',JSON.stringify({missionId:state.missionId,runId:record.intent.runId,feature:{...k.loadFeaturesDoc(d).features[0],clientRequestId:record.intent.clientRequestId,invocationId:record.invocations[0].invocationId},slotConfig:record.intent.target})],{stdout:{write(){}},stderr:{write(){}}});
  assert.equal(result.code,'INVALID_DISPATCH_INVOCATION');assert.equal(fs.existsSync(calls),false);
 }finally{for(const [i,name]of ['T3_ACP_MCP_NODE','T3_ACP_MCP_ENTRYPOINT'].entries())if(prior[i]===undefined)delete process.env[name];else process.env[name]=prior[i];}
});
