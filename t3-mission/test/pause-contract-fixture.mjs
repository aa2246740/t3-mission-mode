import assert from "node:assert/strict";
import fs from "node:fs";
import * as k from "../kernel/index.mjs";

export function assertRejectedPause(dir, before, code = "PROVIDER_BUSY") {
  const oldState = JSON.parse(before["state.json"] ?? before.statePath);
  const state = k.loadState(dir);
  const snapshot = k.readMissionSnapshot(dir);
  const paths = k.getMissionPaths(dir);
  assert.equal(
    fs.readFileSync(paths.modelSettingsPath, "utf8"),
    before["model-settings.json"] ?? before.modelSettingsPath,
  );
  assert.equal(
    fs.readFileSync(paths.featuresPath, "utf8"),
    before["features.json"] ?? before.featuresPath,
  );
  assert.equal(state.status, "paused");
  assert.equal(typeof state.pausedAt, "string");
  assert.equal(Number.isNaN(Date.parse(state.pausedAt)), false);
  assert.equal(state.planAccepted, oldState.planAccepted);
  assert.deepEqual(state.activeWorker, oldState.activeWorker);
  assert.deepEqual(state.sessions, oldState.sessions);
  assert.equal(state.pauseControl.phase, "rejected");
  assert.equal(state.pauseControl.code, code);
  assert.equal(state.pauseControl.runId, oldState.activeWorker?.runId ?? null);
  assert.equal(Number.isNaN(Date.parse(state.pauseControl.at)), false);
  assert.deepEqual(
    snapshot.featuresDoc.features,
    JSON.parse(before["features.json"] ?? before.featuresPath).features,
  );
  const oldLog = (before["progress_log.jsonl"] ?? before.progressLogPath)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.deepEqual(snapshot.progressLog.slice(0, oldLog.length), oldLog);
  assert.deepEqual(
    snapshot.progressLog.slice(oldLog.length).map((row) => row.type),
    ["mission_pause_requested", "pause_control_rejected"],
  );
  return state;
}
