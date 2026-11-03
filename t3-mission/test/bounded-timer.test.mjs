import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import * as kernel from "../kernel/index.mjs";
import { readController, saveController } from "../kernel/autopilot-store.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const NOW = Date.parse("2026-11-03T00:00:00Z");
const PERIOD = 60000;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, ".bounded-timer-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, {
    missionId: "bounded-timer-fixture",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "fixture-owner",
    timerEveryMs: PERIOD,
    integration: { branch: "mission/fixture", auto: true },
    milestones: [{ id: "m1", title: "Fixture", ordinal: 1 }],
    features: [{ id: "f1", milestoneId: "m1", title: "Fixture feature" }],
  });
  kernel.approveMissionPlan(dir);
  return dir;
}

async function tick(dir, now, options = {}) {
  return (await kernel.missionTick(dir, { now, ...options })).action;
}

function timerReceipt(action) {
  const schedule = action.schedule ?? action.updateScheduledTask.schedule;
  return {
    scheduledTaskId: "timer-1",
    enabled: true,
    boundThreadId: "fixture-owner",
    schedule,
    nextRunAt: schedule.runAt,
  };
}

test("bounded timer reuses one scheduler ID and stops rearming at its limit", async (t) => {
  const dir = fixture(t);
  const first = await tick(dir, NOW, { timerMaxWakeups: 2 });
  assert.equal(first.type, "ensure_timer");
  assert.deepEqual(first.schedule, { type: "once", runAt: new Date(NOW + PERIOD).toISOString() });
  const waiting = await tick(dir, NOW + 1);
  assert.equal(waiting.reason, "TIMER_OUTCOME_UNKNOWN");
  const dispatch = await tick(dir, NOW + 2, {
    observations: [{ type: "timer", requestId: first.requestId, response: timerReceipt(first) }],
  });
  assert.equal(dispatch.type, "dispatch");

  const second = await tick(dir, NOW + PERIOD);
  assert.equal(second.type, "ensure_timer");
  assert.equal(second.updateScheduledTask.scheduledTaskId, "timer-1");
  assert.deepEqual(second.updateScheduledTask.schedule, {
    type: "once",
    runAt: new Date(NOW + 2 * PERIOD).toISOString(),
  });
  assert.notEqual(second.requestId, first.requestId);
  assert.equal((await tick(dir, NOW + PERIOD + 1)).reason, "TIMER_OUTCOME_UNKNOWN");
  await tick(dir, NOW + PERIOD + 2, {
    observations: [{ type: "timer", requestId: second.requestId, response: timerReceipt(second) }],
  });
  const stopped = await tick(dir, NOW + 2 * PERIOD);
  assert.equal(stopped.type, "wait_user");
  assert.equal(stopped.reason, "TIMER_WAKE_LIMIT_REACHED");
  assert.equal(readController(dir, "bounded-timer-fixture").timer.guard.scheduled, 2);
  assert.equal((await tick(dir, NOW + 20 * PERIOD)).reason, "TIMER_WAKE_LIMIT_REACHED");
});

test("an expired or delayed first wake does not create another schedule", async (t) => {
  const dir = fixture(t);
  const first = await tick(dir, NOW, { timerMaxWakeups: 2 });
  await tick(dir, NOW + 1, {
    observations: [{ type: "timer", requestId: first.requestId, response: timerReceipt(first) }],
  });
  const action = await tick(dir, NOW + 5 * PERIOD);
  assert.equal(action.type, "wait_user");
  assert.equal(action.reason, "TIMER_WAKE_LIMIT_REACHED");
  assert.equal(readController(dir, "bounded-timer-fixture").timer.guard.scheduled, 1);
});

test("the existing interval behavior remains for missions without the optional bound", async (t) => {
  const action = await tick(fixture(t), NOW);
  assert.deepEqual(action.schedule, { type: "interval", everyMs: PERIOD });
});

