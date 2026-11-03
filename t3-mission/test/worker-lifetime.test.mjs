import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localWorkerRunEnded, writeLocalWorkerMarker, removeLocalWorkerMarker } from '../kernel/local-worker-lifecycle.mjs';

for (const status of ['completed', 'failed']) for (const activeWorker of [null, { runId: 'next-run', workerPid: 123 }, { runId: 'old-run', workerPid: 456 }]) {
  test(`A1 F03 terminal ${status} exits independently of active run ${activeWorker?.runId ?? 'none'}`, () => {
    assert.equal(localWorkerRunEnded({ activeWorker, sessions: [{ runId: 'old-run', status }] }, 'old-run', 456), true);
  });
}
for (const status of ['running', 'paused']) test(`A1 F03 live ${status} session survives a short transport parent's exit`, () => {
  assert.equal(localWorkerRunEnded({ activeWorker: { runId: 'old-run', workerPid: 456 }, sessions: [{ runId: 'old-run', status }] }, 'old-run', 456), false);
});
test('A1 F03 a replacement PID for the same run ends the old lifetime', () => {
  assert.equal(localWorkerRunEnded({ activeWorker: { runId: 'old-run', workerPid: 789 }, sessions: [] }, 'old-run', 456), true);
  assert.equal(localWorkerRunEnded({ activeWorker: null, sessions: [] }, 'old-run', 456), false);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file: path.join(dir, 'marker.json'), state: { pid: process.pid, missionDir: dir, repoPath: dir, runId: 'old-run', featureId: 'f1', status: 'running', pauseCount: 0 } };
}
test('A1 F03 a late pause or resume update never recreates a deleted marker', t => {
  const { file, state } = fixture(t);
  assert.equal(writeLocalWorkerMarker(file, state, { initial: true }), true);
  fs.unlinkSync(file);
  assert.equal(writeLocalWorkerMarker(file, { ...state, status: 'paused', pauseCount: 1 }), false);
  assert.equal(fs.existsSync(file), false);
});
test('A1 F03 updates and teardown preserve a replacement owner marker', t => {
  const { file, state } = fixture(t), replacement = JSON.stringify({ ...state, pid: state.pid + 1, runId: 'new-run' });
  fs.writeFileSync(file, replacement);
  assert.equal(writeLocalWorkerMarker(file, state), false);
  assert.equal(removeLocalWorkerMarker(file, state), false);
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});
test('A1 F03 marker registration refuses to overwrite an existing owner', t => {
  const { file, state } = fixture(t); fs.writeFileSync(file, 'existing owner bytes');
  assert.equal(writeLocalWorkerMarker(file, state, { initial: true }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing owner bytes');
});
test('A1 F03 the owned marker updates in place and is removed at teardown', t => {
  const { file, state } = fixture(t);
  assert.equal(writeLocalWorkerMarker(file, state, { initial: true }), true);
  assert.equal(writeLocalWorkerMarker(file, { ...state, status: 'paused', pauseCount: 1 }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pauseCount, 1);
  assert.equal(removeLocalWorkerMarker(file, state), true); assert.equal(fs.existsSync(file), false);
});
test('A1 F03 a symlink marker cannot redirect registration or heartbeat writes', t => {
  const { file, state } = fixture(t), other = file + '.other'; fs.writeFileSync(other, 'foreign file'); fs.symlinkSync(other, file);
  assert.equal(writeLocalWorkerMarker(file, state, { initial: true }), false);
  assert.equal(writeLocalWorkerMarker(file, state), false);
  assert.equal(fs.readFileSync(other, 'utf8'), 'foreign file');
});
