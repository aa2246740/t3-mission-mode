import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const root = fs.mkdtempSync(
  path.join(
    process.env.R9_EVIDENCE_DIR || os.tmpdir(),
    "a4-" + path.basename(import.meta.url) + "-",
  ),
);
const target = {
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "max", serviceTier: "priority" },
};
function fixture(name, auto = true) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  k.proposeMission(dir, {
    title: name,
    repoPath: dir,
    autopilot: auto,
    ownerThreadId: "owner-review",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", title: "Review feature", milestoneId: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    modelSettings: { worker: target, validator: target },
    integration: { branch: "mission/review", auto: true },
  });
  k.approveMissionPlan(dir);
  return dir;
}
const tick = async (dir, observations = []) => (await k.missionTick(dir, { observations })).action;
async function boot(dir) {
  let a = await tick(dir);
  assert.equal(a.type, "ensure_timer");
  return tick(dir, [
    { type: "timer", requestId: a.requestId, response: { taskId: "review-timer", enabled: true } },
  ]);
}
const observe = (type, a, response) => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  controlId: a.controlId,
  taskId: a.taskId,
  response,
});
const receipt = (a) => ({
  accepted: true,
  taskId: "task-" + a.runId,
  childThreadId: "thread-" + a.runId,
  childRunId: "turn-" + a.runId,
  ...target,
});
function evidence(name, dir, more) {
  fs.writeFileSync(
    path.join(root, name + ".json"),
    JSON.stringify(
      {
        ...more,
        state: k.loadState(dir),
        features: k.loadFeaturesDoc(dir),
        ledger: readController(dir, k.loadState(dir).missionId),
        records: inspectDispatchRecords(dir),
      },
      null,
      2,
    ),
  );
}
for (const mode of ["content", "structuredContent"])
  test("Wrapper rejection survives " + mode, async () => {
    const dir = fixture("wrapper-" + mode),
      a = await boot(dir),
      accepted = receipt(a);
    const response = {
      accepted: false,
      code: "PROVIDER_BUSY",
      ...(mode === "content"
        ? { content: [{ type: "text", text: JSON.stringify(accepted) }] }
        : { structuredContent: accepted }),
    };
    const next = await tick(dir, [observe("dispatch", a, response)]);
    evidence("wrapper-" + mode, dir, { response, next });
    assert.notEqual(
      inspectDispatchRecords(dir)[0].phase,
      "accepted",
      "An explicit wrapper rejection must veto the accepted inner payload",
    );
  });
for (const mode of ["negative-root", "negative-nested", "pending", "confirmed"])
  test("Interrupt acknowledgement " + mode, async () => {
    const dir = fixture("interrupt-" + mode),
      a = await boot(dir),
      r = receipt(a);
    await tick(dir, [observe("dispatch", a, r)]);
    applyAutopilotCommand(dir, "pause");
    const interrupt = await tick(dir);
    assert.equal(interrupt.type, "interrupt_worker");
    const response = {
      threadId: r.childThreadId,
      ok: true,
      ...(mode === "negative-root"
        ? { interrupted: false }
        : mode === "negative-nested"
          ? { response: { accepted: false, code: "PROVIDER_BUSY" } }
          : mode === "pending"
            ? { dispatchPending: true }
            : { interrupted: true }),
    };
    const next = await tick(dir, [observe("interrupt", interrupt, response)]);
    const phase = readController(dir, k.loadState(dir).missionId).runs[a.runId].pause.phase;
    evidence("interrupt-" + mode, dir, { response, next, phase });
    assert.equal(
      phase,
      mode === "confirmed" ? "interrupted" : "interrupt_requested",
      "Refusal or pending cannot confirm interruption",
    );
  });
for (const mode of ["undefined", "empty", "pending", "rejected", "confirmed"])
  test("Late accepted child Pause acknowledgement " + mode, async () => {
    const dir = fixture("late-pause-" + mode, false);
    let pauses = 0,
      pauseReply;
    const result = await k.startMissionRun(
      dir,
      {},
      {
        runFeature: async () => {
          const hud = await createHandlerHud({
            missionDir: dir,
            runtimeAdapter: {
              pauseWorker: async () => {
                throw new Error("No child existed at initial Pause");
              },
            },
          });
          try {
            pauseReply = await hud.post("pause");
            assert.equal(pauseReply.status, 200);
          } finally {
            await hud.close();
          }
          return {
            accepted: true,
            taskId: "late-task",
            childThreadId: "late-thread",
            runtimeTransport: "t3-delegate-task",
          };
        },
        pauseWorker: async () => {
          pauses++;
          return mode === "undefined"
            ? undefined
            : mode === "empty"
              ? {}
              : mode === "pending"
                ? { dispatchPending: true }
                : mode === "rejected"
                  ? { accepted: false, code: "PROVIDER_BUSY" }
                  : { paused: true };
        },
      },
    );
    const base = k.getMissionPaths(dir).baseDir;
    const effects = fs
      .readdirSync(path.join(base, ".txn/effects"))
      .map((n) => JSON.parse(fs.readFileSync(path.join(base, ".txn/effects", n), "utf8")));
    const effect = effects.find((x) => x.runId === k.loadState(dir).activeWorker.runId);
    evidence("late-pause-" + mode, dir, { pauses, pauseReply, result, effects });
    assert.equal(pauses, 1);
    assert.equal(k.loadState(dir).status, "paused");
    assert.equal(
      effect.phase,
      mode === "confirmed" ? "confirmed" : mode === "rejected" ? "failed" : "unknown",
      "A missing, empty or pending Pause response does not prove a stopped child",
    );
  });
