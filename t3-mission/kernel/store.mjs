import { resolveMissionBaseDir, missionTransaction, readTransactionFile, writeTransactionFile, listTransactionFiles, hasActiveMissionTransaction } from './mission-transaction.mjs';
export { resolveMissionBaseDir } from './mission-transaction.mjs';
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MODEL_SETTINGS,
  MissionKernelError,
  normalizeFeature,
  normalizeModelSettings,
} from "./schema.mjs";

export function getMissionPaths(missionDir) {
  const baseDir = resolveMissionBaseDir(missionDir);
  return {
    baseDir,
    statePath: path.join(baseDir, "state.json"),
    featuresPath: path.join(baseDir, "features.json"),
    modelSettingsPath: path.join(baseDir, "model-settings.json"),
    progressLogPath: path.join(baseDir, "progress_log.jsonl"),
  };
}

export function ensureMissionDir(missionDir) {
  const paths = getMissionPaths(missionDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  return paths;
}

export function writeFileAtomicSync(filePath, content) { return writeTransactionFile(filePath, content); }
export function writeJsonAtomicSync(filePath, data) { writeFileAtomicSync(filePath, `${JSON.stringify(data, null, 2)}\n`); }
export function readJsonSync(filePath, fallback = null) {
  const raw = readTransactionFile(filePath);
  return raw === null ? fallback : JSON.parse(raw);
}

function loadStateImpl(missionDir) {
  const { statePath } = getMissionPaths(missionDir);
  const state = readJsonSync(statePath, null);
  if (!state) {
    throw new MissionKernelError(
      "MISSION_NOT_FOUND",
      `Mission state not found at ${statePath}`
    );
  }
  if (!Array.isArray(state.pendingHandoffItems)) {
    state.pendingHandoffItems = [];
  }
  return state;
}

function tryLoadStateImpl(missionDir) {
  const { statePath } = getMissionPaths(missionDir);
  const state = readJsonSync(statePath, null);
  if (state && !Array.isArray(state.pendingHandoffItems)) {
    state.pendingHandoffItems = [];
  }
  return state;
}

function saveStateImpl(missionDir, state) {
  const { statePath } = ensureMissionDir(missionDir);
  if (state && !Array.isArray(state.pendingHandoffItems)) {
    state.pendingHandoffItems = [];
  }
  writeJsonAtomicSync(statePath, state);
  return state;
}

function loadFeaturesDocImpl(missionDir) {
  const { featuresPath } = getMissionPaths(missionDir);
  const doc = readJsonSync(featuresPath, null);
  if (!doc) {
    return {
      features: [],
      updatedAt: new Date().toISOString(),
    };
  }
  if (Array.isArray(doc)) {
    return {
      features: doc.map((f, i) => normalizeFeature(f, i)),
      updatedAt: new Date().toISOString(),
    };
  }
  const features = Array.isArray(doc.features)
    ? doc.features.map((f, i) => normalizeFeature(f, i))
    : [];
  return {
    ...doc,
    features,
    updatedAt: doc.updatedAt || new Date().toISOString(),
  };
}

function saveFeaturesDocImpl(missionDir, featuresOrDoc) {
  const { featuresPath } = ensureMissionDir(missionDir);
  const rawFeatures = Array.isArray(featuresOrDoc)
    ? featuresOrDoc
    : Array.isArray(featuresOrDoc?.features)
      ? featuresOrDoc.features
      : [];
  const doc = {
    ...(Array.isArray(featuresOrDoc) ? {} : featuresOrDoc),
    features: rawFeatures.map((f, i) => normalizeFeature(f, i)),
    updatedAt:
      (!Array.isArray(featuresOrDoc) && featuresOrDoc?.updatedAt) ||
      new Date().toISOString(),
  };
  writeJsonAtomicSync(featuresPath, doc);
  return doc;
}

function loadModelSettingsImpl(missionDir) {
  const { modelSettingsPath } = getMissionPaths(missionDir);
  const raw = readJsonSync(modelSettingsPath, null);
  if (!raw) {
    return normalizeModelSettings(DEFAULT_MODEL_SETTINGS);
  }
  return normalizeModelSettings(raw);
}

function saveModelSettingsImpl(missionDir, settings) {
  const { modelSettingsPath } = ensureMissionDir(missionDir);
  const normalized = normalizeModelSettings(settings);
  writeJsonAtomicSync(modelSettingsPath, normalized);
  return normalized;
}

function readProgressLogImpl(missionDir) {
  const { progressLogPath } = getMissionPaths(missionDir);
  if (readTransactionFile(progressLogPath) === null) {
    return [];
  }
  const raw = readTransactionFile(progressLogPath);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendProgressLogImpl(missionDir, entryInput) {
  const { progressLogPath } = ensureMissionDir(missionDir);
  const entries = readProgressLog(missionDir);
  const nextSeq =
    entries.length > 0
      ? Math.max(...entries.map((e) => (typeof e.seq === "number" ? e.seq : 0))) + 1
      : 1;

  const entry = {
    seq: nextSeq,
    timestamp: entryInput.timestamp || new Date().toISOString(),
    type: String(entryInput.type || "info"),
    message: String(entryInput.message || ""),
  };
  if (entryInput.featureId !== undefined) {
    entry.featureId = entryInput.featureId;
  }
  if (entryInput.workerNumber !== undefined) {
    entry.workerNumber = entryInput.workerNumber;
  }
  if (entryInput.milestoneId !== undefined) {
    entry.milestoneId = entryInput.milestoneId;
  }
  if (entryInput.details !== undefined) {
    entry.details = entryInput.details;
  }

  const nextLines = [...entries, entry]
    .map((item) => JSON.stringify(item))
    .join("\n")
    .concat("\n");
  writeFileAtomicSync(progressLogPath, nextLines);
  return entry;
}

function reconcileMissionOnLoadImpl(missionDir, options = {}) {
  const state = tryLoadState(missionDir);
  if (!state) {
    return null;
  }

  const nowMs =
    typeof options.nowMs === "number" ? options.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const activeStatuses = new Set([
    "running",
    "initializing",
    "orchestrator_turn",
  ]);

  if (activeStatuses.has(state.status)) {
    if (state.lastStartedAt) {
      const startedMs = Date.parse(state.lastStartedAt);
      if (!Number.isNaN(startedMs) && nowMs > startedMs) {
        state.elapsedMs = (state.elapsedMs || 0) + (nowMs - startedMs);
      }
    }
    state.lastStartedAt = null;
    state.status = "paused";
    state.revision = (state.revision || 1) + 1;

    let pausedWorker = null;
    if (state.activeWorker && state.activeWorker.status === "running") {
      state.activeWorker = {
        ...state.activeWorker,
        status: "paused",
        pausedAt: nowIso,
      };
      pausedWorker = state.activeWorker;

      if (Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((session) =>
          session.runId === pausedWorker.runId ||
          (pausedWorker.sessionId && session.sessionId === pausedWorker.sessionId)
            ? { ...session, status: "paused", pausedAt: nowIso }
            : session
        );
      }
    }

    saveState(missionDir, state);

    if (pausedWorker) {
      const workerNumber = pausedWorker.workerNumber ?? 1;
      const featureTitle =
        pausedWorker.featureTitle ||
        pausedWorker.title ||
        pausedWorker.featureId ||
        "feature";
      appendProgressLog(missionDir, {
        timestamp: nowIso,
        type: "worker_paused",
        message: `Worker #${workerNumber} paused ${featureTitle}`,
        featureId: pausedWorker.featureId ?? null,
        workerNumber,
      });
    }

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "mission_paused",
      message: "Mission paused",
      featureId: pausedWorker ? pausedWorker.featureId ?? null : null,
      workerNumber: pausedWorker ? pausedWorker.workerNumber ?? 1 : null,
    });
  }

  return state;
}

