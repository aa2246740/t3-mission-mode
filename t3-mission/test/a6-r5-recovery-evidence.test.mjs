import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
const out = process.env.R9_EVIDENCE_DIR;
const wraps = {
  root: (x) => x,
  response: (x) => ({ response: x }),
  delegation: (x) => ({ delegation: x }),
  structured: (x) => ({ structuredContent: x }),
  content: (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }),
};
const tick = async (dir, observations = [], now = Date.now()) =>
  (await k.missionTick(dir, { observations, now })).action;
function snapshot(dir) {
  const base = path.join(dir, ".mission");
  return {
    state: k.loadState(dir),
    journal: fs
      .readdirSync(base)
      .filter((n) => /^dispatch-.*\.json$/.test(n))
      .map((n) => JSON.parse(fs.readFileSync(path.join(base, n)))),
    controller: JSON.parse(fs.readFileSync(path.join(base, "autopilot/controller.json"))),
  };
}
function reapprove(dir) {
  const s = k.loadState(dir);
  k.rejectMissionPlan(dir, "Explicit reapproval");
  k.proposeMission(dir, {
    title: s.title,
    repoPath: dir,
    autopilot: true,
    ownerThreadId: s.ownerThreadId,
    milestones: s.milestones,
    features: k.loadFeaturesDoc(dir).features,
    assertions: s.assertions,
    integration: s.integration,
  });
  k.approveMissionPlan(dir);
}
for (const [shape, body] of Object.entries({
  unknownError: { isError: true, message: "Reply lost after child creation" },
  refusedWithIdentity: { ok: false, taskId: "existing-task", childThreadId: "existing-thread" },
  plainRefusal: { blocked: true },
  explicitBusy: { accepted: false, code: "PROVIDER_BUSY" },
  authRefusal: { accepted: false, isError: true, message: "401 Unauthorized" },
  empty: {},
  null: null,
}))
  for (const [container, wrap] of Object.entries(wraps)) {
    test(`controller/${shape}/${container}`, async () => {
      const label = shape + "-" + container,
        dir = path.join(out, label);
      fs.mkdirSync(dir);
      k.proposeMission(dir, {
        title: label,
        repoPath: dir,
        autopilot: true,
        ownerThreadId: "r5-owner",
        milestones: [{ id: "m1" }],
        features: [{ id: "f1", milestoneId: "m1" }],
        assertions: [{ id: "VAL-1", milestoneId: "m1" }],
      });
      k.approveMissionPlan(dir);
      const timer = await tick(dir);
      const dispatch = await tick(dir, [
        {
          type: "timer",
          requestId: timer.requestId,
          response: { taskId: "r5-timer", enabled: true },
        },
      ]);
      assert.equal(dispatch.type, "dispatch");
      const raw = wrap(body);
      const observed = await tick(dir, [
        {
          type: "dispatch",
          runId: dispatch.runId,
          featureId: dispatch.featureId,
          intentId: dispatch.intentId,
          response: raw,
        },
      ]);
      // UNKNOWN must still reconcile before and after approval. A proven refusal now
      // retries automatically, so do not issue and discard attempt 2 before reapproval.
      // The A6 decision matrix separately executes the no-reapproval retry path.
      const repeated = ["unknownError", "refusedWithIdentity", "empty", "null"].includes(shape)
          ? await tick(dir, [], Date.now() + 86400000)
          : undefined,
        before = snapshot(dir);
      reapprove(dir);
      const afterApproval = await tick(dir, [], Date.now() + 86400000),
        after = snapshot(dir);
      // Submit an exact original child through the public recovery observation to show whether recovery can work once requested.
      let recovered;
      if (["unknownError", "refusedWithIdentity", "empty", "null"].includes(shape)) {
        recovered = await tick(dir, [
          {
            type: "children",
            runId: dispatch.runId,
            featureId: dispatch.featureId,
            intentId: dispatch.intentId,
            response: {
              threads: [
                {
                  clientRequestId: dispatch.intentId,
                  parentThreadId: "r5-owner",
                  taskId: "existing-task",
                  childThreadId: "existing-thread",
                },
              ],
            },
          },
        ]);
      }
      fs.writeFileSync(
        path.join(out, label + ".json"),
        JSON.stringify(
          { raw, dispatch, observed, repeated, before, afterApproval, after, recovered },
          null,
          2,
        ),
      );
      if (["unknownError", "refusedWithIdentity", "empty", "null"].includes(shape)) {
        assert.equal(
          observed.type,
          "recover_dispatch",
          "Ambiguous dispatch must request reconciliation automatically",
        );
        assert.equal(repeated.type, "recover_dispatch");
        assert.equal(afterApproval.type, "recover_dispatch");
      } else {
        assert.equal(
          before.journal[0].phase,
          "retryable",
          "Proven nonacceptance must release the durable attempt",
        );
        assert.equal(
          afterApproval.type,
          "dispatch",
          "Explicit reapproval after the deadline must allow a new attempt",
        );
      }
    });
  }
