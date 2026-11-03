import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords, dispatchRecordOutcome } from "../kernel/dispatch-journal.mjs";
import { runCli } from "../bridge/cli.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const root = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a9-runtime-"));
for (const entry of ["kernel", "HUD-default"])
  for (const shape of ["accepted", "empty", "throw"])
    test(`A9 runtime outer token ${entry} ${shape}`, async () => {
      const d = path.join(root, entry + "-" + shape);
      fs.mkdirSync(d);
      k.proposeMission(d, {
        title: "Token scoped callback",
        repoPath: d,
        autopilot: entry === "kernel",
        ownerThreadId: "owner",
        milestones: [{ id: "m1" }],
        features: [{ id: "f1", milestoneId: "m1" }],
      });
      const shim = path.join(d, "transport.mjs"),
        calls = path.join(d, "calls.txt");
      fs.writeFileSync(
        shim,
        `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'entered\\n');${shape === "throw" ? "process.stderr.write('request entered, reply lost');process.exitCode=1;" : `console.log(${JSON.stringify(shape === "accepted" ? JSON.stringify({ accepted: true, taskId: "actual-task", childThreadId: "actual-child" }) : "{}")});`}`,
      );
      const saved = { node: process.env.T3_ACP_MCP_NODE, entry: process.env.T3_ACP_MCP_ENTRYPOINT };
      process.env.T3_ACP_MCP_NODE = process.execPath;
      process.env.T3_ACP_MCP_ENTRYPOINT = shim;
      let payload, error, response;
      try {
        if (entry === "kernel") {
          k.approveMissionPlan(d);
          try {
            response = await k.startMissionRun(
              d,
              {},
              {
                runFeature: async (feature, slotConfig, state) => {
                  payload = {
                    missionId: state.missionId,
                    runId: feature.runId,
                    feature,
                    slotConfig,
                    repoPath: d,
                  };
                  const res = await runCli(
                    [
                      "DispatchWorkerRuntime",
                      "--mission-dir",
                      d,
                      "--json",
                      JSON.stringify(payload),
                    ],
                    { stdout: { write() {} }, stderr: { write() {} } },
                  );
                  if (res.exitCode) throw new Error(res.code);
                  return res.result;
                },
              },
            );
          } catch (e) {
            error = e.code;
          }
        } else {
          const h = await createHandlerHud({ missionDir: d });
          try {
            response = await h.post("approve");
          } finally {
            await h.close();
          }
        }
        assert.ok(fs.existsSync(calls), JSON.stringify({ entry, shape, error, response }));
        const record = inspectDispatchRecords(d)[0];
        assert.equal(fs.readFileSync(calls, "utf8"), "entered\n");
        assert.equal(record.invocations.length, 1);
        assert.equal(record.invocations[0].runtimeClaimed, true);
        assert.equal(
          dispatchRecordOutcome(d, record).outcome,
          shape === "accepted" ? "ACCEPTED" : "UNKNOWN",
        );
        if (!payload)
          payload = {
            missionId: record.intent.missionId,
            runId: record.intent.runId,
            feature: {
              ...record.intent.feature,
              clientRequestId: record.intent.clientRequestId,
              invocationId: record.invocations[0].invocationId,
            },
            slotConfig: record.intent.target,
            repoPath: d,
          };
        for (const change of [
          {},
          { feature: { ...payload.feature, invocationId: "inv:forged" } },
          { slotConfig: { ...payload.slotConfig, model: "other" } },
        ]) {
          const replay = await runCli(
            [
              "DispatchWorkerRuntime",
              "--mission-dir",
              d,
              "--json",
              JSON.stringify({ ...payload, ...change }),
            ],
            { stdout: { write() {} }, stderr: { write() {} } },
          );
          assert.notEqual(replay.exitCode, undefined);
          assert.equal(fs.readFileSync(calls, "utf8"), "entered\n");
        }
        if (shape !== "accepted") {
          const state = k.loadState(d);
          state.autopilot = true;
          k.saveState(d, state);
          const t = (await k.missionTick(d, { now: 1793000000000 })).action;
          const action = (
            await k.missionTick(d, {
              now: 1793000000000,
              observations: [
                ...(t.type === "ensure_timer"
                  ? [
                      {
                        type: "timer",
                        requestId: t.requestId,
                        response: { taskId: "timer", enabled: true },
                      },
                    ]
                  : []),
                {
                  type: "dispatch",
                  featureId: "f1",
                  runId: record.intent.runId,
                  intentId: record.intent.clientRequestId,
                  invocationId: record.invocations[0].invocationId,
                  response: { accepted: false, code: "PROVIDER_BUSY" },
                },
              ],
            })
          ).action;
          assert.equal(action.type, "recover_dispatch");
          assert.equal(k.loadFeaturesDoc(d).features[0].attempts, 1);
        }
      } finally {
        for (const [name, value] of [
          ["T3_ACP_MCP_NODE", saved.node],
          ["T3_ACP_MCP_ENTRYPOINT", saved.entry],
        ])
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });

test("A9 a runtime claim remains UNKNOWN while its transport has not returned", async () => {
  const { dispatchRuntimeInvocation } = await import("../kernel/dispatch-journal.mjs");
  const d = path.join(root, "unreturned-runtime");
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: "Claim before transport",
    repoPath: d,
    autopilot: true,
    ownerThreadId: "owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
  });
  k.approveMissionPlan(d);
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    reply = new Promise((r) => {
      release = r;
    });
  let calls = 0;
  const running = k.startMissionRun(
    d,
    {},
    {
      runFeature: async (feature, slotConfig, state) =>
        dispatchRuntimeInvocation(
          d,
          { missionId: state.missionId, runId: feature.runId, feature, slotConfig },
          async () => {
            calls++;
            entered();
            return reply;
          },
          () => {},
        ),
    },
  );
  try {
    await ready;
    const record = inspectDispatchRecords(d)[0];
    assert.deepEqual(record.invocations[0].receipts, [{}]);
    const first = (
      await k.missionTick(d, {
        now: 1793000000000,
        observations: [
          {
            type: "dispatch",
            runId: record.intent.runId,
            featureId: "f1",
            intentId: record.intent.clientRequestId,
            invocationId: record.invocations[0].invocationId,
            response: { accepted: false, code: "PROVIDER_BUSY" },
          },
        ],
      })
    ).action;
    const next = (
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
    assert.equal(next.type, "recover_dispatch");
    assert.equal(k.loadState(d).activeWorker.runId, record.intent.runId);
    assert.equal(k.loadFeaturesDoc(d).features[0].attempts, 1);
    assert.equal(calls, 1);
  } finally {
    release({
      accepted: true,
      taskId: "original-runtime-task",
      childThreadId: "original-runtime-thread",
    });
    await running;
  }
  assert.equal(inspectDispatchRecords(d)[0].phase, "accepted");
  assert.equal(calls, 1);
});
