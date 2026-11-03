import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as k from '../kernel/index.mjs';
import { createMissionHudServer, DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS, MAX_GIT_PREFLIGHT_TIMEOUT_MS } from '../hud/server.mjs';
import { createHandlerHud } from './hud-handler-fixture.mjs';

test('A5 Git budget rejects invalid values before creating a Mission or listener', () => {
  assert.equal(DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS, 10000);
  assert.equal(MAX_GIT_PREFLIGHT_TIMEOUT_MS, 30000);
  for (const value of [0, -1, 1.5, NaN, Infinity, '5000', null, 30001])
    assert.throws(() => createMissionHudServer({ gitPreflightTimeoutMs: value }), /integer from 1 to 30000/);
});
for (const flag of ['--git-preflight-timeout-ms=30001', '--git-preflight-timeout-ms']) test('A5 HUD CLI validates Git budget ' + flag, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-git-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../hud/server.mjs', import.meta.url)), '--mission-dir', dir, '--foreground', flag], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gitPreflightTimeoutMs must be an integer from 1 to 30000/);
  assert.equal(fs.existsSync(path.join(dir, '.mission')), false);
});

test('A5 configured Git budget allows the R4 finite 2.2 second fsmonitor to finish outside the lock', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-git-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  k.proposeMission(dir, { title: 'Budget fixture', repoPath: dir, features: [{ id: 'f1' }] }); k.approveMissionPlan(dir);
  await k.startMissionRun(dir, {}, { runFeature: async () => ({ accepted: true, taskId: 'budget-task', childThreadId: 'budget-thread', runtimeTransport: 't3-delegate-task' }) });
  const state = k.loadState(dir); state.status = 'paused'; state.activeWorker.status = 'paused'; state.sessions[0].status = 'paused'; k.saveState(dir, state);
  const hook = path.join(dir, 'finite-hook'); fs.writeFileSync(hook, '#!/bin/sh\n/bin/sleep 2.2\nprintf "\\n"\n', { mode: 0o700 });
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', hook]);
  let calls = 0, eventLoopRan = false;
  const hud = await createHandlerHud({ missionDir: dir, gitPreflightTimeoutMs: 10000, runtimeAdapter: { resumeWorker: async () => { calls++; return { sent: true, threadId: 'budget-thread' }; } } });
  const timer = setTimeout(() => { eventLoopRan = true; }, 20);
  try {
    const reply = await hud.post('resume');
    if (process.env.R9_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, 'configured-git-budget.json'), JSON.stringify({ gitPreflightTimeoutMs: 10000, reply, calls, eventLoopRan }, null, 2));
    assert.equal(reply.status, 200); assert.equal(calls, 1); assert.equal(eventLoopRan, true);
    assert.equal(k.loadState(dir).status, 'running'); assert.equal(k.loadState(dir).activeWorker.status, 'running');
  } finally { clearTimeout(timer); await hud.close(); }
});
