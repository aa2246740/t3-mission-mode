import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
const root = fs.mkdtempSync(
  path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-receipt-order-"),
);
async function seed(label) {
  const dir = path.join(root, label);
  fs.mkdirSync(dir);
  k.proposeMission(dir, {
    title: label,
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "r6-owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
  });
  k.approveMissionPlan(dir);
  const timer = (await k.missionTick(dir)).action;
  const dispatch = (
    await k.missionTick(dir, {
      observations: [
        { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
      ],
    })
  ).action;
  return { dir, dispatch };
}
const accepted = {
  accepted: true,
  taskId: "already-live-task",
  childThreadId: "already-live-thread",
  childRunId: "already-live-run",
};
for (const order of ["refusal-accepted", "accepted-refusal", "refusal-recovery", "unknown-refusal"])
  test(order, async () => {
    const { dir, dispatch } = await seed(order);
    const obs = (response) => ({
      type: "dispatch",
      runId: dispatch.runId,
      featureId: dispatch.featureId,
      intentId: dispatch.intentId,
      response,
    });
    const child = {
      type: "children",
      runId: dispatch.runId,
      featureId: dispatch.featureId,
      intentId: dispatch.intentId,
      response: {
        threads: [{ ...accepted, clientRequestId: dispatch.intentId, parentThreadId: "r6-owner" }],
      },
    };
    const observations =
      order === "refusal-accepted"
        ? [obs({ blocked: true }), obs(accepted)]
        : order === "accepted-refusal"
          ? [obs(accepted), obs({ blocked: true })]
          : order === "refusal-recovery"
            ? [obs({ blocked: true }), child]
            : [
                obs({
                  pending: true,
                  taskId: "already-live-task",
                  childThreadId: "already-live-thread",
                }),
                obs({ blocked: true }),
              ];
    const now = Date.now();
    const first = await k.missionTick(dir, { observations, now });
    const second = await k.missionTick(dir, { now: now + 86400000 });
    const state = k.loadState(dir),
      journals = inspectDispatchRecords(dir),
      controller = JSON.parse(
        fs.readFileSync(path.join(dir, ".mission/autopilot/controller.json")),
      );
    fs.writeFileSync(
      path.join(root, order + ".json"),
      JSON.stringify(
        { dispatch, observations, first, second, state, journals, controller },
        null,
        2,
      ),
    );
    assert.notEqual(
      second.action.type,
      "dispatch",
      "An accepted or identity-bearing original intent cannot be consumed as an unstarted rejection and redispatched",
    );
    assert.equal(
      state.activeWorker?.runId,
      dispatch.runId,
      "Preserve the original run when its accepted/unknown child may exist",
    );
  });
