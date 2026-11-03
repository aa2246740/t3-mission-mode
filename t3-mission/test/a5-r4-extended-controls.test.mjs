import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";
import { readController, saveController } from "../kernel/autopilot-store.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const target = {
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "max", serviceTier: "priority" },
};
const root = process.env.R9_EVIDENCE_DIR;
function fixture(n, autopilot = true) {
  const d = path.join(root, n);
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: n,
    repoPath: d,
    autopilot,
    ownerThreadId: "owner-r4",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", maxAttempts: 8 }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    modelSettings: { worker: target, validator: target },
    integration: { branch: "mission/r4", auto: true },
  });
  k.approveMissionPlan(d);
  return d;
}
const tick = async (d, o = [], now = Date.now()) =>
  (await k.missionTick(d, { observations: o, now })).action;
const obs = (type, a, response) => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  controlId: a.controlId,
  taskId: response.taskId ?? a.taskId,
  response,
});
const receipt = (a) => ({
  accepted: true,
  taskId: "task-" + a.runId,
  childThreadId: "thread-" + a.runId,
  ...target,
});
async function boot(d) {
  const t = await tick(d);
  return tick(d, [
    { type: "timer", requestId: t.requestId, response: { taskId: "timer-r4", enabled: true } },
  ]);
}
function save(n, x) {
  fs.writeFileSync(path.join(root, n + ".json"), JSON.stringify(x, null, 2));
}
function reapprove(d, msg = "Credential decision") {
  const s = k.loadState(d);
  k.rejectMissionPlan(d, msg);
  k.proposeMission(d, {
    title: s.title,
    repoPath: d,
    autopilot: true,
    ownerThreadId: s.ownerThreadId,
    milestones: s.milestones,
    assertions: s.assertions,
    features: k.loadFeaturesDoc(d).features,
    modelSettings: { worker: target, validator: target },
    integration: s.integration,
  });
  k.approveMissionPlan(d);
}
for (const wrapped of [false, true])
  test("Conflicting control thread boundary wrapped=" + wrapped, async () => {
    const d = fixture("thread-" + wrapped),
      a = await boot(d),
      r = receipt(a);
    await tick(d, [obs("dispatch", a, r)]);
    applyAutopilotCommand(d, "pause");
    const c = await tick(d);
    const inner = { threadId: "foreign", interrupted: true };
    const raw = {
      threadId: r.childThreadId,
      ...(wrapped ? { structuredContent: inner } : { response: inner }),
    };
    const next = await tick(d, [obs("interrupt", c, raw)]);
    const run = readController(d, k.loadState(d).missionId).runs[a.runId];
    save("thread-" + wrapped, { raw, next, run });
    assert.equal(run.pause.phase, "interrupt_requested");
  });
