import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as k from '../kernel/index.mjs';
import { runClaimedEffect } from '../kernel/mission-transaction.mjs';
import { classifyControlReceipt } from '../kernel/schema.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';
const child = { taskId: 'claim-task', childThreadId: 'claim-thread', childRunId: 'claim-child', runtimeTransport: 't3-delegate-task' };
async function fixture(t, bound = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-claim-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'Claim fixture', repoPath: dir, features: [{ id: 'f1' }] }); k.approveMissionPlan(dir);
  if (bound) {
    await k.startMissionRun(dir, {}, { runFeature: async () => ({ accepted: true, ...child }) });
    const state = k.loadState(dir); state.status = 'paused'; state.pauseEpoch = 1; state.activeWorker.status = 'paused'; state.sessions[0].status = 'paused'; k.saveState(dir, state);
  }
  return dir;
}

test('A5 shared classifier requires an explicit expected identity argument', () => {
  assert.throws(() => classifyControlReceipt({ paused: true }, 'pause'), /expected child identity/);
  assert.throws(() => classifyControlReceipt({ paused: true }, 'unknown', {}), /operation/);
});
for (const entry of ['hud-worker', 'hud-hook', 'runner']) for (const [shape, raw] of Object.entries({ unknown: {}, rejected: { accepted: false }, pending: { sent: true, pending: true }, foreign: { threadId: 'foreign-thread', sent: true } }))
  test(`A5 ${entry} ${shape} cannot repeat bound Resume with a different command ID`, async t => {
    const dir = await fixture(t); let calls = 0; const invoke = async () => { calls++; return raw; };
    if (entry === 'runner') {
      for (const commandId of ['first', 'second']) {
        const result = k.startMissionRun(dir, { commandId }, { resumeWorker: invoke });
        if (shape === 'foreign') await assert.rejects(result, { code: 'DISPATCH_BINDING_CONFLICT' });
        else await result;
      }
    } else {
      const hud = await createHandlerHud({ missionDir: dir, runtimeAdapter: entry === 'hud-worker' ? { resumeWorker: invoke } : { startMissionRun: invoke } });
      try { for (const commandId of ['first', 'second']) assert.equal((await hud.post('resume', { commandId })).status, 409); }
      finally { await hud.close(); }
    }
    assert.equal(calls, 1); assert.equal(k.loadState(dir).status, 'paused'); assert.equal(k.loadState(dir).activeWorker.taskId, child.taskId);
  });
for (const entry of ['hud-worker', 'hud-hook', 'runner']) test(`A5 ${entry} reuses an old command-scoped Resume claim`, async t => {
  const dir = await fixture(t); const state = k.loadState(dir);
  const oldId = `resume:${state.activeWorker.runId}:1:old-command`;
  await runClaimedEffect(dir, oldId, async () => ({}));
  let calls = 0; const invoke = async () => { calls++; return { sent: true }; };
  if (entry === 'runner') await k.startMissionRun(dir, { commandId: 'new-command' }, { resumeWorker: invoke });
  else {
    const hud = await createHandlerHud({ missionDir: dir, runtimeAdapter: entry === 'hud-worker' ? { resumeWorker: invoke } : { startMissionRun: invoke } });
    try { assert.equal((await hud.post('resume', { commandId: 'new-command' })).status, 409); } finally { await hud.close(); }
  }
  assert.equal(calls, 0); assert.equal(k.loadState(dir).status, 'paused');
});
for (const [shape, raw] of Object.entries({ unknown: {}, rejected: { accepted: false }, pending: { pending: true }, confirmed: { interrupted: true } }))
  test('A5 compensation records the actual child state ' + shape, async t => {
    const dir = await fixture(t, false);
    await k.startMissionRun(dir, {}, { runFeature: async () => {
      const hud = await createHandlerHud({ missionDir: dir, runtimeAdapter: {} });
      try { assert.equal((await hud.post('pause')).status, 200); } finally { await hud.close(); }
      return { accepted: true, ...child };
    }, pauseWorker: async () => raw });
    const state = k.loadState(dir), feature = k.loadFeaturesDoc(dir).features[0];
    assert.equal(state.status, 'paused');
    for (const record of [state.activeWorker, state.sessions[0], feature]) assert.equal(record.status, shape === 'confirmed' ? 'paused' : 'running');
  });
