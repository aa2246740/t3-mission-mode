import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { delegateMissionTask, callT3McpTool, createT3Adapter } from "../bridge/t3-adapter.mjs";
function init() {
  const d = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a9-capacity-"));
  k.proposeMission(d, { repoPath: d, features: [{ id: "f1" }] });
  k.approveMissionPlan(d);
  return d;
}
test("A9 bounded invocation journal stops on retry budget before capacity, including retarget", async () => {
  const d = init();
  let calls = 0;
  const adapter = {
    runFeature: async () => {
      calls++;
      return { accepted: false, code: "PROVIDER_BUSY" };
    },
  };
  for (let n = 0; n < 5; n++) await assert.rejects(() => k.startMissionRun(d, {}, adapter));
  assert.equal(calls, 5);
  const key = inspectDispatchRecords(d)[0].intent.clientRequestId;
  await assert.rejects(() => k.startMissionRun(d, {}, adapter), {
    code: "DISPATCH_RETRY_BUDGET_EXHAUSTED",
  });
  assert.equal(calls, 5);
  await assert.rejects(() => k.startMissionRun(d, {}, adapter), {
    code: "DISPATCH_RETRY_BUDGET_EXHAUSTED",
  });
  assert.equal(calls, 5);
  k.updateMissionFeatures(d, {
    modelSettings: { worker: { providerInstanceId: "codex", model: "replacement", options: {} } },
  });
  await assert.rejects(() => k.startMissionRun(d, {}, adapter), {
    code: "DISPATCH_RETRY_BUDGET_EXHAUSTED",
  });
  assert.equal(calls, 5);
  const journal = fs.readdirSync(path.join(d, ".mission")).find((n) => n.startsWith("dispatch-"));
  const raw = JSON.parse(fs.readFileSync(path.join(d, ".mission", journal)));
  assert.equal(raw.invocations.length, 5);
  assert.equal(raw.invocations.at(-1).phase, "returned");
  assert.equal(raw.intent.clientRequestId, key);
});
for (const code of ["ENOENT", "EACCES"])
  test("A9 actual execFile spawn " + code + " supplies pre-send proof", async () => {
    const d = init(),
      bin = path.join(d, "executable");
    if (code === "EACCES") {
      fs.writeFileSync(bin, "#!/bin/sh\n");
      fs.chmodSync(bin, 0o600);
    }
    await assert.rejects(() =>
      k.startMissionRun(d, {}, createT3Adapter({ env: { T3_ACP_MCP_NODE: bin } })),
    );
    const record = inspectDispatchRecords(d)[0];
    assert.equal(record.phase, "retryable");
    assert.deepEqual(record.invocations[0].receipts, [{ accepted: false, code, preSend: true }]);
    assert.equal(record.invocations[0].exception.code, code);
    assert.match(record.invocations[0].exception.message, new RegExp(code));
  });
test("A9 local validation supplies proof, but a transport error named ENOENT remains unknown", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      delegateMissionTask(
        { task: "private", target: { providerInstanceId: "codex" } },
        {
          transportClient: () => {
            calls++;
          },
        },
      ),
    (e) => e.runtimeResult?.accepted === false && e.runtimeResult.preSend === true,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      callT3McpTool(
        "delegate_task",
        {},
        {
          transportClient: () => {
            throw Object.assign(new Error("external failure"), {
              code: "ENOENT",
              syscall: "spawn fake",
            });
          },
        },
      ),
    (e) => e.code === "ENOENT" && !Object.hasOwn(e, "runtimeResult"),
  );
});

for (const effectAccepted of [false, undefined])
  test(`A9 legacy runtime effect ${effectAccepted === false ? "refusal" : "unknown"} shares verdict and consumed evidence`, async () => {
    const { runClaimedEffect } = await import("../kernel/mission-transaction.mjs");
    const { readController } = await import("../kernel/autopilot-store.mjs");
    const d = init(),
      s = k.loadState(d);
    k.proposeMission(d, {
      ...s,
      autopilot: true,
      ownerThreadId: "owner",
      features: k.loadFeaturesDoc(d).features,
      milestones: [{ id: "m1" }],
      retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
    });
    k.approveMissionPlan(d);
    let calls = 0;
    await assert.rejects(() =>
      k.startMissionRun(
        d,
        {},
        {
          runFeature: async () => {
            calls++;
            return { accepted: false, code: "PROVIDER_BUSY" };
          },
        },
      ),
    );
    const record = inspectDispatchRecords(d)[0],
      key = `runtime-dispatch:${record.intent.missionId}:${record.intent.runId}:${record.intent.clientRequestId}`;
    await runClaimedEffect(d, key, async () =>
      effectAccepted === false ? { accepted: false, code: "OLD_RUNTIME_REFUSAL" } : {},
    );
    const first = (await k.missionTick(d, { now: 1793000000000 })).action;
    const action = (
      await k.missionTick(d, {
        now: 1793000000000,
        observations: [
          {
            type: "timer",
            requestId: first.requestId,
            response: { taskId: "timer", enabled: true },
          },
        ],
      })
    ).action;
    assert.equal(calls, 1);
    assert.equal(action.type, effectAccepted === false ? "sleep" : "recover_dispatch");
    const run = readController(d, k.loadState(d).missionId).runs[record.intent.runId];
    if (effectAccepted === false) {
      assert.equal(run.result.rejectionEvidence.length, 2);
      assert.equal(run.result.rejectionEvidence[1].raw.code, "OLD_RUNTIME_REFUSAL");
      assert.equal(run.result.rejectionEvidence[1].invocationId, "effect:" + key);
    } else assert.equal(run.result, undefined);
  });

test("A9 mixed callback refusals preserve authentication priority and the longest real Retry-After", async () => {
  const { readController } = await import("../kernel/autopilot-store.mjs");
  const d = init(),
    s = k.loadState(d);
  k.proposeMission(d, {
    ...s,
    autopilot: true,
    ownerThreadId: "owner",
    features: k.loadFeaturesDoc(d).features,
    milestones: [{ id: "m1" }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
  });
  k.approveMissionPlan(d);
  const values = [
    { accepted: false, code: "PROVIDER_BUSY", headers: { "Retry-After": "60" } },
    {
      accepted: false,
      isError: true,
      message: "401 Unauthorized",
      headers: { "Retry-After": "25" },
    },
  ];
  let calls = 0;
  for (let i = 0; i < 2; i++)
    await assert.rejects(() =>
      k.startMissionRun(d, {}, { runFeature: async () => values[calls++] }),
    );
  const timer = (await k.missionTick(d, { now: 1793000000000 })).action;
  const next = (
    await k.missionTick(d, {
      now: 1793000000000,
      observations: [
        { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
      ],
    })
  ).action;
  const ledger = readController(d, k.loadState(d).missionId);
  assert.equal(next.reason, "PROVIDER_AUTH_REQUIRED");
  assert.equal(ledger.features.f1.providerErrors, 1);
  assert.equal(ledger.features.f1.nextRetryAt, "2026-10-26T07:34:20.000Z");
  assert.equal(calls, 2);
});
