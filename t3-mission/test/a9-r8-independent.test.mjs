import { finish as finishA10 } from "./fixtures/a10-fixture.mjs";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController, readObservations } from "../kernel/autopilot-store.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { createT3Adapter } from "../bridge/t3-adapter.mjs";

const root = fs.mkdtempSync(
    path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a9-independent-"),
  ),
  now = 1793000000000;
const ledger = (d) => readController(d, k.loadState(d).missionId);
const snapshot = (d) => ({
  state: k.loadState(d),
  features: k.loadFeaturesDoc(d),
  records: inspectDispatchRecords(d),
  ledger: ledger(d),
});
const dump = (n, v) => fs.writeFileSync(path.join(root, n + ".json"), JSON.stringify(v, null, 2));
const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
const obs = (a, response, type = "dispatch") => ({
  type,
  runId: a.runId,
  featureId: a.featureId,
  intentId: a.intentId,
  ...(type === "dispatch" ? { invocationId: a.invocationId } : {}),
  response,
});
const accept = (task, child = task + "-thread", extra = {}) => ({
  accepted: true,
  taskId: task,
  childThreadId: child,
  ...extra,
});
const status = (a, task, kind, extra = {}) => ({
  ...obs(
    a,
    {
      taskId: task,
      childThreadId: task + "-thread",
      status: kind,
      workState: kind === "running" ? "working" : "result_available",
      hasPendingChildRuns: false,
      ...extra,
    },
    "task_status",
  ),
  taskId: task,
});
function propose(d) {
  k.proposeMission(d, {
    title: "Independent R8 boundary",
    repoPath: d,
    autopilot: true,
    pauseMode: "let_finish",
    ownerThreadId: "owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", maxAttempts: 6 }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000, maxConsecutiveProviderErrors: 10 },
    integration: { branch: "main", auto: true },
  });
  k.approveMissionPlan(d);
}
async function boot(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  propose(d);
  const t = await tick(d),
    a = await tick(d, [
      { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
    ]);
  assert.equal(a.type, "dispatch");
  return { d, a };
}
const fresh = (d, time = now) =>
  JSON.parse(
    cp.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],{now:Number(process.argv[2])})).action));`,
        d,
        String(time),
      ],
      { encoding: "utf8" },
    ),
  );
function result(a, success = true) {
  return {
    version: 1,
    featureId: a.featureId,
    runId: a.runId,
    status: success ? "success" : "failure",
    summary:
      "This independently generated result records completed original work and literal verification evidence for this exact Mission run identity.",
    tests: success ? [{ command: "private-product-check", status: "passed" }] : [],
    discoveredIssues: [],
    whatWasLeftUndone: [],
    commit: success ? "abcdef1234567" : null,
    branch: success ? "feature/original" : null,
  };
}
const fenced = (e) => "```mission-result\n" + JSON.stringify(e) + "\n```";

test("Every unresolved late execution must retain a gate across two consumed attempts", async () => {
  const { d, a } = await boot("two-late-intents");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  const b = await tick(d, [], now + 1000);
  assert.equal(b.type, "dispatch");
  await tick(d, [obs(b, { accepted: false, code: "PROVIDER_BUSY" })], now + 1001);
  const both = await tick(d, [obs(a, accept("late-A")), obs(b, accept("late-B"))], now + 1002);
  const before = snapshot(d);
  const afterB = await tick(d, [status(b, "late-B", "failed")], now + 2002);
  const after = snapshot(d),
    next = fresh(d, now + 3002);
  dump("two-late-intents", { a, b, both, before, afterB, after, next, final: snapshot(d) });
  assert.notEqual(
    afterB.type,
    "dispatch",
    "Late A is still running and has no resolution; finishing late B cannot authorize attempt 3",
  );
  assert.notEqual(next.type, "dispatch");
});

test("User resolution cannot clear current running child using a previous child run terminal", async () => {
  const { d, a } = await boot("stale-terminal");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  await tick(
    d,
    [obs(a, accept("late-A", "late-A-thread", { childRunId: "current-running-turn" }))],
    now + 1,
  );
  const oldTerminal = status(a, "late-A", "cancelled", { childRunId: "previous-terminal-turn" });
  const currentRunning = status(a, "late-A", "running", {
    childRunId: "current-running-turn",
    hasPendingChildRuns: true,
    pendingChildRuns: ["still-running-subtask"],
    workState: "waiting_for_children",
  });
  const pending = await tick(d, [oldTerminal, currentRunning], now + 2);
  const terminalId = readObservations(d).find(
    (row) => row.observation.response.childRunId === "previous-terminal-turn",
  ).id;
  let resolution, error;
  try {
    resolution = k.resolveDispatchEvidence(d, {
      intentId: a.intentId,
      selectedTaskId: "late-A",
      selectedChildThreadId: "late-A-thread",
      terminalObservationIds: [terminalId],
      userConfirmed: true,
      reason: "Select the original task using the supplied terminal evidence.",
    });
  } catch (e) {
    error = { code: e.code, message: e.message };
  }
  const next = fresh(d, now + 1002);
  dump("stale-terminal", {
    a,
    oldTerminal,
    currentRunning,
    pending,
    resolution,
    error,
    next,
    final: snapshot(d),
  });
  assert.equal(
    resolution,
    undefined,
    "Old childRun terminal cannot settle an explicitly known newer running turn with pending child runs",
  );
  assert.equal(error?.code, "DISPATCH_RESOLUTION_UNSETTLED");
});

for (const kind of ["missing-transport", "spawn-ENOENT"])
  test(
    "A proven pre-send " + kind + " failure must remain recoverable without inventing a child",
    async () => {
      const d = path.join(root, kind);
      fs.mkdirSync(d);
      propose(d);
      const env =
        kind === "missing-transport" ? {} : { T3_ACP_MCP_NODE: path.join(d, "does-not-exist") };
      let error;
      try {
        await callMissionTool(
          "StartMissionRun",
          { missionDir: d },
          { adapter: createT3Adapter({ env }) },
        );
      } catch (e) {
        error = { code: e.code, message: e.message };
      }
      const before = snapshot(d);
      let calls = 0,
        retryError;
      try {
        await callMissionTool(
          "StartMissionRun",
          { missionDir: d },
          {
            dispatchAdapter: {
              runFeature: async () => {
                calls++;
                return accept("repaired");
              },
            },
          },
        );
      } catch (e) {
        retryError = { code: e.code, message: e.message };
      }
      let action = await tick(d);
      if (action.type === "ensure_timer")
        action = await tick(d, [
          {
            type: "timer",
            requestId: action.requestId,
            response: { taskId: "timer", enabled: true },
          },
        ]);
      const recovery = action;
      if (action.type === "recover_dispatch")
        action = await tick(d, [
          {
            type: "children",
            featureId: action.featureId,
            runId: action.runId,
            intentId: action.intentId,
            response: { threads: [] },
          },
        ]);
      dump(kind, { error, before, retryError, calls, recovery, action, after: snapshot(d) });
      assert.equal(
        before.records[0].phase,
        "retryable",
        "No executable/transport exists, so no external dispatch was sent",
      );
      assert.equal(calls, 1);
    },
  );

test("Auditing original late success after a second consumed attempt still allows Mission completion", async () => {
  const { d, a } = await boot("late-adoption-newer-attempt");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  const b = await tick(d, [], now + 1000);
  await tick(d, [obs(b, { accepted: false, code: "PROVIDER_BUSY" })], now + 1001);
  await tick(d, [obs(a, accept("late-A"))], now + 1002);
  const late = await tick(
    d,
    [status(a, "late-A", "completed", { summary: fenced(result(a)) })],
    now + 1003,
  );
  assert.notEqual(late.kind, "integrate");
  assert.equal(k.loadFeaturesDoc(d).features[0].status, "pending");
  assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
  assert.equal(Object.values(ledger(d).dispatchResolutions)[0].result.raw, fenced(result(a)));
  const action = await tick(d, [], now + 2002);
  assert.equal(action.type, "dispatch");
  assert.equal(action.attempt, 3);
  await finishA10(d, action, now + 3000);
  assert.equal(k.loadFeaturesDoc(d).features.find((f) => f.id === "f1").status, "completed");
  assert.equal(fresh(d, now + 100000).type, "done");
  dump("late-adoption-newer-attempt", { a, b, late, action, final: snapshot(d) });
});