const loadedStates = new WeakMap();
const loadedDocuments = new WeakMap();
function rememberDocument(dir, value, field) {
  if (!value || typeof value !== 'object') return value;
  const bytes = readTransactionFile(getMissionPaths(dir)[field]);
  loadedDocuments.set(value, bytes);
  if (Array.isArray(value.features)) loadedDocuments.set(value.features, bytes);
  return value;
}
function saveDocument(dir, value, options, field, save) {
  const composed = hasActiveMissionTransaction();
  return missionTransaction(dir, () => {
    const file = getMissionPaths(dir)[field], current = readTransactionFile(file);
    if (options.expectedRevision !== undefined && JSON.parse(readTransactionFile(getMissionPaths(dir).statePath) ?? '{}').revision !== options.expectedRevision)
      throw new MissionKernelError('TX_STALE_REVISION', 'Document expectedRevision differs from the current Mission');
    const result = save(dir, value), next = readTransactionFile(file);
    if (!composed && loadedDocuments.has(value) && loadedDocuments.get(value) !== current && current !== next)
      throw new MissionKernelError('TX_STALE_REVISION', 'Document was loaded before another writer committed; reload inside a transaction');
    rememberDocument(dir, value, field);
    return rememberDocument(dir, result, field);
  });
}
function rememberState(dir, state) {
  if (state) loadedStates.set(state, readTransactionFile(getMissionPaths(dir).statePath));
  return state;
}
export function loadState(dir) { return missionTransaction(dir, () => rememberState(dir, loadStateImpl(dir)), { create: false }); }
export function tryLoadState(dir) { return missionTransaction(dir, () => rememberState(dir, tryLoadStateImpl(dir)), { create: false }); }
export function saveState(dir, state, options = {}) {
  const composed = hasActiveMissionTransaction();
  return missionTransaction(dir, () => {
    const current = readTransactionFile(getMissionPaths(dir).statePath);
    const loaded = loadedStates.get(state);
    if (!composed && current !== null && loaded === undefined && options.expectedRevision === undefined && JSON.stringify(state, null, 2) + "\n" !== current)
      throw new MissionKernelError('TX_EXPECTED_REVISION_REQUIRED', 'A detached state replacement needs expectedRevision; a proposed next revision is not its base revision');
    if (!composed && loaded !== undefined && current !== loaded && current !== JSON.stringify(state, null, 2) + "\n")
      throw new MissionKernelError('TX_STALE_REVISION', 'saveState received a stale loaded state; reload inside a transaction');
    if (options.expectedRevision !== undefined && current !== null && JSON.parse(current).revision !== options.expectedRevision)
      throw new MissionKernelError('TX_STALE_REVISION', 'saveState expectedRevision differs from the current state');
    if (current !== null && Number.isSafeInteger(state?.revision) && state.revision < JSON.parse(current).revision)
      throw new MissionKernelError('TX_STALE_REVISION', 'saveState cannot replace a newer Mission revision');
    const saved = saveStateImpl(dir, state);
    loadedStates.set(state, readTransactionFile(getMissionPaths(dir).statePath));
    return saved;
  });
}
export function loadFeaturesDoc(dir) { return missionTransaction(dir, () => rememberDocument(dir, loadFeaturesDocImpl(dir), 'featuresPath'), { create: false }); }
export function saveFeaturesDoc(dir, value, options = {}) { return saveDocument(dir, value, options, 'featuresPath', saveFeaturesDocImpl); }
export function loadModelSettings(dir) { return missionTransaction(dir, () => rememberDocument(dir, loadModelSettingsImpl(dir), 'modelSettingsPath'), { create: false }); }
export function saveModelSettings(dir, value, options = {}) { return saveDocument(dir, value, options, 'modelSettingsPath', saveModelSettingsImpl); }
export function readProgressLog(dir, ...args) { return missionTransaction(dir, () => readProgressLogImpl(dir, ...args), { create: false }); }
export function appendProgressLog(dir, ...args) { return missionTransaction(dir, () => appendProgressLogImpl(dir, ...args), { create: true }); }
export function reconcileMissionOnLoad(dir, ...args) { return missionTransaction(dir, () => reconcileMissionOnLoadImpl(dir, ...args), { create: false }); }
export function readMissionSnapshot(missionDir) {
  return missionTransaction(missionDir, () => {
    const paths = getMissionPaths(missionDir);
    const state = rememberState(missionDir, readJsonSync(paths.statePath, null));
    const featuresDoc = readJsonSync(paths.featuresPath, null);
    const modelSettings = readJsonSync(paths.modelSettingsPath, null);
    const progressLog = readProgressLog(missionDir);
    return { state, featuresDoc, modelSettings, progressLog };
  }, { create: false });
}