test("Unambiguous control for original child confirms and resumes once", async () => {
  const d = fixture("thread-valid"),
    a = await boot(d),
    r = receipt(a);
  await tick(d, [obs("dispatch", a, r)]);
  applyAutopilotCommand(d, "pause");
  const c = await tick(d);
  await tick(d, [obs("interrupt", c, { threadId: r.childThreadId, interrupted: true })]);
  assert.equal(
    readController(d, k.loadState(d).missionId).runs[a.runId].pause.phase,
    "interrupted",
  );
  applyAutopilotCommand(d, "resume");
  const resume = await tick(d);
  assert.equal(resume.type, "resume_worker");
  await tick(d, [obs("resume", resume, { threadId: r.childThreadId, sent: true })]);
  assert.equal(readController(d, k.loadState(d).missionId).runs[a.runId].pause.phase, "resumed");
  assert.notEqual((await tick(d)).type, "resume_worker");
});
test("Recurrent 401 reblocks same approval and keeps exponential deadline", async () => {
  const d = fixture("recurrent-auth");
  let a = await boot(d),
    r = receipt(a);
  await tick(d, [obs("dispatch", a, r)]);
  const firstNow = Date.now();
  await tick(
    d,
    [
      obs("task_status", a, {
        ...r,
        status: "failed",
        workState: "result_available",
        hasPendingChildRuns: false,
        summary: "401 Unauthorized",
      }),
    ],
    firstNow,
  );
  const b1 = readController(d, k.loadState(d).missionId).features.f1;
  assert.equal((await tick(d, [], firstNow + 86400000)).reason, "PROVIDER_AUTH_REQUIRED");
  reapprove(d);
  assert.equal((await tick(d, [], Date.parse(b1.nextRetryAt) - 1)).type, "sleep");
  a = await tick(d, [], Date.parse(b1.nextRetryAt) + 1);
  r = receipt(a);
  assert.equal(a.type, "dispatch");
  await tick(d, [obs("dispatch", a, r)], Date.parse(b1.nextRetryAt) + 2);
  const now2 = Date.parse(b1.nextRetryAt) + 3;
  await tick(
    d,
    [
      obs("task_status", a, {
        ...r,
        status: "failed",
        workState: "result_available",
        hasPendingChildRuns: false,
        summary: "401 Unauthorized",
      }),
    ],
    now2,
  );
  const led = readController(d, k.loadState(d).missionId),
    b2 = led.features.f1;
  save("recurrent-auth", { b1, b2, led });
  assert.equal(b2.providerErrors, 2);
  assert.equal(Date.parse(b2.nextRetryAt) - now2, 60000);
  assert.equal(b2.authBlock.approvalEpoch, 2);
  assert.equal((await tick(d, [], now2 + 86400000)).reason, "PROVIDER_AUTH_REQUIRED");
});
test("Legacy auth block conservatively waits for a new approval", async () => {
  const d = fixture("legacy-auth"),
    a = await boot(d),
    r = receipt(a);
  await tick(d, [obs("dispatch", a, r)]);
  await tick(d, [
    obs("task_status", a, {
      ...r,
      status: "failed",
      workState: "result_available",
      hasPendingChildRuns: false,
      summary: "401 Unauthorized",
    }),
  ]);
  const led = readController(d, k.loadState(d).missionId);
  delete led.features.f1.authBlock;
  saveController(d, led);
  assert.equal((await tick(d, [], Date.now() + 86400000)).reason, "PROVIDER_AUTH_REQUIRED");
  const b = readController(d, k.loadState(d).missionId).features.f1;
  assert.equal(b.authBlock.legacy, true);
  assert.equal(b.authBlock.approvalEpoch, 1);
  reapprove(d);
  assert.equal((await tick(d, [], Date.now() + 86400000)).type, "dispatch");
});
test("Finite 2.2 second fsmonitor blocks every HUD Resume retry", async () => {
  const d = fixture("slow-git", false);
  execFileSync("git", ["init", "-q", d]);
  await k.startMissionRun(
    d,
    {},
    {
      runFeature: async () => ({
        accepted: true,
        taskId: "slow-task",
        childThreadId: "slow-thread",
        runtimeTransport: "t3-delegate-task",
      }),
    },
  );
  const s = k.loadState(d);
  s.status = "paused";
  s.activeWorker.status = "paused";
  s.sessions[0].status = "paused";
  s.revision++;
  k.saveState(d, s);
  const hook = path.join(d, "slow-hook");
  fs.writeFileSync(hook, '#!/bin/sh\n/bin/sleep 2.2\nprintf "\\n"\n', { mode: 0o700 });
  execFileSync("git", ["-C", d, "config", "core.fsmonitor", hook]);
  let calls = 0;
  const hud = await createHandlerHud({
    missionDir: d,
    gitPreflightTimeoutMs: 2000,
    runtimeAdapter: {
      resumeWorker: async () => {
        calls++;
        return { resumed: true };
      },
    },
  });
  const before = fs.readFileSync(k.getMissionPaths(d).statePath, "utf8");
  const replies = [];
  try {
    for (let i = 0; i < 2; i++) {
      const start = Date.now(),
        v = await hud.post("resume");
      replies.push({ elapsedMs: Date.now() - start, ...v });
    }
  } finally {
    await hud.close();
  }
  save("slow-git", { dir: d, replies, calls });
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(k.getMissionPaths(d).statePath, "utf8"), before);
  assert.equal(replies.filter((r) => r.body.code === "GIT_PREFLIGHT_TIMEOUT").length, 2);
  const start = Date.now();
  execFileSync("git", ["-C", d, "status", "--porcelain"]);
  save("slow-git-completion", { elapsedMs: Date.now() - start, normalGitFinished: true });
});
