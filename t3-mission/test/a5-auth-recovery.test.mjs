import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as k from '../kernel/index.mjs';
import { readController } from '../kernel/autopilot-store.mjs';
const target = { providerInstanceId: 'codex', model: 'gpt-6.1-sol', options: { reasoningEffort: 'max', serviceTier: 'priority' } };
const wrap = (mode, raw) => mode === 'plain' ? raw : mode === 'content' ? { content: [{ type: 'text', text: JSON.stringify(raw) }] } : { structuredContent: raw };
const tick = async (dir, observations = [], now = Date.now()) => (await k.missionTick(dir, { observations, now })).action;
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a5-auth-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  k.proposeMission(dir, { title: 'A5 auth', repoPath: dir, autopilot: true, ownerThreadId: 'a5-owner', milestones: [{ id: 'm1' }], features: [{ id: 'f1', milestoneId: 'm1' }], assertions: [{ id: 'VAL-1', milestoneId: 'm1' }], modelSettings: { worker: target, validator: target }, integration: { branch: 'mission/a5', auto: true } }); k.approveMissionPlan(dir);
  const timer = await tick(dir); const action = await tick(dir, [{ type: 'timer', requestId: timer.requestId, response: { taskId: 'a5-timer', enabled: true } }]);
  return { dir, action };
}
function reapprove(dir) {
  const state = k.loadState(dir); k.rejectMissionPlan(dir, 'Credentials repaired');
  k.proposeMission(dir, { title: state.title, repoPath: dir, autopilot: true, ownerThreadId: state.ownerThreadId, milestones: state.milestones, assertions: state.assertions, features: k.loadFeaturesDoc(dir).features, modelSettings: { worker: target, validator: target }, integration: state.integration }); k.approveMissionPlan(dir);
}
function journals(dir) { const base = k.getMissionPaths(dir).baseDir; return fs.readdirSync(base).filter(name => /^dispatch-.*\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(base, name)))); }
for (const mode of ['plain', 'structuredContent', 'content']) for (const code of [401, 429]) test(`A5 ${code} ${mode} rejection recovers in a fresh CLI while retaining counters and deadline`, async t => {
  const { dir, action } = await fixture(t);
  const raw = wrap(mode, { accepted: false, isError: true, message: code === 401 ? '401 Unauthorized: API key rejected' : '429 rate limit; try again later' });
  await tick(dir, [{ type: 'dispatch', runId: action.runId, featureId: action.featureId, intentId: action.intentId, response: raw }]);
  const old = readController(dir, k.loadState(dir).missionId), budget = old.features.f1;
  assert.equal(journals(dir)[0].phase, 'retryable'); assert.equal(old.runs[action.runId].consumed, true); assert.equal(budget.providerErrors, 1);
  if (code === 401) { assert.equal((await tick(dir, [], Date.now() + 86400000)).reason, 'PROVIDER_AUTH_REQUIRED'); reapprove(dir); }
  assert.equal((await tick(dir, [], Date.parse(budget.nextRetryAt) - 1)).type, 'sleep');
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../bridge/cli.mjs', import.meta.url)), 'MissionTick', '--mission-dir', dir, '--json', JSON.stringify({ now: Date.parse(budget.nextRetryAt) + 1 })], { encoding: 'utf8' });
  const result = JSON.parse(stdout); assert.equal(result.action.type, 'dispatch'); assert.equal(result.action.attempt, 2);
  const ledger = readController(dir, k.loadState(dir).missionId); assert.equal(ledger.features.f1.providerErrors, 1); assert.equal(ledger.features.f1.nextRetryAt, budget.nextRetryAt); assert.equal(ledger.consecutiveProviderErrors, old.consecutiveProviderErrors);
  if (process.env.R9_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.R9_EVIDENCE_DIR, `auth-fresh-${mode}-${code}.json`), JSON.stringify({ raw, old, result, ledger, stdout }, null, 2));
});
for (const mode of ['plain', 'structuredContent', 'content']) test(`A5 ambiguous ${mode} isError acceptance remains fenced after reapproval`, async t => {
  const { dir, action } = await fixture(t);
  const raw = wrap(mode, { accepted: false, isError: true, message: '401 Unauthorized', response: { accepted: true } });
  await tick(dir, [{ type: 'dispatch', runId: action.runId, featureId: action.featureId, intentId: action.intentId, response: raw }]);
  reapprove(dir);
  assert.notEqual((await tick(dir, [], Date.now() + 86400000)).type, 'dispatch');
  assert.equal(journals(dir)[0].phase, 'inflight'); assert.equal(journals(dir).length, 1);
});
