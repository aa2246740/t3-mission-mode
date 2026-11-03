import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as kernel from "../kernel/index.mjs";
import { readController, saveController } from "../kernel/autopilot-store.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const now = Date.parse("2026-11-03T04:00:00Z");
const oldWake = "Use old candidate.";
const newWake = "Use reviewed recovery candidate.";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, ".timer-reconcile-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, { missionId: "timer-reconcile", repoPath: dir, autopilot: true,
    ownerThreadId: "fixture-owner", timerEveryMs: 60000, integration: { branch: "mission/fixture", auto: true },
    milestones: [{ id: "m1", title: "Fixture", ordinal: 1 }], features: [{ id: "f1", milestoneId: "m1", title: "Fixture" }] });
  kernel.approveMissionPlan(dir);
  const first = (await kernel.missionTick(dir, { now, timerMaxWakeups: 2, timerWakeInstructions: oldWake })).action;
  const enabled = { scheduledTaskId: "timer-1", enabled: true, boundThreadId: "fixture-owner", schedule: first.schedule,
    nextRunAt: first.schedule.runAt, prompt: first.scheduleTask.prompt };
  await kernel.missionTick(dir, { now: now + 1, observations: [{ type: "timer", requestId: first.requestId, response: enabled }] });
  const ledger = readController(dir, "timer-reconcile");
  ledger.timer.phase = "requested";
  ledger.timer.requestId = "mission-timer:timer-reconcile:enable:1:1";
  saveController(dir, ledger);
  const disabled = { ...enabled, enabled: false, nextRunAt: null, prompt: enabled.prompt.replace(oldWake, newWake) };
  return { dir, requestId: ledger.timer.requestId, enabled, disabled };
}

test("reconciliation records the enabled and current disabled receipts without dispatching", async t => {
  const { dir, requestId, enabled, disabled } = await fixture(t);
  const result = kernel.reconcileBoundedTimer(dir, { requestId, enabledResponse: enabled, disabledResponse: disabled, newWakeInstructions: newWake });
  assert.equal(result.timerPhase, "disabled");
  const ledger = readController(dir, "timer-reconcile");
  assert.equal(ledger.timer.phase, "disabled");
  assert.equal(ledger.timerGuardPolicy.wakeInstructions, newWake);
  assert.deepEqual(ledger.timer.reconciliation.enabledResponse, enabled);
  assert.deepEqual(ledger.timer.reconciliation.disabledResponse, disabled);
  assert.equal(kernel.loadState(dir).activeWorker.featureId, "f1");
  assert.deepEqual(kernel.reconcileBoundedTimer(dir, { requestId, enabledResponse: enabled, disabledResponse: disabled, newWakeInstructions: newWake }), result);
});

test("reconciliation refuses stale, active, or differently bound scheduler records", async t => {
  for (const change of ["id", "enabled", "owner", "schedule", "prompt"]) {
    const { dir, requestId, enabled, disabled } = await fixture(t);
    if (change === "id") disabled.scheduledTaskId = "other-timer";
    if (change === "enabled") disabled.enabled = true;
    if (change === "owner") disabled.boundThreadId = "other-owner";
    if (change === "schedule") disabled.schedule = { type: "interval", everyMs: 60000 };
    if (change === "prompt") disabled.prompt = "unrelated";
    assert.throws(() => kernel.reconcileBoundedTimer(dir, { requestId, enabledResponse: enabled, disabledResponse: disabled, newWakeInstructions: newWake }), { code: "INVALID_TIMER_RECONCILIATION" });
    assert.equal(readController(dir, "timer-reconcile").timer.phase, "requested");
  }
});

test("the CLI reconciles the same raw timer records without running MissionTick", async t => {
  const { dir, requestId, enabled, disabled } = await fixture(t);
  const payload = JSON.stringify({ requestId, enabledResponse: enabled, disabledResponse: disabled, newWakeInstructions: newWake });
  const output = execFileSync(process.execPath, [path.join(root, "t3-mission/bridge/cli.mjs"), "ReconcileBoundedTimer", "--mission-dir", dir, "--json", payload], { encoding: "utf8" });
  assert.equal(JSON.parse(output).timerPhase, "disabled");
  assert.equal(kernel.loadState(dir).activeWorker.featureId, "f1");
});
