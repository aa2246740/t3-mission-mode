import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as store from '../kernel/store.mjs';
import * as tx from '../kernel/mission-transaction.mjs';
import * as lifetime from '../kernel/local-worker-lifecycle.mjs';
import { readController, readObservations } from '../kernel/autopilot-store.mjs';
import { inspectDispatchIntent, inspectDispatchRecords } from '../kernel/dispatch-journal.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    return { name, mode: stat.mode, mtimeMs: stat.mtimeMs, content: stat.isDirectory() ? tree(file) : fs.readFileSync(file, 'hex') };
  });
}
const readers = {
  transaction: dir => assert.equal(tx.withMissionTransaction(dir, value => value, { create: false }), null),
  state: dir => assert.equal(store.tryLoadState(dir), null),
  loadState: dir => assert.throws(() => store.loadState(dir), { code: 'MISSION_NOT_FOUND' }),
  file: dir => assert.equal(tx.readTransactionFile(path.join(store.getMissionPaths(dir).baseDir, 'state.json')), null),
  features: dir => assert.deepEqual(store.loadFeaturesDoc(dir).features, []),
  models: dir => store.loadModelSettings(dir),
  log: dir => assert.deepEqual(store.readProgressLog(dir), []),
  snapshot: dir => assert.equal(store.readMissionSnapshot(dir).state, null),
  controller: dir => assert.deepEqual(readController(dir, 'missing').runs, {}),
  observations: dir => assert.deepEqual(readObservations(dir), []),
  intent: dir => assert.equal(inspectDispatchIntent(dir, { missionId: 'missing' }, { id: 'f1' }, 1), null),
  records: dir => assert.deepEqual(inspectDispatchRecords(dir), []),
  reconcile: dir => assert.equal(store.reconcileMissionOnLoad(dir), null),
};
for (const kind of ['missing', 'empty', 'deleted-state', 'orphan-lock', 'uncommitted']) {
  test(`A2 missing Mission ${kind}: all read entries leave the entire tree unchanged`, t => {
    const root = fixture(t), dir = path.join(root, 'repo'), base = path.join(dir, '.mission');
    if (kind !== 'missing') fs.mkdirSync(base, { recursive: true });
    if (kind === 'deleted-state') fs.writeFileSync(path.join(base, 'features.json'), '{"features":[]}');
    if (['orphan-lock', 'uncommitted'].includes(kind)) {
      fs.mkdirSync(path.join(base, '.txn'));
      fs.writeFileSync(path.join(base, '.txn/writer.lock'), '');
      if (kind === 'uncommitted') fs.writeFileSync(path.join(base, '.txn/prepare.json'), 'uncommitted evidence');
    }
    const before = tree(root);
    for (const [name, read] of Object.entries(readers)) {
      read(dir);
      assert.deepEqual(tree(root), before, `${name} wrote to a missing Mission`);
    }
  });
}
test('A2 legacy state without a lock is read without creating a transaction directory', t => {
  const dir = fixture(t), base = path.join(dir, '.mission'); fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'state.json'), JSON.stringify({ missionId: 'legacy', sessions: [] }));
  fs.writeFileSync(path.join(base, 'features.json'), '{"features":[]}');
  const before = tree(dir);
  assert.equal(store.readMissionSnapshot(dir).state.missionId, 'legacy');
  assert.deepEqual(tree(dir), before);
});
test('A2 read cannot recreate transaction files if deletion wins before lock open', t => {
  const dir = fixture(t), base = path.join(dir, '.mission');
  store.saveState(dir, { missionId: 'deleted', sessions: [] });
  const original = fs.openSync;
  fs.openSync = function(file, ...args) {
    if (String(file) === path.join(base, '.txn/writer.lock')) fs.rmSync(base, { recursive: true, force: true });
    return original.call(this, file, ...args);
  };
  try { assert.equal(store.tryLoadState(dir), null); }
  finally { fs.openSync = original; }
  assert.equal(fs.existsSync(base), false);
});
test('A2 a lock appearing during a legacy snapshot refuses the mixed read', t => {
  const dir = fixture(t), base = path.join(dir, '.mission'); fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'state.json'), '{"missionId":"legacy"}');
  assert.throws(() => tx.withMissionTransaction(dir, () => {
    store.tryLoadState(dir);
    fs.mkdirSync(path.join(base, '.txn')); fs.writeFileSync(path.join(base, '.txn/writer.lock'), '');
  }, { create: false }), { code: 'TX_BUSY' });
});
test('A2 create:false retains committed WAL recovery when state was not materialized', t => {
  const dir = fixture(t), state = { missionId: 'recover-a2', sessions: [] };
  tx.setTransactionTestHook(event => {
    if (event.role === 'projection:state.json' && event.operation === 'rename' && event.boundary === 'before')
      throw Object.assign(new Error('injected projection EIO'), { code: 'EIO' });
  });
  try { assert.throws(() => store.saveState(dir, state), { code: 'EIO' }); }
  finally { tx.setTransactionTestHook(undefined); }
  const base = path.join(dir, '.mission');
  assert.equal(fs.existsSync(path.join(base, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(base, '.txn/commit.json')), true);
  assert.equal(store.tryLoadState(dir).missionId, 'recover-a2');
  assert.equal(fs.existsSync(path.join(base, '.txn/commit.json')), false);
  const before = tree(dir); store.tryLoadState(dir); assert.deepEqual(tree(dir), before);
});

for (const status of ['running', 'paused']) test(`A2 ${status} historical run exits when a new run replaces it`, () => {
  assert.equal(lifetime.localWorkerRunEnded({ activeWorker: { runId: 'new-run', workerPid: 999 }, sessions: [{ runId: 'old-run', status }] }, 'old-run', 123), true);
});
for (const status of ['running', 'paused']) test(`A2 atomic lifetime poll keeps the valid ${status} run`, t => {
  const dir = fixture(t), file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ activeWorker: { runId: 'own', workerPid: 123 }, sessions: [{ runId: 'own', status }] }));
  const before = tree(dir);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123).reason, null);
  assert.deepEqual(tree(dir), before);
});
for (const status of ['completed', 'failed']) test(`A2 atomic lifetime poll exits for ${status} owned run`, t => {
  const dir = fixture(t), file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ activeWorker: { runId: 'next', workerPid: 999 }, sessions: [{ runId: 'own', status }] }));
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123).reason, 'run-ended');
});
test('A2 missing state has a bounded grace and recovery resets it without writes', t => {
  const dir = fixture(t), file = path.join(dir, 'state.json'), before = tree(dir);
  const first = lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 1000, seenState: true });
  assert.equal(first.reason, null); assert.equal(first.missingSince, 1000);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 1249, missingSince: first.missingSince, seenState: true }).reason, null);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 1250, missingSince: first.missingSince, seenState: true }).reason, 'mission-missing');
  assert.deepEqual(tree(dir), before);
  fs.writeFileSync(file, '{"activeWorker":{"runId":"own","workerPid":123},"sessions":[]}');
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 1260, missingSince: first.missingSince, seenState: true }).missingSince, null);
});
test('A3 a standalone daemon that never observed a Mission state does not exit for missing state', t => {
  const dir = fixture(t), file = path.join(dir, 'state.json'), before = tree(dir);
  let poll = { missingSince: null, seenState: false };
  for (const nowMs of [0, 250, 10_000, 3_600_000]) {
    poll = lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs, missingSince: poll.missingSince, seenState: poll.seenState });
    assert.equal(poll.reason, null); assert.equal(poll.seenState, false); assert.equal(poll.missingSince, null);
  }
  assert.deepEqual(tree(dir), before);
  fs.writeFileSync(file, '{"activeWorker":{"runId":"own","workerPid":123},"sessions":[]}');
  poll = lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 1, ...poll });
  assert.equal(poll.reason, null); assert.equal(poll.seenState, true);
  fs.unlinkSync(file);
  poll = lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 2, missingSince: poll.missingSince, seenState: poll.seenState });
  assert.equal(poll.reason, null); assert.equal(poll.missingSince, 2);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 252, missingSince: poll.missingSince, seenState: poll.seenState }).reason, 'mission-missing');
});
test('A2 committed WAL and transient JSON defer the run decision without recovery writes', t => {
  const dir = fixture(t), file = path.join(dir, 'state.json');
  fs.mkdirSync(path.join(dir, '.txn')); fs.writeFileSync(path.join(dir, '.txn/commit.json'), 'pending');
  fs.writeFileSync(file, '{"sessions":[{"runId":"own","status":"completed"}]}');
  let before = tree(dir);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123).reason, null); assert.deepEqual(tree(dir), before);
  fs.unlinkSync(path.join(dir, '.txn/commit.json')); fs.writeFileSync(file, '{'); before = tree(dir);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123).reason, null); assert.deepEqual(tree(dir), before);
  fs.unlinkSync(file);
  assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123, { nowMs: 500, missingSince: 0, seenState: true }).reason, 'mission-missing');
});
test('A2 lifetime polling stays responsive while an independent process holds the writer lock', async t => {
  const dir = fixture(t); store.saveState(dir, { missionId: 'busy-a2', activeWorker: { runId: 'own', workerPid: 123 }, sessions: [] });
  // Hold the real OS lock until the parent releases stdin; no daemon or listener is started.
  const actor = `import fs from 'node:fs'; import { withMissionTransaction } from ${JSON.stringify(new URL('../kernel/mission-transaction.mjs', import.meta.url).href)}; withMissionTransaction(process.argv[1], () => { fs.writeSync(1, 'locked\\n'); fs.readSync(0, Buffer.alloc(1), 0, 1); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', actor, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(child, 'exit'); let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end('x'); await done; } });
  await once(child.stdout, 'data');
  const file = store.getMissionPaths(dir).statePath, before = tree(dir);
  const started = performance.now(); let timerFired = false;
  const timer = new Promise(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
  for (let i = 0; i < 40; i++) assert.equal(lifetime.inspectLocalWorkerLifetime(file, 'own', 123).reason, null);
  await timer;
  assert.equal(timerFired, true); assert.ok(performance.now() - started < 500, 'poll waited for the exclusive writer lock');
  assert.equal(child.exitCode, null); assert.deepEqual(tree(dir), before);
  child.stdin.end('x'); assert.equal((await done)[0], 0, stderr);
});
test('A2 a noncreating read retains the transaction-directory symlink fence', t => {
  const dir = fixture(t);
  store.saveState(dir, { missionId: 'own', sessions: [] });
  const txn = path.join(dir, '.mission/.txn'), foreign = path.join(dir, 'foreign-transaction-dir');
  fs.renameSync(txn, foreign); fs.symlinkSync(foreign, txn);
  assert.throws(() => store.tryLoadState(dir), { code: 'TX_FOREIGN_PATH' });
});
test('A2 committed WAL still recovers when its writer lock is missing', t => {
  const dir = fixture(t);
  tx.setTransactionTestHook(event => {
    if (event.role === 'projection:state.json' && event.operation === 'rename' && event.boundary === 'before')
      throw Object.assign(new Error('projection EIO'), { code: 'EIO' });
  });
  try { assert.throws(() => store.saveState(dir, { missionId: 'recover-without-lock', sessions: [] }), { code: 'EIO' }); }
  finally { tx.setTransactionTestHook(undefined); }
  fs.unlinkSync(path.join(dir, '.mission/.txn/writer.lock'));
  assert.equal(store.tryLoadState(dir).missionId, 'recover-without-lock');
  assert.equal(fs.existsSync(path.join(dir, '.mission/.txn/commit.json')), false);
});
