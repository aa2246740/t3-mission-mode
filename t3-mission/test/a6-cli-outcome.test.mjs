import cp from "node:child_process";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as k from '../kernel/index.mjs';
import { decideDispatchOutcome } from '../kernel/schema.mjs';
import { dispatchWithIntent, inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';
import { callT3McpTool } from '../bridge/t3-adapter.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';

test('A6 query array remains a query result rather than dispatch evidence', async () => {
  const raw = [{ taskId: 'one', childThreadId: 'thread-one' }, { taskId: 'two', childThreadId: 'thread-two' }]; let calls = 0;
  assert.deepEqual(await callT3McpTool('t3_thread_list', {}, { transportClient: async () => { calls++; return raw; } }), raw);
  assert.equal(calls, 1); assert.equal(decideDispatchOutcome(raw).outcome, 'UNKNOWN');
});

test('A6 default CLI retains refusal evidence and recovers a later accepted effect before parent archive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a6-cli-recover-')), dir = path.join(root, 'mission'), recovery = path.join(root, 'recovery'); fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'CLI accepted effect fixture', repoPath: dir, features: [{ id: 'f1' }], modelSettings: { worker: { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max' } } } });
  const callsFile = path.join(root, 'calls.txt'), shim = path.join(root, 'private-protocol.mjs');
  const accepted = { accepted: true, taskId: 'effect-task', childThreadId: 'effect-thread' };
  fs.writeFileSync(shim, `import fs from 'node:fs';const n=fs.existsSync(${JSON.stringify(callsFile)})?fs.readFileSync(${JSON.stringify(callsFile)},'utf8').trim().split('\\n').length:0;fs.appendFileSync(${JSON.stringify(callsFile)},'call\\n');console.log(JSON.stringify(n===0?{blocked:true}:${JSON.stringify(accepted)}));`);
  const old = [process.env.T3_ACP_MCP_NODE, process.env.T3_ACP_MCP_ENTRYPOINT]; process.env.T3_ACP_MCP_NODE = process.execPath; process.env.T3_ACP_MCP_ENTRYPOINT = shim;
  const hud = await createHandlerHud({ missionDir: dir });
  try {
    assert.equal((await hud.post('approve', { commandId: 'first' })).status, 409);
    const first = inspectDispatchRecords(dir)[0]; assert.equal(first.phase, 'retryable');
    const originalExec = cp.execFile;
    let captured = false;
    cp.execFile = function (file, args, ...rest) {
      if (!captured && args.includes('DispatchWorkerRuntime')) {
        captured = true;
        fs.mkdirSync(recovery); fs.cpSync(path.join(dir, '.mission'), path.join(recovery, '.mission'), { recursive: true });
      }
      return originalExec.call(this, file, args, ...rest);
    };
    try { assert.equal((await hud.post('approve', { commandId: 'second' })).status, 200); }
    finally { cp.execFile = originalExec; }
    assert.equal(captured, true);
    assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 2);
    const current = inspectDispatchRecords(dir)[0];
    assert.equal(current.invocations.length, 2);
    assert.equal(decideDispatchOutcome(current.invocations[0].receipts[0]).outcome, 'NOT_ACCEPTED');
    assert.equal(current.invocations[1].runtimeClaimed, true);
    const rawDir = path.join(dir, '.mission/.txn/receipts');
    const receipts = fs.readdirSync(rawDir).map(name => ({name,raw:fs.readFileSync(path.join(rawDir,name),'utf8')})).map(row => ({...row,record:JSON.parse(row.raw)}));
    const acceptedReturn = receipts.find(row => row.record.invocationId === current.invocations[1].invocationId && row.record.source === 'return' && row.record.result?.taskId === accepted.taskId);
    assert.ok(acceptedReturn);
    assert.equal(decideDispatchOutcome(acceptedReturn.record.result).outcome, 'ACCEPTED');
    // Only the runtime's durable invocation return reaches the frozen parent.
    const parentReceipts = fs.readdirSync(path.join(recovery, '.mission/.txn/receipts')).map(name => JSON.parse(fs.readFileSync(path.join(recovery, '.mission/.txn/receipts', name))));
    assert.equal(parentReceipts.some(row => row.result?.taskId === accepted.taskId), false);
    fs.writeFileSync(path.join(recovery, '.mission/.txn/receipts', acceptedReturn.name), acceptedReturn.raw);
    const state = await k.startMissionRun(recovery, {}, { runFeature: async () => assert.fail('Recover the existing accepted effect without dispatching') });
    assert.equal(state.activeWorker.taskId, accepted.taskId); assert.equal(state.activeWorker.childThreadId, accepted.childThreadId);
    assert.equal(inspectDispatchRecords(recovery)[0].phase, 'accepted'); assert.equal(state.sessions.length, 1);
    assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 2);
    if (process.env.R9_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, 'cli-effect-recovery.json'), JSON.stringify({ invocations:current.invocations, acceptedReturn, parentReceipts, state, journal: inspectDispatchRecords(recovery) }, null, 2));
  } finally {
    await hud.close();
    for (const [i, key] of ['T3_ACP_MCP_NODE', 'T3_ACP_MCP_ENTRYPOINT'].entries()) old[i] === undefined ? delete process.env[key] : process.env[key] = old[i];
  }
});
