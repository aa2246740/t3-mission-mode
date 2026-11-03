import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as k from "../kernel/index.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";

const cliPath = fileURLToPath(new URL("../bridge/cli.mjs", import.meta.url));
const NOW = Date.parse("2026-10-23T11:00:00Z");
const A = {
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "max", serviceTier: "priority" },
};
const B = { ...A, providerInstanceId: "codex-approved-recovery" };
const C = { ...A, model: "new-approved-primary" };
const tick = async (dir, observations = [], now = NOW) =>
  (await k.missionTick(dir, { observations, now })).action;
const ledger = (dir) => readController(dir, k.loadState(dir).missionId);
const journal = (dir) => inspectDispatchRecords(dir);
const role = (kind) => (["scrutiny", "user_testing"].includes(kind) ? "validator" : "worker");
const observation = (type, action, response) => ({
  type,
  runId: action.runId,
  featureId: action.featureId,
  intentId: action.intentId,
  taskId: action.taskId,
  response,
});
const cli = (dir, command, payload = {}) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [cliPath, command, "--mission-dir", dir, "--json", JSON.stringify(payload)],
      { encoding: "utf8" },
    ),
  );
const cliTick = (dir, now) => cli(dir, "MissionTick", { now }).action;
function snapshot(dir) {
  const result = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else
        result[path.relative(dir, file)] = [
          fs.readFileSync(file).toString("base64"),
          fs.statSync(file, { bigint: true }).mtimeNs.toString(),
        ];
    }
  };
  walk(path.join(dir, ".mission"));
  return result;
}
function evidence(name, dir, trace) {
  if (!process.env.R2_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.R2_EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.R2_EVIDENCE_DIR, name + ".json"),
    JSON.stringify(
      {
        trace,
        state: k.loadState(dir),
        features: k.loadFeaturesDoc(dir),
        ledger: ledger(dir),
        journal: journal(dir),
      },
      null,
      2,
    ) + "\n",
  );
}
function fresh(t, { kind = "implementation", autopilot = true, features, featureTarget = A } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = {
    autopilot,
    repoPath: dir,
    title: "Approval recovery fixture",
    ownerThreadId: "fixture-owner",
    milestones: [{ id: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    features: features ?? [
      {
        id: "f1",
        title: "Feature",
        milestoneId: "m1",
        kind,
        maxAttempts: 6,
        ...(featureTarget ? { target: featureTarget } : {}),
      },
    ],
    modelSettings: { worker: A, validator: A },
    integration: { auto: true, branch: "mission/fixture" },
    fallbackTargets: {
      worker: role(kind) === "worker" ? [B] : [],
      validator: role(kind) === "validator" ? [B] : [],
    },
  };
  k.proposeMission(dir, input);
  return { dir, input };
}
async function accepted(dir, action) {
  const receipt = {
    accepted: true,
    taskId: "task-" + action.runId,
    childThreadId: "child-" + action.runId,
    childRunId: "turn-" + action.runId,
    ...action.delegateTask.target,
    status: "running",
    workState: "working",
    hasPendingChildRuns: false,
  };
  const poll = await tick(dir, [observation("dispatch", action, receipt)]);
  assert.equal(poll.type, "poll");
  return { receipt, poll };
}
async function backoff(t, options) {
  const f = fresh(t, options);
  k.approveMissionPlan(f.dir);
  const timer = await tick(f.dir);
  const first = await tick(f.dir, [
    {
      type: "timer",
      requestId: timer.requestId,
      response: { scheduledTaskId: "fixture-timer", enabled: true },
    },
  ]);
  assert.equal(first.type, "dispatch");
  const { receipt, poll } = await accepted(f.dir, first);
  const sleep = await tick(f.dir, [
    observation("task_status", poll, {
      ...receipt,
      status: "failed",
      workState: "result_available",
      summary: "429 rate limit",
      headers: { "Retry-After": "60" },
    }),
  ]);
  assert.equal(sleep.type, "sleep");
  assert.deepEqual(ledger(f.dir).features.f1.target, B);
  return { ...f, first, at: Date.parse(sleep.until), sleep };
}
function reapprove(
  f,
  primary = A,
  explicitFeatureTarget = true,
  fallbackTargets = { worker: [], validator: [] },
) {
  const features = k.loadFeaturesDoc(f.dir).features;
  if (explicitFeatureTarget) features[0].target = structuredClone(primary);
  k.rejectMissionPlan(f.dir, "Explicitly approve the current primary");
  k.proposeMission(f.dir, {
    ...f.input,
    features,
    modelSettings: { worker: primary, validator: primary },
    fallbackTargets,
  });
  k.approveMissionPlan(f.dir);
}

for (const [name, primary] of [
  ["original-A", A],
  ["new-primary-B", B],
])
  test(`R2 recovery reapproved primary ${name} preserves backoff and history across fresh CLI processes`, async (t) => {
    const f = await backoff(t);
    const beforeLedger = ledger(f.dir),
      oldRecords = journal(f.dir),
      oldSession = k.loadState(f.dir).sessions[0];
    reapprove(f, primary);
    const approved = k.loadState(f.dir),
      beforeSleep = snapshot(f.dir);
    const sleep = cliTick(f.dir, f.at - 1);
    assert.equal(sleep.type, "sleep");
    assert.equal(sleep.until, f.sleep.until);
    const current = ledger(f.dir),
      invalidated = current.features.f1.invalidatedFallbacks?.[0];
    const sleeping = snapshot(f.dir);
    assert.deepEqual(cliTick(f.dir, f.at - 1), sleep);
    assert.deepEqual(snapshot(f.dir), sleeping);
    const second = cliTick(f.dir, f.at);
    assert.equal(second.type, "dispatch");
    assert.deepEqual(second.delegateTask.target, primary);
    assert.equal(approved.planApprovalEpoch, 2);
    assert.deepEqual(invalidated, {
      target: B,
      invalidatedAt: new Date(f.at - 1).toISOString(),
      reason: "superseded_by_approval",
      approvalEpoch: 1,
      supersededByApprovalEpoch: 2,
    });
    assert.equal(Object.hasOwn(current.features.f1, "target"), false);
    assert.equal(current.features.f1.providerErrors, 1);
    assert.equal(current.consecutiveProviderErrors, 1);
    assert.equal(current.features.f1.nextRetryAt, f.sleep.until);
    assert.deepEqual(current.features.f1.switches, beforeLedger.features.f1.switches);
    assert.deepEqual(current.runs, beforeLedger.runs);
    assert.notDeepEqual(sleeping, beforeSleep, "The invalidation is persisted once");
    assert.equal(second.attempt, 2);
    assert.notEqual(second.runId, f.first.runId);
    assert.notEqual(second.intentId, f.first.intentId);
    assert.deepEqual(k.loadFeaturesDoc(f.dir).features[0].target, primary);
    assert.deepEqual(k.loadState(f.dir).sessions[0], oldSession);
    assert.deepEqual(
      journal(f.dir).find((r) => r.intent.runId === f.first.runId),
      oldRecords[0],
    );
    const dispatched = snapshot(f.dir),
      recovery = cliTick(f.dir, f.at + 1);
    assert.equal(recovery.type, "recover_dispatch");
    assert.equal(recovery.intentId, second.intentId);
    assert.deepEqual(snapshot(f.dir), dispatched);
    const { poll } = await accepted(f.dir, second);
    const bound = snapshot(f.dir);
    assert.deepEqual(cliTick(f.dir, f.at + 2), poll);
    assert.deepEqual(snapshot(f.dir), bound);
    evidence(name, f.dir, [sleep, second, recovery, poll]);
  });

const changes = {
  removed: [],
  provider: [{ ...B, providerInstanceId: "other-provider" }],
  model: [{ ...B, model: "different-model" }],
  effort: [{ ...B, options: { ...B.options, reasoningEffort: "high" } }],
  service: [{ ...B, options: { ...B.options, serviceTier: "default" } }],
  missingOption: [{ ...B, options: { reasoningEffort: "max" } }],
  extraOption: [{ ...B, options: { ...B.options, extra: true } }],
};
for (const kind of ["implementation", "scrutiny"])
  for (const [change, targets] of Object.entries(changes))
    test(`R2 same epoch revoked exact ${kind} ${change} remains wait_user with zero writes`, async (t) => {
      const f = await backoff(t, { kind });
      const state = k.loadState(f.dir),
        epoch = state.planApprovalEpoch;
      state.fallbackTargets = {
        worker: role(kind) === "worker" ? targets : [],
        validator: role(kind) === "validator" ? targets : [],
      };
      k.saveState(f.dir, state); // Revoke the role policy without a later approval.
      const before = snapshot(f.dir),
        records = journal(f.dir),
        oldLedger = ledger(f.dir);
      const action = await tick(f.dir, [], f.at),
        reopened = cliTick(f.dir, f.at + 60000);
      assert.equal(action.type, "wait_user");
      assert.equal(action.reason, "FALLBACK_APPROVAL_REVOKED");
      assert.equal(action.role, role(kind));
      assert.deepEqual(reopened, action);
      assert.deepEqual(snapshot(f.dir), before);
      assert.deepEqual(journal(f.dir), records);
      assert.deepEqual(ledger(f.dir), oldLedger);
      assert.equal(k.loadFeaturesDoc(f.dir).features[0].attempts, 1);
      assert.equal(k.loadState(f.dir).planApprovalEpoch, epoch);
    });

for (const phase of ["accepted", "unknown"])
  test(`R2 reapproval retains ${phase} intent and never dispatches again`, async (t) => {
    const f = await backoff(t);
    const second = await tick(f.dir, [], f.at);
    assert.equal(second.type, "dispatch");
    if (phase === "accepted") await accepted(f.dir, second);
    reapprove(f);
    const before = snapshot(f.dir),
      records = journal(f.dir),
      budget = ledger(f.dir);
    const action = cliTick(f.dir, f.at),
      repeat = cliTick(f.dir, f.at + 1000);
    assert.equal(action.type, phase === "accepted" ? "poll" : "recover_dispatch");
    assert.equal(action.runId, second.runId);
    assert.deepEqual(repeat, action);
    assert.deepEqual(snapshot(f.dir), before);
    assert.deepEqual(journal(f.dir), records);
    assert.deepEqual(ledger(f.dir), budget);
    assert.equal(k.loadState(f.dir).sessions.length, 2);
    assert.equal(k.loadFeaturesDoc(f.dir).features[0].attempts, 2);
    evidence("unresolved-" + phase, f.dir, [second, action, repeat]);
  });

test("R2 authorized fallback affects only dispatch, Bind and intent, preserving the user primary for a later slot approval", async (t) => {
  const f = await backoff(t, { featureTarget: null });
  reapprove(f, A, false, { worker: [B], validator: [] });
  const second = cliTick(f.dir, f.at);
  assert.equal(second.type, "dispatch");
  assert.deepEqual(second.delegateTask.target, B);
  assert.equal(k.loadFeaturesDoc(f.dir).features[0].target, undefined);
  assert.equal(
    k.resolveFeatureSlot(k.loadFeaturesDoc(f.dir).features[0], k.loadModelSettings(f.dir))
      .slotConfig.providerInstanceId,
    A.providerInstanceId,
  );
  assert.deepEqual(journal(f.dir).find((r) => r.intent.runId === second.runId).intent.target, B);
  const { receipt, poll } = await accepted(f.dir, second);
  assert.equal(k.loadFeaturesDoc(f.dir).features[0].target, undefined);
  const sleep = await tick(
    f.dir,
    [
      observation("task_status", poll, {
        ...receipt,
        status: "failed",
        workState: "result_available",
        summary: "429 rate limit",
        headers: { "Retry-After": "60" },
      }),
    ],
    f.at,
  );
  reapprove(f, C, false);
  const third = cliTick(f.dir, Date.parse(sleep.until));
  assert.equal(third.type, "dispatch");
  assert.deepEqual(third.delegateTask.target, C);
  assert.equal(third.attempt, 3);
  assert.equal(ledger(f.dir).features.f1.providerErrors, 2);
  assert.equal(ledger(f.dir).consecutiveProviderErrors, 2);
  assert.equal(k.loadFeaturesDoc(f.dir).features[0].target, undefined);
  evidence("dispatch-only-fallback", f.dir, [second, sleep, third]);
});

for (const entry of ["kernel", "MCP", "CLI", "autopilot-command", "HUD-autopilot", "HUD-legacy"])
  test(`R2 approval epoch transitions and idempotence agree through ${entry}`, async (t) => {
    const f = fresh(t, { autopilot: entry !== "HUD-legacy", features: [] });
    let hud;
    if (entry.startsWith("HUD-"))
      hud = await createHandlerHud({
        missionDir: f.dir,
        dispatchAdapter: { runFeature: async () => assert.fail("Empty plan cannot dispatch") },
      });
    const approve = async () => {
      if (entry === "kernel") k.approveMissionPlan(f.dir);
      else if (entry === "MCP")
        await callMissionTool("ApproveMissionPlan", {}, { missionDir: f.dir, kernel: k });
      else if (entry === "CLI") cli(f.dir, "ApproveMissionPlan");
      else if (entry === "autopilot-command") applyAutopilotCommand(f.dir, "approve");
      else assert.equal((await hud.post("approve")).status, 200);
    };
    try {
      assert.equal(k.loadState(f.dir).planApprovalEpoch, 0);
      await approve();
      assert.equal(k.loadState(f.dir).planApprovalEpoch, 1);
      assert.ok(Number.isFinite(Date.parse(k.loadState(f.dir).planApprovedAt)));
      const first = snapshot(f.dir);
      await approve();
      assert.deepEqual(snapshot(f.dir), first);
      for (const [status, epoch] of [
        ["planning", 2],
        ["awaiting_input", 3],
      ]) {
        const state = k.loadState(f.dir);
        state.status = status;
        k.saveState(f.dir, state);
        await approve();
        assert.equal(k.loadState(f.dir).planApprovalEpoch, epoch);
        const after = snapshot(f.dir);
        await approve();
        assert.deepEqual(snapshot(f.dir), after);
      }
      const priorAt = k.loadState(f.dir).planApprovedAt;
      k.rejectMissionPlan(f.dir, "Replan");
      k.proposeMission(f.dir, { ...f.input, planApprovalEpoch: 999, planApprovedAt: "forged" });
      assert.equal(k.loadState(f.dir).planApprovalEpoch, 3);
      assert.equal(k.loadState(f.dir).planApprovedAt, priorAt);
      await approve();
      assert.equal(k.loadState(f.dir).planApprovalEpoch, 4);
      evidence("entry-" + entry, f.dir, []);
    } finally {
      await hud?.close();
    }
  });

test("R2 Pause and Resume never count as a plan approval", async (t) => {
  const f = fresh(t);
  k.approveMissionPlan(f.dir);
  const { planApprovalEpoch, planApprovedAt } = k.loadState(f.dir);
  applyAutopilotCommand(f.dir, "pause");
  applyAutopilotCommand(f.dir, "resume");
  assert.equal(k.loadState(f.dir).planApprovalEpoch, planApprovalEpoch);
  assert.equal(k.loadState(f.dir).planApprovedAt, planApprovedAt);
});

test("R2 legacy HUD starts an approved staged dispatch without a new approval, then repeats with zero writes", async (t) => {
  const f = fresh(t, { autopilot: false });
  k.approveMissionPlan(f.dir);
  let calls = 0;
  const hud = await createHandlerHud({
    missionDir: f.dir,
    dispatchAdapter: {
      runFeature: async () => {
        calls++;
        return { accepted: true, taskId: "legacy-task", childThreadId: "legacy-child", ...A };
      },
    },
  });
  try {
    const approved = k.loadState(f.dir);
    assert.equal((await hud.post("approve")).status, 200);
    assert.equal(k.loadState(f.dir).activeWorker?.taskId, "legacy-task");
    assert.equal(calls, 1);
    assert.equal(k.loadState(f.dir).planApprovalEpoch, approved.planApprovalEpoch);
    assert.equal(k.loadState(f.dir).planApprovedAt, approved.planApprovedAt);
    const before = snapshot(f.dir);
    assert.equal((await hud.post("approve")).status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(snapshot(f.dir), before);
  } finally {
    await hud.close();
  }
});

test("R2 pre-epoch cached fallback fails closed until explicit approval", async (t) => {
  const f = await backoff(t);
  const state = k.loadState(f.dir);
  delete state.planApprovalEpoch;
  delete state.planApprovedAt;
  state.fallbackTargets = {};
  k.saveState(f.dir, state);
  const file = path.join(f.dir, ".mission/autopilot/controller.json");
  const legacy = ledger(f.dir);
  delete legacy.features.f1.approvalEpoch;
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(cliTick(f.dir, f.at).reason, "FALLBACK_APPROVAL_REVOKED");
  k.rejectMissionPlan(f.dir, "Approve primary");
  k.approveMissionPlan(f.dir);
  const action = cliTick(f.dir, f.at);
  assert.equal(action.type, "dispatch");
  assert.deepEqual(action.delegateTask.target, A);
  const audit = ledger(f.dir).features.f1.invalidatedFallbacks[0];
  assert.equal(audit.approvalEpoch, 0);
  assert.equal(audit.supersededByApprovalEpoch, 1);
});
