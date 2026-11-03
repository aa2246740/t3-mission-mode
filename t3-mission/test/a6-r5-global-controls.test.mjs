import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
const root = process.env.R9_EVIDENCE_DIR;
const sha = "a".repeat(40);
const tick = async (dir, observations = []) => (await k.missionTick(dir, { observations })).action;
function seed(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  k.proposeMission(dir, {
    title: name,
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "r5-owner",
    pauseMode: "let_finish",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    integration: { branch: "mission/r5", auto: true },
  });
  k.approveMissionPlan(dir);
  return dir;
}
const wrap = (n, x) =>
  n === "plain"
    ? x
    : n === "response"
      ? { response: x }
      : n === "structured"
        ? { structuredContent: x }
        : { content: [{ type: "text", text: JSON.stringify(x) }] };
const controller = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".mission/autopilot/controller.json")));
for (const name of ["plain", "structured", "content"])
  for (const pending of [false, true])
    test(`Timer acknowledgement ${name} pending=${pending}`, async () => {
      const label = `timer-${name}-${pending}`,
        dir = seed(label),
        a = await tick(dir),
        raw = wrap(name, {
          taskId: "pending-timer",
          enabled: true,
          ...(pending ? { pending: true } : {}),
        });
      const next = await tick(dir, [{ type: "timer", requestId: a.requestId, response: raw }]);
      const ledger = controller(dir);
      fs.writeFileSync(
        path.join(root, label + ".json"),
        JSON.stringify({ raw, next, ledger }, null, 2),
      );
      assert.equal(
        ledger.timer.phase,
        pending ? "requested" : "confirmed",
        "A pending scheduler operation cannot confirm a durable running timer",
      );
      assert.equal(next.type, pending ? "wait_user" : "dispatch");
    });
for (const name of ["plain", "structured", "content"])
  for (const pending of [false, true])
    test(`Integration acknowledgement ${name} pending=${pending}`, async () => {
      const label = `merge-${name}-${pending}`,
        dir = seed(label);
      const timer = await tick(dir),
        a = await tick(dir, [
          {
            type: "timer",
            requestId: timer.requestId,
            response: { taskId: "timer", enabled: true },
          },
        ]);
      const r = { taskId: "r5-task", childThreadId: "r5-thread", childRunId: "r5-child" };
      await tick(dir, [
        {
          type: "dispatch",
          featureId: a.featureId,
          runId: a.runId,
          intentId: a.intentId,
          response: r,
        },
      ]);
      const envelope = {
        version: 1,
        featureId: "f1",
        runId: a.runId,
        status: "success",
        summary:
          "A private fixture supplies a complete implementation envelope and explicit checks for this isolated protocol review.",
        commit: sha,
        branch: "feature/r5",
        tests: [{ command: "fixture-only", status: "passed" }],
        discoveredIssues: [],
        whatWasLeftUndone: [],
      };
      const integrate = await tick(dir, [
        {
          type: "task_status",
          featureId: a.featureId,
          runId: a.runId,
          taskId: r.taskId,
          response: {
            ...r,
            status: "completed",
            workState: "result_available",
            hasPendingChildRuns: false,
            summary: "```mission-result\n" + JSON.stringify(envelope) + "\n```",
          },
        },
      ]);
      assert.equal(integrate.kind, "integrate");
      const raw = wrap(name, {
        branch: "mission/r5",
        sourceBranch: "feature/r5",
        commit: sha,
        mergeSha: sha,
        ...(pending ? { pending: true } : {}),
      });
      const next = await tick(dir, [
        { type: "integration", featureId: a.featureId, runId: a.runId, response: raw },
      ]);
      const features = k.loadFeaturesDoc(dir),
        ledger = controller(dir);
      fs.writeFileSync(
        path.join(root, label + ".json"),
        JSON.stringify({ raw, next, features, ledger }, null, 2),
      );
      assert.equal(
        features.features[0].status,
        pending ? "running" : "completed",
        "Pending integration cannot be recorded as a completed feature",
      );
      assert.equal(Boolean(features.features[0].integration), !pending);
    });