test("a killed owner with an unconfirmed rearm never schedules another timer", async (t) => {
  const dir = fixture(t);
  const first = await tick(dir, NOW, { timerMaxWakeups: 2 });
  await tick(dir, NOW + 1, {
    observations: [{ type: "timer", requestId: first.requestId, response: timerReceipt(first) }],
  });
  const moduleUrl = new URL("../kernel/index.mjs", import.meta.url).href;
  const program = `import {missionTick} from ${JSON.stringify(moduleUrl)}; const result = await missionTick(${JSON.stringify(dir)}, {now:${NOW + PERIOD}}); console.log(JSON.stringify(result.action)); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const action = await new Promise((resolve, reject) => {
    let data = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) resolve(JSON.parse(data).action ?? JSON.parse(data));
    });
    child.on("exit", (code) => {
      if (!data) reject(new Error(`child exited ${code}`));
    });
  });
  assert.equal(action.type, "ensure_timer");
  assert.equal(action.updateScheduledTask.scheduledTaskId, "timer-1");
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    child.on("close", resolve);
  });
  assert.equal((await tick(dir, NOW + 10 * PERIOD)).reason, "TIMER_OUTCOME_UNKNOWN");
  assert.equal(readController(dir, "bounded-timer-fixture").timer.guard.scheduled, 2);
});

test("a bounded timer refuses a changed or corrupted limit", async (t) => {
  const dir = fixture(t);
  await tick(dir, NOW, { timerMaxWakeups: 2 });
  await assert.rejects(kernel.missionTick(dir, { now: NOW + 1, timerMaxWakeups: 3 }), {
    code: "TIMER_GUARD_LOCKED",
  });
  const ledger = readController(dir, "bounded-timer-fixture");
  ledger.timer.guard.scheduled = 99;
  saveController(dir, ledger);
  await assert.rejects(kernel.missionTick(dir, { now: NOW + 2 }), { code: "INVALID_TIMER_GUARD" });
});

test("the CLI carries the bound into the real MissionTick action", (t) => {
  const dir = fixture(t);
  const output = execFileSync(
    process.execPath,
    [
      path.join(root, "t3-mission/bridge/cli.mjs"),
      "MissionTick",
      "--mission-dir",
      dir,
      "--json",
      '{"timerMaxWakeups":2}',
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  assert.equal(result.action.type, "ensure_timer");
  assert.equal(result.action.schedule.type, "once");
  assert.equal(readController(dir, "bounded-timer-fixture").timer.guard.maxWakeups, 2);
});

test("a bounded timer refuses an interval or a different owner in the scheduler receipt", async (t) => {
  for (const wrong of ["interval", "owner"]) {
    const dir = fixture(t);
    const first = await tick(dir, NOW, { timerMaxWakeups: 2 });
    const response = {
      scheduledTaskId: "timer-1",
      enabled: true,
      boundThreadId: wrong === "owner" ? "other-owner" : "fixture-owner",
      schedule: wrong === "interval" ? { type: "interval", everyMs: PERIOD } : first.schedule,
      nextRunAt: first.schedule.runAt,
    };
    const result = await tick(dir, NOW + 1, {
      observations: [{ type: "timer", requestId: first.requestId, response }],
    });
    assert.equal(result.type, "wait_user");
    assert.equal(result.reason, "INVALID_TIMER_RECEIPT");
    assert.equal(kernel.loadState(dir).activeWorker, null);
  }
});

test("a bounded wake retains its original recovery instructions", async (t) => {
  const dir = fixture(t);
  const first = await tick(dir, NOW, {
    timerMaxWakeups: 2,
    timerWakeInstructions: "Use the checked candidate and run the disk preflight.",
  });
  assert.match(first.scheduleTask.prompt, /Use the checked candidate and run the disk preflight/);
  await assert.rejects(
    kernel.missionTick(dir, {
      now: NOW + 1,
      timerMaxWakeups: 2,
      timerWakeInstructions: "Skip the disk preflight.",
    }),
    { code: "TIMER_GUARD_LOCKED" },
  );
});
