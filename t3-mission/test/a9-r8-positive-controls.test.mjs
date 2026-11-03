import { finish as finishA10 } from "./fixtures/a10-fixture.mjs";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController, readObservations } from "../kernel/autopilot-store.mjs";
const root = fs.mkdtempSync(
    path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a9-positive-controls-"),
  ),
  now = 1793000000000;
const tick = async (d, o = [], time = now) =>
  (await k.missionTick(d, { observations: o, now: time })).action;
const obs = (a, response, type = "dispatch") => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  ...(type === "dispatch" ? { invocationId: a.invocationId } : {}),
  response,
});
const status = (a, task, kind, extra = {}) => ({
  ...obs(
    a,
    {
      taskId: task,
      childThreadId: task + "-thread",
      status: kind,
      workState: "result_available",
      hasPendingChildRuns: false,
      ...extra,
    },
    "task_status",
  ),
  taskId: task,
});
function init(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: "Positive control",
    repoPath: d,
    autopilot: true,
    ownerThreadId: "owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
    integration: { branch: "main", auto: true },
  });
  k.approveMissionPlan(d);
  return d;
}
async function boot(name) {
  const d = init(name),
    t = await tick(d),
    a = await tick(d, [
      { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
    ]);
  return { d, a };
}
const accepted = (t) => ({ accepted: true, taskId: t, childThreadId: t + "-thread" });
const result = (a) => ({
  version: 1,
  featureId: a.featureId,
  runId: a.runId,
  status: "success",
  summary:
    "The original work is complete and the independent literal checks verify the exact result with a durable matching commit and branch.",
  tests: [{ command: "private-check", status: "passed" }],
  discoveredIssues: [],
  whatWasLeftUndone: [],
  commit: "abcdef1234567",
  branch: "feature/original",
});
const fenced = (e) => "```mission-result\n" + JSON.stringify(e) + "\n```";
test("Explicit returned runtimeResult refusal is retryable; ordinary thrown diagnostic refusal is fenced", async () => {
  for (const explicit of [false, true]) {
    const d = init("proof-" + explicit);
    let calls = 0;
    const adapter = {
      runFeature: async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(
            new Error("before send"),
            explicit ? { runtimeResult: { accepted: false } } : { dispatchOutcome: "rejected" },
          );
        return accepted("actual");
      },
    };
    await assert.rejects(() => k.startMissionRun(d, {}, adapter));
    assert.equal(inspectDispatchRecords(d)[0].phase, explicit ? "retryable" : "inflight");
    if (explicit) await k.startMissionRun(d, {}, adapter);
    else await assert.rejects(() => k.startMissionRun(d, {}, adapter));
    assert.equal(calls, explicit ? 2 : 1);
  }
});
test("A sole unresolved late execution polls until a real matching terminal status arrives", async () => {
  const { d, a } = await boot("single-late");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  assert.equal((await tick(d, [obs(a, accepted("old"))])).type, "poll");
  assert.equal(
    (await tick(d, [status(a, "old", "running", { workState: "working" })], now + 1000)).type,
    "poll",
  );
  const done = await tick(d, [status(a, "old", "failed")], now + 2000);
  assert.equal(done.type, "dispatch");
  const l = readController(d, k.loadState(d).missionId);
  assert.equal(Object.keys(l.dispatchResolutions).length, 1);
  assert.equal(l.dispatchEvidenceError, undefined);
});
test("A valid current terminal for every conflicting execution permits explicit user reconciliation", async () => {
  const { d, a } = await boot("valid-resolution");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  await tick(d, [obs(a, accepted("first"))]);
  await tick(d, [obs(a, accepted("second"))]);
  await tick(d, [status(a, "first", "cancelled"), status(a, "second", "failed")]);
  const ids = readObservations(d)
    .filter((r) => r.observation.type === "task_status")
    .map((r) => r.id);
  const res = k.resolveDispatchEvidence(d, {
    intentId: a.intentId,
    selectedTaskId: "first",
    selectedChildThreadId: "first-thread",
    terminalObservationIds: ids,
    userConfirmed: true,
    reason: "The user selected the original after all current executions proved stopped.",
  });
  assert.ok(res.resolutionId);
  assert.equal((await tick(d, [], now + 1000)).type, "dispatch");
});
test("The same late success driver audits the original then completes a normal attempt", async () => {
  const { d, a } = await boot("single-adoption");
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  await tick(d, [obs(a, accepted("old"))]);
  const late = await tick(d, [status(a, "old", "completed", { summary: fenced(result(a)) })]);
  assert.notEqual(late.kind, "integrate");
  assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
  assert.equal(
    Object.values(readController(d, k.loadState(d).missionId).dispatchResolutions)[0].result.raw,
    fenced(result(a)),
  );
  const action = await tick(d, [], now + 1000);
  assert.equal(action.type, "dispatch");
  assert.equal(action.attempt, 2);
  await finishA10(d, action, now + 2000);
  assert.equal((await tick(d, [], now + 100000)).type, "done");
});
