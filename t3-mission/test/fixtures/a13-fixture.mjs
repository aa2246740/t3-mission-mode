import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as k from "../../kernel/index.mjs";
import { readController } from "../../kernel/autopilot-store.mjs";
import { inspectDispatchRecords } from "../../kernel/dispatch-journal.mjs";

export const ra1 = JSON.parse(fs.readFileSync(new URL("./a13-ra1.json", import.meta.url)));
export const original = (name) => JSON.parse(ra1.files[name]);
export const observations = Object.entries(ra1.files)
  .filter(([name]) => name.startsWith("autopilot/observations/"))
  .map(([name, raw]) => ({ name, ...JSON.parse(raw) }))
  .sort((a, b) => a.sequence - b.sequence);
export const journals = Object.entries(ra1.files)
  .filter(([name]) => name.startsWith("dispatch-"))
  .map(([name, raw]) => ({ name, ...JSON.parse(raw) }))
  .sort((a, b) => a.intent.worker.workerNumber - b.intent.worker.workerNumber);
const ends = Object.entries(ra1.files)
  .filter(([name]) => name.startsWith(".txn/commands/"))
  .map(([, raw]) => JSON.parse(raw))
  .filter((row) => row.commandId?.startsWith("EndFeatureRun:"))
  .map((row) => row.result)
  .sort((a, b) => a.state.sessions.length - b.state.sessions.length);
export const fence = (envelope) => "```mission-result\n" + JSON.stringify(envelope) + "\n```";
export const envelope = (summary) =>
  JSON.parse(summary.match(/^```mission-result\s*\n([\s\S]*?)^```/m)[1]);
export const tick = async (dir, observations = []) =>
  (await k.missionTick(dir, { observations, now: Date.parse("2026-10-26T13:30:00Z") })).action;
export const ledger = (dir) => readController(dir, k.loadState(dir).missionId);
export const recordCount = (dir) => inspectDispatchRecords(dir).length;
export function evidence(name, result) {
  if (process.env.R9_EVIDENCE_DIR)
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, name + ".json"),
      JSON.stringify(result, null, 2) + "\n",
    );
}
export const observe = (type, action, response) => ({
  type,
  featureId: action.featureId,
  runId: action.runId,
  taskId: action.taskId,
  controlId: action.controlId,
  response,
});
export const timerReceipt = (action, enabled) => ({
  type: enabled ? "timer" : "timer_disabled",
  requestId: action.requestId,
  response: { scheduledTaskId: action.scheduledTaskId, enabled },
});
export const fresh = (dir, op = "tick", input = {}) => {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./a13-child.mjs", import.meta.url)), op, dir, JSON.stringify(input)],
    { encoding: "utf8", timeout: 120000, maxBuffer: 16000000 },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
};
export function fixture(phase = "scrutiny", policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a13-ra1-")),
    base = path.join(dir, ".mission");
  fs.mkdirSync(path.join(base, "autopilot/observations"), { recursive: true });
  const write = (name, value) =>
    fs.writeFileSync(path.join(base, name), JSON.stringify(value, null, 2) + "\n");
  const state = structuredClone(
    phase === "partial"
      ? ends[0].state
      : phase === "handoff"
        ? ends[1].state
        : phase === "integration"
          ? ends[3].state
          : original("state.json"),
  );
  const cutoff = { partial: 3, handoff: 6, integration: 10, scrutiny: 13 }[phase];
  const count = { partial: 1, handoff: 2, integration: 4, scrutiny: 5 }[phase];
  const doc = original("features.json");
  if (phase === "partial")
    doc.features = [
      ends[0].feature,
      original(
        ".txn/commands/e561b1f6f264020d96db9bd2e797a7b89fd3a4f59eff3b922cef1162ee1c19bb.json",
      ).result.features[1],
    ];
  if (phase === "handoff")
    doc.features = [
      ends[1].feature,
      original(
        ".txn/commands/e561b1f6f264020d96db9bd2e797a7b89fd3a4f59eff3b922cef1162ee1c19bb.json",
      ).result.features[1],
    ];
  const controller = original("autopilot/controller.json");
  controller.runs = Object.fromEntries(
    Object.entries(controller.runs).filter(([id]) =>
      journals.slice(0, count).some((row) => row.intent.runId === id),
    ),
  );
  controller.observations = Object.fromEntries(
    observations
      .filter((row) => row.sequence <= cutoff)
      .map((row) => [
        path.basename(row.name, ".json"),
        { outcome: "applied", ...(row.observation.runId ? { runId: row.observation.runId } : {}) },
      ]),
  );
  if (phase === "integration") {
    const record = journals[3],
      run = controller.runs[record.intent.runId];
    state.activeWorker = { ...record.intent.worker, ...record.receipt };
    delete state.activeWorker.dispatchPending;
    state.sessions[3] = structuredClone(state.activeWorker);
    state.status = "running";
    state.revision = 17;
    state.integration = ends[1].state.integration;
    state.milestones = ends[1].state.milestones;
    doc.features = [ends[1].feature, { ...record.intent.feature, ...record.receipt }];
    delete doc.features[1].dispatchPending;
    delete run.integration;
    delete run.integrationObservationId;
    delete run.consumed;
  }
  state.repoPath = dir;
  if (policy) state.retryPolicy = policy;
  write("state.json", state);
  write("features.json", doc);
  write("model-settings.json", original("model-settings.json"));
  fs.writeFileSync(path.join(base, "progress_log.jsonl"), "");
  write("autopilot/controller.json", controller);
  for (const row of observations.filter((row) => row.sequence <= cutoff))
    fs.writeFileSync(path.join(base, row.name), ra1.files[row.name]);
  for (const { name, ...record } of journals.slice(0, count)) write(name, record);
  return dir;
}
export function verifyProvenance() {
  for (const row of ra1.manifest) {
    const bytes = Buffer.from(ra1.files[row.file]);
    assert.equal(bytes.length, row.bytes);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), row.sha256);
  }
  assert.equal(ra1.manifest.length, 31);
}

export function terminalObservation(dir, value, ordinal) {
  const state = k.loadState(dir),
    run = ledger(dir).runs[state.activeWorker.runId];
  const status = structuredClone(run.lastStatus);
  delete status.content;
  delete status.structuredContent;
  delete status.observationId;
  status.childRunId = `a13-correction-turn-${ordinal}`;
  status.latestTerminalRunId = status.childRunId;
  status.latestTerminalStatus = "completed";
  status.status = "completed";
  status.latestTerminalSummary = fence(value);
  status.summary = "The previous turn summary must not replace latestTerminalSummary.";
  return {
    type: "task_status",
    featureId: state.activeWorker.featureId,
    runId: state.activeWorker.runId,
    taskId: status.taskId,
    response: status,
  };
}
