import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const root = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? process.env.TMPDIR, "a8-r7-"));
const now = 1793000000000;
const dump = (name, data) =>
  fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify(data, null, 2));
const snapshot = (d) => ({
  state: k.loadState(d),
  features: k.loadFeaturesDoc(d),
  records: inspectDispatchRecords(d),
  ledger: readController(d, k.loadState(d).missionId),
});
const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
const obs = (a, response, extra = {}) => ({
  type: "dispatch",
  runId: a.runId,
  featureId: a.featureId,
  intentId: a.intentId,
  response,
  ...extra,
});
async function boot(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: name,
    repoPath: d,
    autopilot: true,
    ownerThreadId: "original-owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", title: "Original title", milestoneId: "m1" }],
  });
  k.approveMissionPlan(d);
  const timer = await tick(d);
  const a = await tick(d, [
    { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
  ]);
  return { d, a };
}
function freshTick(d, observations = [], time = now) {
  return JSON.parse(
    cp.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify(await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))));`,
        d,
        JSON.stringify({ observations, now: time }),
      ],
      { encoding: "utf8" },
    ),
  ).action;
}
test("An old refusal delivered after a newer unknown callback cannot authorize a fresh intent", async () => {
  const { d, a } = await boot("out-of-order");
  applyAutopilotCommand(d, "pause");
  const raw = { accepted: false, code: "PROVIDER_BUSY", providerInvocation: "old-call" };
  const refusal = await tick(d, [obs(a, raw, { deliveryId: "first-delivery" })]);
  applyAutopilotCommand(d, "resume");
  let calls = 0,
    newerError;
  try {
    await k.startMissionRun(
      d,
      {},
      {
        runFeature: async () => {
          calls++;
          return {
            isError: true,
            message: "Newer invocation may have created its child; reply lost",
            providerInvocation: "new-call",
          };
        },
      },
    );
  } catch (e) {
    newerError = { code: e.code, message: e.message };
  }
  const afterUnknown = snapshot(d);
  const late = freshTick(d, [obs(a, raw, { deliveryId: "delayed-redelivery" })], now + 1);
  const afterLate = snapshot(d);
  const future = freshTick(d, [], now + 86400000);
  dump("out-of-order", {
    a,
    refusal,
    calls,
    newerError,
    afterUnknown,
    late,
    afterLate,
    future,
    final: snapshot(d),
  });
  assert.equal(calls, 1);
  assert.equal(afterUnknown.records[0].phase, "inflight");
  assert.notEqual(
    future.type,
    "dispatch",
    "A delayed refusal from an older invocation does not prove the newer invocation was unaccepted",
  );
  assert.equal(k.loadState(d).activeWorker.runId, a.runId);
});
test("Arbitrary hook exception identity fields do not manufacture acceptance", async () => {
  const d = path.join(root, "throw-fields");
  fs.mkdirSync(d);
  k.proposeMission(d, { title: "Thrown object fields", repoPath: d, features: [{ id: "f1" }] });
  let calls = 0;
  const h = await createHandlerHud({
    missionDir: d,
    runtimeAdapter: {
      runFeature: async () => {
        calls++;
        throw Object.assign(new Error("Hook failed before a receipt"), {
          taskId: "diagnostic-task",
          childThreadId: "diagnostic-thread",
        });
      },
    },
  });
  const first = await h.post("approve");
  await h.close();
  const after = snapshot(d);
  const replay = await createHandlerHud({
    missionDir: d,
    runtimeAdapter: {
      runFeature: async () => {
        calls++;
        return {};
      },
    },
  });
  const second = await replay.post("approve");
  await replay.close();
  dump("throw-fields", { first, after, second, calls, final: snapshot(d) });
  assert.equal(first.status, 500);
  assert.equal(calls, 1);
  assert.notEqual(
    after.records[0].phase,
    "accepted",
    "Hook exception metadata alone does not assert successful dispatch",
  );
});

test("Receipt creation time is not replaced by ingestion order for owner observations", async () => {
  const { d, a } = await boot("owner-out-of-order");
  const newer = obs(a, {
    isError: true,
    message: "new invocation result lost",
    producedAt: "2026-10-26T07:33:20Z",
  });
  const older = obs(a, {
    accepted: false,
    code: "PROVIDER_BUSY",
    producedAt: "2026-10-26T07:33:00Z",
  });
  const first = await tick(d, [newer, older]);
  const before = snapshot(d);
  const after = freshTick(d, [], now + 86400000);
  dump("owner-out-of-order", { a, newer, older, first, before, after, final: snapshot(d) });
  assert.notEqual(
    after.type,
    "dispatch",
    "An older refusal cannot prove a newer call with the same idempotency key was never accepted",
  );
});
