import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kernel from "../kernel/index.mjs";
import { archiveObservation, readController, saveController } from "../kernel/autopilot-store.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const worker = { providerInstanceId: "pi", model: "air-cpa/glm-5.3-flash", options: { thinking: "low" } };
const validator = { providerInstanceId: "pi", model: "air-cpa/glm-5.3", options: { thinking: "low" } };

test("a Pi Mission dispatch only sends the options its model declares", async t => {
  const dir = fs.mkdtempSync(path.join(root, ".pi-options-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, {
    missionId: "pi-options-fixture", repoPath: dir, autopilot: true,
    ownerThreadId: "fixture-owner", integration: { branch: "mission/fixture", auto: true },
    milestones: [{ id: "m1", title: "Fixture", ordinal: 1 }],
    features: [{ id: "f1", milestoneId: "m1", title: "Fixture feature" }],
    permissions: [{ id: "worker-worktree-disk-gate", status: "approved" }],
    modelSettings: { worker, validator },
  });
  kernel.approveMissionPlan(dir);
  const ledger = readController(dir, "pi-options-fixture");
  ledger.timer = { requestId: "mission-timer:pi-options-fixture", scheduledTaskId: "fixture-timer", phase: "confirmed" };
  const observation = { type: "timer", requestId: ledger.timer.requestId, response: { taskId: "fixture-timer", enabled: true } };
  ledger.observations[archiveObservation(dir, observation)] = { outcome: "applied" };
  saveController(dir, ledger);

  const { action } = await kernel.missionTick(dir);
  assert.equal(action.type, "dispatch");
  assert.deepEqual(action.delegateTask.target, worker);
  assert.match(action.delegateTask.task, /verify their filesystem device IDs match/);

  const selectedValidator = kernel.resolveFeatureSlot({ id: "v1", kind: "scrutiny" }, kernel.loadModelSettings(dir));
  assert.deepEqual(selectedValidator.slotConfig.options, { thinking: "low" });
});

test("Codex keeps its declared reasoning option", () => {
  const settings = { worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "max" } } };
  assert.deepEqual(kernel.resolveFeatureSlot({ id: "f1", kind: "implementation" }, settings).slotConfig.options, { reasoningEffort: "max" });
});
