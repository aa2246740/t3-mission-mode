import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as kernel from '../kernel/index.mjs';
import { bounded, createHandlerHud, saveContractEvidence } from './hud-handler-fixture.mjs';

function snapshot(dir) {
  const result = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(dir, file)] = {
        bytes: fs.readFileSync(file).toString('base64'),
        mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs.toString(),
      };
    }
  }
  walk(path.join(dir, '.mission'));
  return result;
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-hook-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.mission/\n');
  execFileSync('git', ['-C', dir, 'add', '.gitignore']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-qm', 'fixture']);
  kernel.proposeMission(dir, { repoPath: dir, title: 'Approve hook contract',
    milestones: [{ id: 'm1' }], features: [{ id: 'f1', title: 'F1', milestoneId: 'm1' }],
    modelSettings: { skipScrutiny: true, skipUserTesting: true } });
  kernel.approveMissionPlan(dir);
  await kernel.startMissionRun(dir);
  const state = kernel.loadState(dir);
  kernel.bindFeatureDispatch(dir, { featureId: 'f1', runId: state.activeWorker.runId,
    expectedRevision: state.revision, taskId: 'accepted-task', childThreadId: 'accepted-thread',
    runtimeTransport: 't3-delegate-task' });
  return dir;
}

for (const throws of [false, true]) test(`approve handler preserves a hook's completed run${throws ? ' after hook failure' : ''}`, async t => {
  const dir = await fixture(t), epoch = kernel.loadState(dir).planApprovalEpoch;
  let committed, calls = 0;
  const hud = await createHandlerHud({ missionDir: dir,
    dispatchAdapter: { runFeature: async () => assert.fail('accepted task must not be delegated') },
    onCommand: async event => {
      assert.equal(event.type, 'approve'); calls++;
      const worker = kernel.loadState(dir).activeWorker;
      kernel.endFeatureRun(dir, { runId: worker.runId, featureId: worker.featureId,
        successState: 'success', validatorsPassed: true,
        handoff: { whatWasImplemented: 'Completed the original accepted private fixture task and verified the final state without starting another task.' } });
      committed = snapshot(dir);
      if (throws) throw new Error('hook failed after legitimate completion');
    } });
  try {
    const response = await bounded(hud.post('approve', { worker: { reasoningEffort: 'max' } }));
    saveContractEvidence(`approve-completion${throws ? '-throws' : ''}`, { response, calls, committed, after: snapshot(dir), epoch });
    assert.equal(response.status, throws ? 500 : 409);
    assert.equal(calls, 1); assert.ok(committed);
    assert.deepEqual(snapshot(dir), committed);
    assert.equal(kernel.loadState(dir).status, 'completed');
    assert.equal(kernel.loadState(dir).planApprovalEpoch, epoch);
  } finally { await hud.close(); }
});

test('approve handler notifies an unchanged bound run once with zero writes and no epoch bump', async t => {
  const dir = await fixture(t), before = snapshot(dir), state = kernel.loadState(dir);
  let calls = 0;
  const hud = await createHandlerHud({ missionDir: dir,
    dispatchAdapter: { runFeature: async () => assert.fail('accepted task must not be delegated') },
    onCommand: async event => {
      assert.equal(event.type, 'approve'); assert.equal(event.snapshot.state.activeWorker.runId, state.activeWorker.runId);
      assert.deepEqual(event.payload.body, { message: 'Repeat approval' }); calls++;
    } });
  try {
    const response = await bounded(hud.post('approve', { message: 'Repeat approval' }));
    saveContractEvidence('approve-unchanged', { response, calls, before, after: snapshot(dir) });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.equal(response.body.state.planApprovalEpoch, state.planApprovalEpoch);
    assert.deepEqual(snapshot(dir), before);
  } finally { await hud.close(); }
});
