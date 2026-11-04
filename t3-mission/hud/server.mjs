import { createDiagnostics } from "../ops/diagnostics.mjs";
import {
  assertTrustedRequest,
  readBoundedJson,
  setSecurityHeaders,
} from "../ops/http-security.mjs";
import { findHudRoute } from "../ops/routes.mjs";
import { digest as commandDigest } from "../kernel/autopilot-store.mjs";
import {
  missionTransaction,
  readTransactionFile,
  writeTransactionFile,
  runMissionSteps,
  runClaimedEffect,
  transactionHash,
  afterMissionCommit,
  listTransactionFiles,
} from "../kernel/mission-transaction.mjs";
import {
  isRemoteWorker,
  inspectOwnedLocalWorker,
  stripLocalWorkerMetadata,
} from "../kernel/worker-process.mjs";
import {
  resolveFeatureSlot,
  workerDispatchBlockReason,
  settlePausedWorkerResult,
  resumeControlEffectId,
} from "../kernel/runner.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { callT3McpTool, preSendFailure } from "../bridge/t3-adapter.mjs";
import { inspectRepoAgentReadiness } from "./readiness.mjs";
import {
  validateSteeringRequest,
  resolveSteeringTarget,
  sendLiveThread,
} from "./session-steering.mjs";
import {
  readRecentObservations,
  observationFiles,
  buildThreadFeed,
  matchesFeedSession,
  normalizeThreadMessages,
} from "./thread-feed.mjs";
export { inspectRepoAgentReadiness } from "./readiness.mjs";
import {
  inspectDispatchIntent,
  inspectDispatchRecords,
  prepareDispatch,
  dispatchWithIntent,
  mergeDispatchReceipt,
  assertNoUnresolvedDispatch,
} from "../kernel/dispatch-journal.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cp, { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  approvePlanState,
  getFeatureSlotOverride,
  inferProviderForModel,
  decideDispatchOutcome,
  classifyControlReceipt,
  dispatchReceiptSources,
  inspectRunDispatchBinding,
} from "../kernel/schema.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const BRIDGE_CLI_PATH = path.resolve(__dirname, "../bridge/cli.mjs");

export const BUILTIN_MODEL_CATALOG = [
  {
    id: "claude-opus-5-5",
    model: "claude-opus-5-5",
    label: "Claude Code · Opus 5.5",
    displayName: "Claude Code · Opus 5.5 (claude-opus-5-5)",
    providerInstanceId: "claude-code",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: 5,
    reasoningEffort: "max",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gemini-4-argon-high",
    model: "gemini-4-argon-high",
    label: "Gemini 4 Argon (High)",
    displayName: "Gemini 4 Argon (High)",
    providerInstanceId: "antigravity",
    supportsEffort: false,
    effortLevels: [],
    effort: null,
    reasoningEffort: null,
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    label: "Codex · GPT-6.1-Sol (Max/High)",
    displayName: "Codex · GPT-6.1-Sol (Max/High)",
    providerInstanceId: "codex",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: 4,
    reasoningEffort: "high",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "swe-2-max",
    model: "swe-2-max",
    label: "CPA swe-2 Max",
    displayName: "CPA swe-2 Max",
    providerInstanceId: "cpa",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: 5,
    reasoningEffort: "max",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "grok-4.7",
    model: "grok-4.7",
    label: "CPA grok-4.7",
    displayName: "CPA grok-4.7",
    providerInstanceId: "cpa",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh"],
    effort: 3,
    reasoningEffort: "high",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gpt-6-astra-high",
    model: "gpt-6-astra-high",
    label: "GPT-6-Astra (High)",
    displayName: "GPT-6-Astra (High)",
    providerInstanceId: "openai",
    supportsEffort: false,
    effortLevels: [],
    effort: null,
    reasoningEffort: null,
    slots: ["orchestrator", "worker", "validator"],
  },
];

const EFFORT_LEVEL_TO_NAME = {
  1: "minimal",
  2: "low",
  3: "medium",
  4: "high",
  5: "max",
};

const EFFORT_NAME_TO_LEVEL = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5,
};

export function effortToReasoningEffort(effort, fallback = "high") {
  const num = Number(effort);
  if (Number.isFinite(num)) {
    const clamped = Math.max(1, Math.min(5, Math.round(num)));
    return EFFORT_LEVEL_TO_NAME[clamped] || fallback;
  }
  if (typeof effort === "string" && effort.trim()) {
    const key = effort.trim().toLowerCase();
    if (EFFORT_NAME_TO_LEVEL[key]) {
      return EFFORT_LEVEL_TO_NAME[EFFORT_NAME_TO_LEVEL[key]] || key;
    }
  }
  return fallback;
}

export function doesProviderDeclareEffortOption(providerInstanceId) {
  const norm = String(providerInstanceId || "")
    .trim()
    .toLowerCase();
  return (
    norm === "claudeagent" ||
    norm === "claude-code" ||
    norm === "claude-agent-acp" ||
    norm === "acpregistry_cursor"
  );
}

export const DEFAULT_HUD_MODEL_SETTINGS = {
  orchestrator: {
    providerInstanceId: "claude-code",
    model: "claude-opus-5-5",
    label: "Claude Code · Opus 5.5",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: 5,
    reasoningEffort: "max",
    options: { reasoningEffort: "max", effort: 5 },
  },
  worker: {
    providerInstanceId: "cpa",
    model: "swe-2-max",
    label: "CPA swe-2 Max",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    effort: 5,
    reasoningEffort: "max",
    options: { reasoningEffort: "max" },
  },
  validator: {
    providerInstanceId: "cpa",
    model: "grok-4.7",
    label: "CPA grok-4.7",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh"],
    effort: 3,
    reasoningEffort: "medium",
    options: { reasoningEffort: "medium" },
  },
  skipScrutiny: false,
  skipUserTesting: false,
};

function findCatalogEntry(modelOrLabel) {
  if (!modelOrLabel) return null;
  const needle = String(modelOrLabel).trim().toLowerCase();
  return (
    BUILTIN_MODEL_CATALOG.find(
      (item) =>
        item.id.toLowerCase() === needle ||
        item.model.toLowerCase() === needle ||
        item.label.toLowerCase() === needle ||
        item.displayName.toLowerCase() === needle,
    ) || null
  );
}

export function doesModelSupportEffort(rawSlot, catalogEntry = null) {
  const slotObj = typeof rawSlot === "object" && rawSlot ? rawSlot : null;
  const candidateModel =
    typeof rawSlot === "string"
      ? rawSlot
      : slotObj?.model || slotObj?.id || slotObj?.label || catalogEntry?.model || "";
  const entry = catalogEntry || findCatalogEntry(candidateModel);

  if (entry?.supportsEffort === false) return false;
  if (slotObj?.supportsEffort === false) return false;

  const providerInstanceId = String(slotObj?.providerInstanceId || entry?.providerInstanceId || "")
    .trim()
    .toLowerCase();
  if (providerInstanceId === "antigravity") return false;

  if (!entry && /-(low|medium|high)$/i.test(String(candidateModel).trim())) {
    return false;
  }

  return true;
}

function normalizeEffortPair(rawEffort, rawReasoningEffort, fallbackLevel = 4) {
  let level = null;
  const hasExplicitEffort =
    (typeof rawEffort === "number" && Number.isFinite(rawEffort)) ||
    (typeof rawEffort === "string" && rawEffort.trim().length > 0);
  const hasExplicitReasoning =
    typeof rawReasoningEffort === "string" && rawReasoningEffort.trim().length > 0;

  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    level = Math.max(1, Math.min(5, Math.round(rawEffort)));
  } else if (typeof rawEffort === "string" && rawEffort.trim()) {
    const parsed = Number(rawEffort);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
      level = Math.round(parsed);
    } else if (EFFORT_NAME_TO_LEVEL[rawEffort.trim().toLowerCase()]) {
      level = EFFORT_NAME_TO_LEVEL[rawEffort.trim().toLowerCase()];
    }
  }
  if (level === null && hasExplicitReasoning) {
    const key = rawReasoningEffort.trim().toLowerCase();
    if (EFFORT_NAME_TO_LEVEL[key]) {
      level = EFFORT_NAME_TO_LEVEL[key];
    }
  }
  if (level === null) {
    level = Math.max(1, Math.min(5, fallbackLevel));
  }

  let reasoningEffort;
  if (hasExplicitEffort && !hasExplicitReasoning) {
    reasoningEffort = EFFORT_LEVEL_TO_NAME[level] || "high";
  } else if (hasExplicitReasoning) {
    reasoningEffort = rawReasoningEffort.trim().toLowerCase();
  } else {
    reasoningEffort = EFFORT_LEVEL_TO_NAME[level] || "high";
  }
  return { effort: level, reasoningEffort };
}

function normalizeSlotConfig(rawSlot, fallbackSlot) {
  const base = fallbackSlot || DEFAULT_HUD_MODEL_SETTINGS.orchestrator;
  if (typeof rawSlot === "string") rawSlot = { model: rawSlot };

  if (!rawSlot || typeof rawSlot !== "object") {
    if (base && typeof base === "object" && base !== rawSlot) {
      return normalizeSlotConfig(base, DEFAULT_HUD_MODEL_SETTINGS.orchestrator);
    }
    return structuredClone(DEFAULT_HUD_MODEL_SETTINGS.orchestrator);
  }

  const candidateModel = rawSlot.model || rawSlot.id || rawSlot.label || base.model;
  const entry = findCatalogEntry(candidateModel);
  const providerInstanceId =
    rawSlot.providerInstanceId ||
    (rawSlot.model && rawSlot.model !== base.model
      ? inferProviderForModel(rawSlot.model, entry?.providerInstanceId || base.providerInstanceId)
      : null) ||
    base.providerInstanceId ||
    entry?.providerInstanceId ||
    "codex";
  const model = entry?.model || String(candidateModel);
  const label = rawSlot.label || entry?.label || String(candidateModel);

  if (!doesModelSupportEffort({ ...rawSlot, providerInstanceId, model }, entry)) {
    const cleanedOptions = {
      ...(base.options || {}),
      ...(rawSlot.options || {}),
    };
    delete cleanedOptions.effort;
    delete cleanedOptions.reasoningEffort;
    delete cleanedOptions.reasoning_effort;
    delete cleanedOptions.thinking;
    return {
      providerInstanceId,
      model,
      label,
      supportsEffort: false,
      effortLevels: [],
      options: cleanedOptions,
    };
  }

  const explicitEffort =
    rawSlot.effort !== undefined && rawSlot.effort !== null
      ? rawSlot.effort
      : rawSlot.options?.effort;
  const explicitReasoning =
    rawSlot.effort !== undefined && rawSlot.effort !== null && rawSlot.reasoningEffort === undefined
      ? undefined
      : rawSlot.reasoningEffort !== undefined && rawSlot.reasoningEffort !== null
        ? rawSlot.reasoningEffort
        : rawSlot.options?.reasoningEffort !== undefined &&
            rawSlot.options?.reasoningEffort !== null
          ? rawSlot.options.reasoningEffort
          : undefined;
  const hasExplicitEffort = explicitEffort !== undefined && explicitEffort !== null;
  const hasExplicitReasoning = explicitReasoning !== undefined && explicitReasoning !== null;
  const inheritEffort = !hasExplicitEffort && !hasExplicitReasoning;

  const { effort, reasoningEffort } = normalizeEffortPair(
    inheritEffort ? (base.effort ?? base.options?.effort ?? entry?.effort) : explicitEffort,
    inheritEffort
      ? (base.reasoningEffort ?? base.options?.reasoningEffort ?? entry?.reasoningEffort)
      : explicitReasoning,
    base.effort ?? entry?.effort ?? 4,
  );

  const slotOptions = {
    ...(base.options || {}),
    ...(rawSlot.options || {}),
    reasoningEffort,
  };
  if (doesProviderDeclareEffortOption(providerInstanceId)) {
    slotOptions.effort = effort;
  } else {
    delete slotOptions.effort;
  }

  return {
    providerInstanceId,
    model,
    label,
    supportsEffort: true,
    effortLevels: entry?.effortLevels || ["minimal", "low", "medium", "high", "max"],
    effort,
    reasoningEffort,
    options: slotOptions,
  };
}

export function normalizeHudModelSettings(partial = {}, base = DEFAULT_HUD_MODEL_SETTINGS) {
  const source =
    partial?.slots && typeof partial.slots === "object"
      ? { ...partial, ...partial.slots }
      : partial || {};
  const baseSource =
    base?.slots && typeof base.slots === "object"
      ? { ...base, ...base.slots }
      : base || DEFAULT_HUD_MODEL_SETTINGS;

  const rawModified = Array.isArray(source?.userModifiedSlots)
    ? source.userModifiedSlots
    : Array.isArray(baseSource?.userModifiedSlots)
      ? baseSource.userModifiedSlots
      : null;

  const normalized = {
    orchestrator: normalizeSlotConfig(source?.orchestrator, baseSource.orchestrator),
    worker: normalizeSlotConfig(source?.worker, baseSource.worker),
    validator: normalizeSlotConfig(source?.validator, baseSource.validator),
    skipScrutiny:
      typeof source?.skipScrutiny === "boolean"
        ? source.skipScrutiny
        : Boolean(baseSource?.skipScrutiny),
    skipUserTesting:
      typeof source?.skipUserTesting === "boolean"
        ? source.skipUserTesting
        : Boolean(baseSource?.skipUserTesting),
  };

  if (rawModified && rawModified.length > 0) {
    normalized.userModifiedSlots = Array.from(
      new Set(rawModified.map((s) => String(s).trim()).filter(Boolean)),
    );
  }
  return normalized;
}

export function resolveMissionPaths(missionDir) {
  if (!missionDir || typeof missionDir !== "string") {
    throw new Error("missionDir must be a non-empty string path");
  }
  const abs = path.resolve(missionDir);
  let dotMissionDir;
  let repoDir;
  if (path.basename(abs) === ".mission") {
    dotMissionDir = abs;
    repoDir = path.dirname(abs);
  } else {
    const candidateDot = path.join(abs, ".mission");
    const hasDirectFiles =
      fs.existsSync(path.join(abs, "state.json")) ||
      fs.existsSync(path.join(abs, "features.json")) ||
      fs.existsSync(path.join(abs, "model-settings.json")) ||
      fs.existsSync(path.join(abs, "progress_log.jsonl"));
    if (fs.existsSync(candidateDot)) {
      dotMissionDir = candidateDot;
      repoDir = abs;
    } else if (hasDirectFiles) {
      dotMissionDir = abs;
      repoDir = path.dirname(abs);
    } else {
      dotMissionDir = candidateDot;
      repoDir = abs;
    }
  }
  return {
    repoDir,
    dotMissionDir,
    statePath: path.join(dotMissionDir, "state.json"),
    featuresPath: path.join(dotMissionDir, "features.json"),
    modelSettingsPath: path.join(dotMissionDir, "model-settings.json"),
    progressLogPath: path.join(dotMissionDir, "progress_log.jsonl"),
  };
}

function writeFileAtomicSync(filePath, content) {
  return writeTransactionFile(filePath, content);
}
function writeJsonAtomicSync(filePath, data) {
  writeFileAtomicSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
function safeReadJsonSync(filePath, fallback = null) {
  const raw = readTransactionFile(filePath);
  return raw === null ? fallback : JSON.parse(raw);
}
function readProgressLogSync(filePath) {
  const raw = readTransactionFile(filePath);
  return raw === null
    ? []
    : raw
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
}

function buildProgressLogEntries(existingLogs, entriesToAppend) {
  const baseSeq =
    existingLogs.length > 0
      ? Math.max(...existingLogs.map((e) => (typeof e.seq === "number" ? e.seq : 0)))
      : 0;
  return entriesToAppend.map((entryInput, idx) => {
    const entry = {
      seq: baseSeq + idx + 1,
      timestamp: entryInput.timestamp || new Date().toISOString(),
      type: String(entryInput.type || "info"),
      message: String(entryInput.message || ""),
    };
    if (entryInput.featureId !== undefined) entry.featureId = entryInput.featureId;
    if (entryInput.workerNumber !== undefined) entry.workerNumber = entryInput.workerNumber;
    if (entryInput.milestoneId !== undefined) entry.milestoneId = entryInput.milestoneId;
    if (entryInput.details !== undefined) entry.details = entryInput.details;
    for (const key of ["threadId", "sessionId", "runId", "role"])
      if (entryInput[key] !== undefined) entry[key] = entryInput[key];
    return entry;
  });
}

function writeProgressLogEntriesSync(progressLogPath, entriesToWrite) {
  const entries = readProgressLogSync(progressLogPath);
  const content =
    [...entries, ...entriesToWrite].map((item) => JSON.stringify(item)).join("\n") + "\n";
  writeFileAtomicSync(progressLogPath, content);
  return entriesToWrite;
}

function execRuntimeSubprocess(action, missionDir, payload = {}) {
  return new Promise((resolve, reject) => {
    const commandMap = {
      dispatch: "DispatchWorkerRuntime",
      "pause-worker": "PauseWorkerRuntime",
      "pause-mission": "PauseMissionRuntime",
      "resume-worker": "ResumeWorkerRuntime",
    };
    const cliCommand = commandMap[action] || action;
    cp.execFile(
      process.execPath,
      [
        BRIDGE_CLI_PATH,
        cliCommand,
        "--mission-dir",
        missionDir,
        "--json",
        JSON.stringify({ ...payload, bridgeCliPath: BRIDGE_CLI_PATH }),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const rawErrText =
            (stderr && String(stderr).trim()) || (stdout && String(stdout).trim()) || "";
          if (rawErrText.startsWith("{")) {
            try {
              const parsedErr = JSON.parse(rawErrText.split("\n").pop() || rawErrText);
              if (Object.hasOwn(parsedErr ?? {}, "runtimeResult")) {
                reject(
                  Object.assign(new Error(parsedErr.error || err.message), {
                    code: parsedErr.code,
                    runtimeResult: parsedErr.runtimeResult,
                  }),
                );
                return;
              }
              if (parsedErr?.controlReceipt) {
                resolve(parsedErr.controlReceipt.raw);
                return;
              }
              if (parsedErr && typeof parsedErr === "object" && parsedErr.ok === false) {
                resolve(parsedErr);
                return;
              }
            } catch {
              // Fall through to reject
            }
          }
          const failure = Object.assign(new Error(rawErrText || err.message, { cause: err }), {
            code: err.code,
            syscall: err.syscall,
            path: err.path,
            spawnargs: err.spawnargs,
          });
          if (
            typeof err.code === "string" &&
            ["ENOENT", "EACCES"].includes(err.code) &&
            String(err.syscall).startsWith("spawn")
          )
            preSendFailure(failure);
          reject(failure);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || "").trim() || "{}"));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

function isLocalWorkerPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createDefaultHudRuntimeAdapter(paths, options = {}) {
  return {
    isDefaultHudRuntime: true,
    async runFeature(feature, slotConfig, state) {
      const runId =
        state?.activeWorker?.runId ||
        slotConfig?.runId ||
        feature?.runId ||
        `run-${crypto.randomUUID().slice(0, 8)}`;
      const allowLocalDaemon = Boolean(
        options.allowLocalDaemon === true || process.env.T3_MISSION_LOCAL_WORKER_DAEMON === "1",
      );
      return await execRuntimeSubprocess("dispatch", paths.dotMissionDir, {
        missionId: state?.missionId || "mission",
        feature,
        slotConfig,
        runId,
        repoPath: state?.repoPath || paths.repoDir,
        ...(allowLocalDaemon ? { allowLocalDaemon: true } : {}),
      });
    },
    async pauseWorker(worker, state) {
      const res = await execRuntimeSubprocess("pause-worker", paths.dotMissionDir, {
        missionId: state?.missionId || "mission",
        activeWorker: worker,
      });
      if (
        res &&
        res.ok !== false &&
        worker &&
        typeof worker === "object" &&
        !(
          process.env.T3_ACP_MCP_NODE &&
          String(process.env.T3_ACP_MCP_NODE).trim() &&
          worker.childThreadId
        ) &&
        (typeof worker.workerPid === "number" ||
          typeof worker.daemonStateFile === "string" ||
          worker.runtimeTransport === "bridge-cli-subprocess")
      ) {
        if (
          typeof worker.workerPid !== "number" ||
          !isLocalWorkerPidAlive(worker.workerPid) ||
          (worker.daemonStateFile && !fs.existsSync(worker.daemonStateFile))
        ) {
          return {
            ok: false,
            paused: false,
            canPause: false,
            code: "WORKER_NOT_ALIVE",
            error: "Active worker daemon process is not alive",
          };
        }
      }
      return res;
    },
    async pauseMission(state) {
      return await execRuntimeSubprocess("pause-mission", paths.dotMissionDir, {
        missionId: state?.missionId || "mission",
      });
    },
    async resumeWorker(worker, payload, state) {
      const res = await execRuntimeSubprocess("resume-worker", paths.dotMissionDir, {
        missionId: state?.missionId || "mission",
        activeWorker: {
          ...worker,
          ...(payload?.controlRequestId ? { controlRequestId: payload.controlRequestId } : {}),
        },
        trigger: payload?.trigger || "[resume the mission]",
        diagnostic: payload?.diagnostic || "",
      });
      if (
        res &&
        res.ok !== false &&
        worker &&
        typeof worker === "object" &&
        !(
          process.env.T3_ACP_MCP_NODE &&
          String(process.env.T3_ACP_MCP_NODE).trim() &&
          worker.childThreadId
        ) &&
        (typeof worker.workerPid === "number" ||
          typeof worker.daemonStateFile === "string" ||
          worker.runtimeTransport === "bridge-cli-subprocess")
      ) {
        if (
          typeof worker.workerPid !== "number" ||
          !isLocalWorkerPidAlive(worker.workerPid) ||
          (worker.daemonStateFile && !fs.existsSync(worker.daemonStateFile))
        ) {
          return {
            ok: false,
            resumed: false,
            canResume: false,
            code: "WORKER_NOT_ALIVE",
            error: "Active worker daemon process is not alive",
          };
        }
      }
      return res;
    },
  };
}

function isInitializedMissionState(state) {
  return Boolean(
    state &&
    state.initialized !== false &&
    (state.initialized === true || state.missionId !== "mission-uninitialized"),
  );
}

function buildUninitializedState(repoDir) {
  return {
    initialized: false,
    missionId: "mission-uninitialized",
    title: "Waiting for Mission Initialization",
    repoPath: repoDir,
    status: "planning",
    revision: 0,
    elapsedMs: 0,
    lastStartedAt: null,
    planAccepted: false,
    onboarding: {
      ready: false,
      headline: "Mission directory (.mission/) is not initialized yet",
      instructions:
        "Propose a mission plan to initialize .mission/state.json, or click Approve & Start Mission once your Validation Contract and features are ready.",
    },
    milestones: [],
    assertions: [],
    activeWorker: null,
    sessions: [],
    lastHandoffNeedsAttention: false,
    lastHandoffSummary: null,
    lastHandoffAt: null,
    milestoneValidationTriggered: {},
  };
}

// A separate process group lets the deadline stop Git and its fsmonitor hook.
export const DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS = 10000;
export const MAX_GIT_PREFLIGHT_TIMEOUT_MS = 30000;
export function validateGitPreflightTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GIT_PREFLIGHT_TIMEOUT_MS)
    throw new RangeError("gitPreflightTimeoutMs must be an integer from 1 to 30000 milliseconds");
  return value;
}

function runGitPreflight(candidateDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "-C", candidateDir, "status", "--porcelain"],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish(
        Object.assign(
          new Error(
            `Git preflight exceeded ${timeoutMs}ms (default ${DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS}ms); restart the HUD with --git-preflight-timeout-ms <1..30000> to adjust the budget`,
          ),
          { code: "GIT_PREFLIGHT_TIMEOUT" },
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.length > 4 * 1024 * 1024) {
        stop();
        finish(
          Object.assign(new Error("Git status output exceeded 4 MiB"), {
            code: "GIT_PREFLIGHT_OUTPUT_LIMIT",
          }),
        );
      }
    });
    child.stderr.on("data", (bytes) => {
      if (stderr.length < 65536) stderr += bytes;
    });
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        code === 0
          ? null
          : Object.assign(new Error(stderr || `Git status exited ${code}`), {
              code: "GIT_PREFLIGHT_FAILED",
            }),
      ),
    );
  });
}

async function inspectGitTreeForResume(
  candidateDir,
  featureId,
  { activeWorkerWorktreePath, gitPreflightTimeoutMs = DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS } = {},
) {
  if (
    typeof activeWorkerWorktreePath === "string" &&
    activeWorkerWorktreePath.trim().length > 0 &&
    !fs.existsSync(activeWorkerWorktreePath)
  ) {
    const summary = `Cannot resume mission: worktree path "${activeWorkerWorktreePath}" does not exist.`;
    return {
      path: activeWorkerWorktreePath,
      isGitRepo: false,
      clean: false,
      canResume: false,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      error: "Active worker worktree path does not exist",
      summary,
      diagnostic: summary,
    };
  }

  if (!candidateDir || !fs.existsSync(candidateDir)) {
    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir || null,
      isGitRepo: false,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }

  const dotGitPath = path.join(candidateDir, ".git");
  if (!fs.existsSync(dotGitPath)) {
    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir,
      isGitRepo: false,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }

  try {
    const rawStatus = await runGitPreflight(candidateDir, gitPreflightTimeoutMs);
    const statusLines = rawStatus.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const conflictLines = statusLines.filter((line) =>
      /^(UU|AA|DD|AU|UA|DU|UD)/.test(line.slice(0, 2)),
    );
    if (conflictLines.length > 0) {
      const conflictedFiles = conflictLines.map((line) => line.slice(3).trim()).filter(Boolean);
      const diagnostic = `The mission was paused on ${featureId}, and the code tree has unresolved git merge conflicts (${conflictedFiles.join(", ")}), so resume is blocked.`;
      return {
        path: candidateDir,
        isGitRepo: true,
        clean: false,
        canResume: false,
        hasConflicts: true,
        hasUncommittedChanges: true,
        modifiedFiles: conflictedFiles,
        conflictedFiles,
        summary: diagnostic,
        diagnostic,
      };
    }

    if (statusLines.length > 0) {
      const modifiedFiles = statusLines.map((line) => line.slice(3).trim()).filter(Boolean);
      const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has uncommitted changes (${modifiedFiles.join(", ")}), so I'm resuming that worker.`;
      return {
        path: candidateDir,
        isGitRepo: true,
        clean: false,
        canResume: true,
        hasConflicts: false,
        hasUncommittedChanges: true,
        modifiedFiles,
        conflictedFiles: [],
        summary: diagnostic,
        diagnostic,
      };
    }

    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir,
      isGitRepo: true,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  } catch (err) {
    const errMsg = err?.message || "Git status check failed";
    const diagnostic = `Failed to inspect git working tree at ${candidateDir}: ${errMsg}`;
    return {
      path: candidateDir,
      isGitRepo: false,
      clean: false,
      canResume: false,
      hasConflicts: false,
      hasUncommittedChanges: false,
      error: errMsg,
      code: err.code || "GIT_PREFLIGHT_FAILED",
      retryable: true,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }
}

const readJsonBody = readBoundedJson;

const hudCommandClaims = new WeakMap();
function sendJson(res, statusCode, payload) {
  const claim = hudCommandClaims.get(res);
  if (claim)
    writeTransactionFile(
      claim.file,
      JSON.stringify({
        ...claim.record,
        phase: "completed",
        responseHash: commandDigest({ statusCode, payload }),
        response: { statusCode, payload },
      }) + "\n",
    );
  const body = JSON.stringify(payload);
  afterMissionCommit(() => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  });
}

function readHudTelemetry(paths, state, progressLog) {
  const observations = readRecentObservations(paths.dotMissionDir);
  return {
    observations,
    threadFeed: buildThreadFeed(state, observations, progressLog || []),
    readiness: inspectRepoAgentReadiness(state.repoPath || paths.repoDir, {
      missionDir: paths.dotMissionDir,
      embedded: state.readiness || state.agentReadiness,
    }),
  };
}

async function readLiveThread(threadId) {
  if (!process.env.T3_ACP_MCP_NODE || !process.env.T3_ACP_MCP_ENTRYPOINT) return null;
  return callT3McpTool("t3_thread_read", { threadId }, { env: process.env, timeoutMs: 3000 });
}

export function createMissionHudServer({
  missionDir,
  port = 0,
  host = "127.0.0.1",
  onCommand,
  dispatchAdapter,
  runtimeAdapter,
  allowLocalDaemon = false,
  gitPreflightTimeoutMs = DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS,
  notifyUrl = process.env.T3_MISSION_NOTIFY_URL || null,
  diagnosticWriter,
  threadReader = readLiveThread,
  threadSender = sendLiveThread,
} = {}) {
  validateGitPreflightTimeout(gitPreflightTimeoutMs);
  const paths = resolveMissionPaths(missionDir || process.cwd());
  const hasCustomAdapter = Boolean(dispatchAdapter || runtimeAdapter);
  const effectiveAdapter =
    dispatchAdapter ||
    runtimeAdapter ||
    createDefaultHudRuntimeAdapter(paths, { allowLocalDaemon });
  const resolvedNotifyUrl =
    typeof notifyUrl === "string" && notifyUrl.trim() ? notifyUrl.trim() : null;
  const sseClients = new Set();
  const diagnostics = createDiagnostics(diagnosticWriter ? { write: diagnosticWriter } : {});
  let sseEventSeq = 1;
  let fsWatcher = null;
  let parentWatcher = null;
  let pollInterval = null;
  let lastDiskSignature = "";
  let lastBroadcastSnapshotSignature = "";
  let closed = false;

  // Loading a HUD never establishes ownership of an execution runtime.

  async function handleAutopilotCommand(...args) {
    return runMissionSteps(paths.dotMissionDir, handleAutopilotCommandSteps(...args), {
      create: true,
    });
  }
  async function handleApprove(...args) {
    return runMissionSteps(paths.dotMissionDir, handleApproveSteps(...args), { create: true });
  }
  async function handleReject(...args) {
    return runMissionSteps(paths.dotMissionDir, handleRejectSteps(...args), { create: true });
  }
  async function handleModelSlots(...args) {
    return runMissionSteps(paths.dotMissionDir, handleModelSlotsSteps(...args), { create: true });
  }
  async function handlePause(...args) {
    return runMissionSteps(paths.dotMissionDir, handlePauseSteps(...args), { create: true });
  }
  async function handleResume(...args) {
    return runMissionSteps(paths.dotMissionDir, handleResumeSteps(...args), { create: true });
  }
  async function handleSteer(req, res) {
    const body = validateSteeringRequest(await readJsonBody(req));
    return runMissionSteps(paths.dotMissionDir, handleSteerSteps(body, res), { create: true });
  }

  function* handleSteerSteps(body, res) {
    if (beginHudCommand("steer", body, res)) return;
    const state = safeReadJsonSync(paths.statePath, null);
    if (!isInitializedMissionState(state)) {
      sendJson(res, 409, {
        ok: false,
        code: "MISSION_UNINITIALIZED",
        error: "Initialize a Mission before steering a thread.",
      });
      return;
    }
    const doc = safeReadJsonSync(paths.featuresPath, { features: [] });
    const target = resolveSteeringTarget(state, body, Array.isArray(doc) ? doc : doc.features);
    const delivery = yield async () => {
      try {
        return await threadSender(target.threadId, body.message);
      } catch {
        throw Object.assign(
          new Error(
            "The T3 bridge could not send this instruction. Check the thread before retrying.",
          ),
          { statusCode: 502, code: "STEERING_FAILED" },
        );
      }
    };
    const entries = buildProgressLogEntries(readProgressLogSync(paths.progressLogPath), [
      {
        type: "session_steered",
        message: body.message,
        threadId: target.threadId,
        sessionId: target.sessionId,
        runId: target.runId,
        featureId: target.featureId,
        workerNumber: target.workerNumber,
        role: "User",
        details: { threadId: target.threadId, message: body.message, delivery },
      },
    ]);
    commitMissionChanges([], entries);
    broadcastSnapshot("session_steered");
    sendJson(res, 200, { ok: true, threadId: target.threadId, message: body.message, delivery });
  }

  function buildInMemorySnapshot({
    state: rawState,
    features: rawFeatures,
    modelSettings: rawModelSettings,
    progressLog,
  }) {
    const initialized = isInitializedMissionState(rawState);
    const state = initialized
      ? {
          initialized: true,
          missionId: rawState.missionId || "mission-active",
          title: rawState.title || "T3 Mission Control",
          repoPath: rawState.repoPath || paths.repoDir,
          status: rawState.status || "awaiting_input",
          revision: typeof rawState.revision === "number" ? rawState.revision : 1,
          elapsedMs: typeof rawState.elapsedMs === "number" ? rawState.elapsedMs : 0,
          lastStartedAt: rawState.lastStartedAt ?? null,
          planAccepted: Boolean(rawState.planAccepted),
          milestones: Array.isArray(rawState.milestones) ? rawState.milestones : [],
          assertions: Array.isArray(rawState.assertions) ? rawState.assertions : [],
          activeWorker: rawState.activeWorker ?? null,
          sessions: Array.isArray(rawState.sessions) ? rawState.sessions : [],
          lastHandoffNeedsAttention: Boolean(rawState.lastHandoffNeedsAttention),
          lastHandoffSummary: rawState.lastHandoffSummary ?? null,
          lastHandoffAt: rawState.lastHandoffAt ?? null,
          milestoneValidationTriggered:
            rawState.milestoneValidationTriggered &&
            typeof rawState.milestoneValidationTriggered === "object"
              ? rawState.milestoneValidationTriggered
              : {},
          ...rawState,
        }
      : buildUninitializedState(paths.repoDir);

    const featuresList = Array.isArray(rawFeatures)
      ? rawFeatures
      : Array.isArray(rawFeatures?.features)
        ? rawFeatures.features
        : [];

    const modelSettings = normalizeHudModelSettings(
      rawModelSettings || {},
      DEFAULT_HUD_MODEL_SETTINGS,
    );

    return {
      initialized,
      executionHooksConfigured: true,
      state,
      features: featuresList,
      modelSettings,
      progressLog: Array.isArray(progressLog) ? progressLog : [],
      catalog: BUILTIN_MODEL_CATALOG,
      ...readHudTelemetry(paths, state, progressLog),
    };
  }

  function computeSnapshotSignature(snapshot) {
    if (!snapshot) return "";
    return crypto
      .createHash("sha1")
      .update(
        JSON.stringify({
          initialized: snapshot.initialized,
          state: snapshot.state,
          features: snapshot.features,
          readiness: snapshot.readiness,
          observations: snapshot.observations,
          threadFeed: snapshot.threadFeed,
          modelSettings: snapshot.modelSettings,
          progressLogLen: Array.isArray(snapshot.progressLog) ? snapshot.progressLog.length : 0,
          lastLogSeq: Array.isArray(snapshot.progressLog) ? snapshot.progressLog.at(-1)?.seq : null,
        }),
      )
      .digest("hex");
  }

  function loadSnapshot() {
    return missionTransaction(paths.dotMissionDir, loadSnapshotImpl, { create: false });
  }
  function captureDiskBackup() {
    return missionTransaction(paths.dotMissionDir, captureDiskBackupImpl, { create: false });
  }
  function loadSnapshotImpl() {
    const sigBefore = computeDiskSignature();
    let rawState = safeReadJsonSync(paths.statePath, null);
    let rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    let rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
    let progressLog = readProgressLogSync(paths.progressLogPath);
    const sigAfter = computeDiskSignature();
    if (sigBefore !== sigAfter) {
      rawState = safeReadJsonSync(paths.statePath, null);
      rawFeatures = safeReadJsonSync(paths.featuresPath, null);
      rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
      progressLog = readProgressLogSync(paths.progressLogPath);
    }

    return buildInMemorySnapshot({
      state: rawState,
      features: rawFeatures,
      modelSettings: rawModelSettings,
      progressLog,
    });
  }

  function computeDiskSignature() {
    const targets = [
      paths.statePath,
      paths.featuresPath,
      paths.modelSettingsPath,
      paths.progressLogPath,
      path.join(paths.dotMissionDir, "observations.jsonl"),
      path.join(paths.dotMissionDir, "autopilot", "observations.jsonl"),
      path.join(paths.dotMissionDir, "readiness.json"),
      path.join(paths.repoDir, "reports", "readiness", "latest.json"),
      ...observationFiles(paths.dotMissionDir),
    ];
    return targets
      .map((p) => {
        try {
          const st = fs.statSync(p);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return "0:0";
        }
      })
      .join("|");
  }

  function captureDiskBackupImpl() {
    const targets = [
      paths.statePath,
      paths.featuresPath,
      paths.modelSettingsPath,
      paths.progressLogPath,
    ];
    return targets.map((filePath) => {
      const content = readTransactionFile(filePath);
      if (content !== null) return { filePath, exists: true, content };

      return { filePath, exists: false, content: null };
    });
  }

  function requireUnchangedMission(backup) {
    if (diskMatchesBackup(backup)) return;
    const error = new Error(
      "Mission changed while waiting for runtime; current state was preserved",
    );
    error.code = "MISSION_STATE_CHANGED";
    throw error;
  }

  async function awaitUnchangedMission(backup, hook) {
    requireUnchangedMission(backup);
    const result = await hook();
    try {
      requireUnchangedMission(backup);
    } catch (error) {
      error.runtimeResult = result;
      throw error;
    }
    return result;
  }

  async function awaitUnchangedWorkerResult(backup, before, worker, intent, hook) {
    try {
      return await awaitUnchangedMission(backup, hook);
    } catch (error) {
      if (error.code === "MISSION_STATE_CHANGED" && error.runtimeResult)
        await settlePausedWorkerResult(
          paths.dotMissionDir,
          before,
          worker,
          error.runtimeResult,
          intent,
          effectiveAdapter,
        );
      throw error;
    }
  }

  function respondIfDispatchBindingRequired(res, state, doc) {
    const features = Array.isArray(doc) ? doc : doc?.features || [];
    if (!inspectRunDispatchBinding(state, features).requiresBinding) return false;
    sendJson(res, 409, {
      ok: false,
      resumed: false,
      code: "DISPATCH_BINDING_REQUIRED",
      error: "Retry the original BindFeatureDispatch receipt before dispatching or resuming",
      state,
    });
    return true;
  }

  function respondIfWorkerDispatchBlocked(res, state, doc) {
    const features = Array.isArray(doc) ? doc : doc?.features || [];
    const reason = workerDispatchBlockReason(state, state.activeWorker, { features });
    if (!reason) return false;
    sendJson(res, 409, {
      ok: false,
      resumed: false,
      code: "MISSION_NOT_DISPATCHABLE",
      reason,
      error: "The current feature/run must be reconciled by its owner before dispatch",
      state,
    });
    return true;
  }

  function commitMissionChanges(changes, logEntries) {
    return missionTransaction(paths.dotMissionDir, () => {
      for (const [filePath, value] of changes) writeJsonAtomicSync(filePath, value);
      if (logEntries.length) writeProgressLogEntriesSync(paths.progressLogPath, logEntries);
      lastDiskSignature = "";
    });
  }

  function writeSseEvent(res, eventName, data, id) {
    const eventId = id ?? sseEventSeq++;
    const serialized = JSON.stringify(data);
    res.write(`id: ${eventId}\nevent: ${eventName}\ndata: ${serialized}\n\n`);
  }

  function broadcastSnapshot(reason = "update", preloadedSnapshot = null) {
    if (closed) return null;
    const diskSigBefore = computeDiskSignature();
    const snapshot = preloadedSnapshot || loadSnapshot();
    lastDiskSignature = diskSigBefore;
    lastBroadcastSnapshotSignature = computeSnapshotSignature(snapshot);
    const eventId = sseEventSeq++;
    const payload = {
      ...snapshot,
      eventId,
      reason,
      emittedAt: new Date().toISOString(),
    };
    for (const client of sseClients) {
      try {
        writeSseEvent(client, "mission_snapshot", payload, eventId);
      } catch {
        sseClients.delete(client);
      }
    }
    return payload;
  }

  function setupWatchers() {
    lastDiskSignature = computeDiskSignature();
    lastBroadcastSnapshotSignature = computeSnapshotSignature(loadSnapshot());

    const checkAndBroadcast = () => {
      if (closed) return;
      const diskSig = computeDiskSignature();
      const currentSnapshot = loadSnapshot();
      const snapSig = computeSnapshotSignature(currentSnapshot);
      if (diskSig !== lastDiskSignature || snapSig !== lastBroadcastSnapshotSignature) {
        broadcastSnapshot("fs_change", currentSnapshot);
      }
    };

    const attachDotMissionWatch = () => {
      if (fsWatcher || closed) return;
      if (fs.existsSync(paths.dotMissionDir)) {
        try {
          fsWatcher = fs.watch(paths.dotMissionDir, () => {
            checkAndBroadcast();
          });
          fsWatcher.on("error", () => {
            try {
              fsWatcher?.close();
            } catch {
              /* Optional cleanup or data is unavailable; retain the current state. */
            }
            fsWatcher = null;
          });
        } catch {
          fsWatcher = null;
        }
      }
    };

    attachDotMissionWatch();

    if (fs.existsSync(paths.repoDir)) {
      try {
        parentWatcher = fs.watch(paths.repoDir, (_eventType, filename) => {
          if (!filename || filename === ".mission" || String(filename).startsWith(".mission")) {
            attachDotMissionWatch();
            checkAndBroadcast();
          }
        });
        parentWatcher.on("error", () => {});
      } catch {
        parentWatcher = null;
      }
    }

    pollInterval = setInterval(() => {
      attachDotMissionWatch();
      checkAndBroadcast();
    }, 150);
    if (typeof pollInterval.unref === "function") {
      pollInterval.unref();
    }
  }

  async function invokeHudHook(invoke, hookSource = "runtimeAdapter") {
    try {
      return await invoke();
    } catch (cause) {
      const error = new Error(cause?.message || String(cause), { cause });
      if (cause && Object.hasOwn(cause, "runtimeResult")) error.runtimeResult = cause.runtimeResult;
      error.code = cause?.code || "INTERNAL_ERROR";
      error.hudHookFailed = true;
      error.hookSource = cause?.hookSource || hookSource;
      throw error;
    }
  }

  async function notifyCommand(type, payload, snapshot) {
    if (typeof onCommand === "function") {
      await invokeHudHook(() => onCommand({ type, payload, snapshot }), "onCommand");
    }
  }

  async function emitWebhookNotification(type, payload, committedSnapshot) {
    if (!resolvedNotifyUrl) return;
    const reqPromise = fetch(resolvedNotifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        missionDir: paths.dotMissionDir,
        payload,
        state: committedSnapshot?.state,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    await Promise.race([
      reqPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 80);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  }

  function beginHudCommand(command, body, res) {
    if (body.commandId === undefined) return false;
    if (typeof body.commandId !== "string" || !body.commandId.trim())
      throw Object.assign(new Error("commandId must be a non-empty string"), {
        code: "TX_COMMAND_ID_REQUIRED",
      });
    const file = path.join(
      paths.dotMissionDir,
      ".txn",
      "commands",
      transactionHash(`hud:${body.commandId}`) + ".json",
    );
    const commandHash = commandDigest({ command, body });
    const raw = readTransactionFile(file);
    if (raw !== null) {
      const record = JSON.parse(raw);
      if (record.version !== 1 || record.commandHash !== commandHash)
        throw Object.assign(new Error("HUD commandId belongs to a different payload"), {
          code: "TX_COMMAND_ID_CONFLICT",
        });
      if (record.phase === "completed") {
        if (record.responseHash !== commandDigest(record.response))
          throw Object.assign(new Error("HUD command response checksum differs"), {
            code: "TX_COMMAND_RESULT_CORRUPT",
          });
        sendJson(res, record.response.statusCode, record.response.payload);
      } else
        sendJson(res, 409, {
          ok: false,
          code: "COMMAND_OUTCOME_UNKNOWN",
          error: "Reconcile the original command and any external runtime action before retrying",
        });
      return true;
    }
    const record = { version: 1, commandHash, phase: "requested" };
    writeTransactionFile(file, JSON.stringify(record) + "\n");
    hudCommandClaims.set(res, { file, record });
    return false;
  }

  function* handleAutopilotCommandSteps(req, res, command) {
    if (safeReadJsonSync(paths.statePath, null)?.autopilot !== true) return false;
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("autopilot:" + command, body, res)) return true;
    const backup = captureDiskBackup();
    yield () =>
      awaitUnchangedMission(backup, () => notifyCommand(command, { body }, loadSnapshot()));
    try {
      applyAutopilotCommand(paths.dotMissionDir, command, { commandId: body.commandId });
    } catch (error) {
      if (error.code !== "PLAN_ACCEPTANCE_REQUIRED") throw error;
      sendJson(res, 409, {
        ok: false,
        code: error.code,
        error: error.message,
        state: loadSnapshot().state,
      });
      return true;
    }
    lastDiskSignature = computeDiskSignature();
    const snapshot = broadcastSnapshot(`autopilot_${command}`);
    yield () => emitWebhookNotification(command, { body }, snapshot);
    sendJson(res, 200, { ok: true, state: snapshot.state, snapshot });
    return true;
  }

  function* handleApproveSteps(req, res) {
    if (yield () => handleAutopilotCommand(req, res, "approve")) return;
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("approve", body, res)) return;
    let backup = captureDiskBackup();
    const nowIso = new Date().toISOString();
    const existing =
      safeReadJsonSync(paths.statePath, null) || buildUninitializedState(paths.repoDir);
    if (existing.activeWorker && existing.planAccepted === true) {
      const active = inspectDispatchRecords(paths.dotMissionDir).find(
        (record) =>
          record.intent.missionId === existing.missionId &&
          record.intent.runId === existing.activeWorker.runId,
      );
      if (active?.phase === "inflight") {
        sendJson(res, 409, {
          ok: false,
          code: "DISPATCH_OUTCOME_UNKNOWN",
          error: "Reconcile the original dispatch before approving again",
          state: existing,
        });
        return;
      }
    }
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const featuresList = Array.isArray(rawFeatures)
      ? structuredClone(rawFeatures)
      : Array.isArray(rawFeatures?.features)
        ? structuredClone(rawFeatures.features)
        : [];
    if (respondIfDispatchBindingRequired(res, existing, featuresList)) return;
    if (existing.status === "paused" || existing.activeWorker?.status === "paused") {
      sendJson(res, 409, {
        ok: false,
        code: "MISSION_PAUSED",
        error: "Resume the paused Mission explicitly",
        state: existing,
      });
      return;
    }
    if (existing.activeWorker) {
      // Explicit approval clears the plan wait, but never repairs stale run projections.
      const approved = {
        ...existing,
        planAccepted: true,
        status: ["planning", "awaiting_input"].includes(existing.status)
          ? existing.activeWorker.status
          : existing.status,
      };
      if (respondIfWorkerDispatchBlocked(res, approved, featuresList)) return;
    } else if (existing.lastHandoffNeedsAttention === true) {
      sendJson(res, 409, { ok: false, code: "HANDOFF_ATTENTION_REQUIRED", state: existing });
      return;
    }
    const approvedPlan = approvePlanState(existing, nowIso);
    const stagedDispatch =
      !existing.activeWorker &&
      existing.status === "orchestrator_turn" &&
      featuresList.some((feature) => (feature.status || "pending") === "pending");
    const pendingRuntime =
      existing.activeWorker && !inspectRunDispatchBinding(existing, featuresList).hasIdentity;
    if (approvedPlan === existing && !stagedDispatch && !pendingRuntime) {
      yield () =>
        awaitUnchangedMission(backup, () => notifyCommand("approve", { body }, loadSnapshot()));
      const snapshot = loadSnapshot();
      sendJson(res, 200, { ok: true, state: snapshot.state, snapshot });
      return;
    }
    const modelSettings = normalizeHudModelSettings(
      safeReadJsonSync(paths.modelSettingsPath, {}) || {},
      DEFAULT_HUD_MODEL_SETTINGS,
    );
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const hasActiveWorker = Boolean(existing.activeWorker);
    const pendingFeatureIdx = !hasActiveWorker
      ? featuresList.findIndex((f) => (f.status || "pending") === "pending")
      : -1;

    const nextStatus =
      body.status ||
      (hasActiveWorker || pendingFeatureIdx !== -1 ? "running" : "orchestrator_turn");

    const updatedState = {
      ...approvedPlan,
      initialized: true,
      planAccepted: true,
      status: nextStatus,
      revision: (typeof existing.revision === "number" ? existing.revision : 0) + 1,
      lastStartedAt:
        nextStatus === "running"
          ? existing.lastStartedAt || nowIso
          : (existing.lastStartedAt ?? null),
      approvedAt: nowIso,
    };

    if (hasActiveWorker && updatedState.activeWorker) {
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "running",
      };
      updatedState.sessions = (updatedState.sessions || []).map((row) =>
        row.runId === updatedState.activeWorker.runId ? { ...row, status: "running" } : row,
      );
    }

    let selectedFeature = null;
    let selectedWorkerEntry = null;
    if (pendingFeatureIdx !== -1) {
      const f = featuresList[pendingFeatureIdx];
      assertNoUnresolvedDispatch(paths.dotMissionDir, f.id);
      const nextAttempt = (typeof f.attempts === "number" ? f.attempts : 0) + 1;
      const workerNumber = (Array.isArray(existing.sessions) ? existing.sessions.length : 0) + 1;
      const previousIntent = inspectDispatchIntent(paths.dotMissionDir, existing, f, nextAttempt);
      const runId = previousIntent?.runId || f.runId || `run-${crypto.randomUUID().slice(0, 8)}`;
      const rawKind = String(f.kind || "").toLowerCase();
      const rawId = String(f.id || "").toLowerCase();
      const rawSkill = String(f.skillName || "").toLowerCase();
      const isValidator =
        rawKind === "scrutiny" ||
        rawKind === "user_testing" ||
        rawKind === "user-testing" ||
        rawId.startsWith("scrutiny-validator") ||
        rawId.startsWith("user-testing-validator") ||
        rawSkill.includes("scrutiny") ||
        rawSkill.includes("user-testing") ||
        rawSkill.includes("user_testing");
      const kind =
        rawKind === "user-testing"
          ? "user_testing"
          : f.kind || (isValidator ? "scrutiny" : "implementation");
      const role = isValidator ? "Validator" : kind === "explorer" ? "Explorer" : "Worker";
      const slotName = isValidator ? "validator" : "worker";
      const baseSlotCfg = modelSettings[slotName] || DEFAULT_HUD_MODEL_SETTINGS[slotName];
      const rawOverride = getFeatureSlotOverride(f);
      const slotCfg =
        rawOverride !== null && rawOverride !== undefined
          ? normalizeSlotConfig(rawOverride, baseSlotCfg)
          : normalizeSlotConfig(baseSlotCfg, baseSlotCfg);
      const cleanedWorkerOptions = { ...(slotCfg.options || {}) };
      if (!doesProviderDeclareEffortOption(slotCfg.providerInstanceId)) {
        delete cleanedWorkerOptions.effort;
      }

      featuresList[pendingFeatureIdx] = {
        ...f,
        runId,
        status: "running",
        attempts: nextAttempt,
      };
      selectedFeature = featuresList[pendingFeatureIdx];

      selectedWorkerEntry = {
        runId,
        sessionId: f.sessionId || `${slotName}-${workerNumber}`,
        workerNumber,
        role,
        featureId: f.id,
        featureTitle: f.title || f.id,
        milestoneId: f.milestoneId || "m1",
        kind,
        skillName:
          f.skillName ||
          (isValidator ? `${kind}-validator-${f.milestoneId || "m1"}` : "worker-implementation"),
        slot: slotName,
        providerInstanceId: slotCfg.providerInstanceId,
        model: slotCfg.model,
        options: cleanedWorkerOptions,
        status: "running",
        attempt: nextAttempt,
        startedAt: nowIso,
      };

      selectedWorkerEntry.dispatchNotInvoked = true;
      updatedState.activeWorker = selectedWorkerEntry;
      updatedState.sessions = [
        ...(Array.isArray(existing.sessions) ? existing.sessions : []),
        { ...selectedWorkerEntry },
      ];
    }

    delete updatedState.onboarding;

    const entriesToAppend = [
      {
        timestamp: nowIso,
        type: "plan_approved",
        message: body.message || "Mission plan approved and started",
        featureId: null,
        workerNumber: null,
      },
    ];

    if (selectedWorkerEntry) {
      entriesToAppend.push(
        {
          timestamp: nowIso,
          type: "worker_selected",
          message: `${selectedWorkerEntry.role} #${selectedWorkerEntry.workerNumber} selected ${selectedWorkerEntry.featureTitle}`,
          featureId: selectedWorkerEntry.featureId,
          workerNumber: selectedWorkerEntry.workerNumber,
        },
        {
          timestamp: nowIso,
          type: "worker_started",
          message: `${selectedWorkerEntry.role} #${selectedWorkerEntry.workerNumber} started ${selectedWorkerEntry.featureTitle}`,
          featureId: selectedWorkerEntry.featureId,
          workerNumber: selectedWorkerEntry.workerNumber,
        },
      );
    }

    const logEntries = buildProgressLogEntries(existingLogs, entriesToAppend);
    const logEntry = logEntries[0];

    {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: featuresList,
        modelSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      yield () =>
        awaitUnchangedMission(backup, () =>
          notifyCommand("approve", { body, logEntry, logEntries }, preBroadcastSnapshot),
        );

      const applyRuntimeDaemonMetadata = (runtimeResult) => {
        if (!runtimeResult || typeof runtimeResult !== "object" || !updatedState.activeWorker) {
          return;
        }
        const lastSession =
          Array.isArray(updatedState.sessions) && updatedState.sessions.length > 0
            ? updatedState.sessions[updatedState.sessions.length - 1]
            : null;
        if (runtimeResult.daemonStateFile && typeof runtimeResult.daemonStateFile === "string") {
          updatedState.activeWorker.daemonStateFile = runtimeResult.daemonStateFile;
          if (selectedWorkerEntry)
            selectedWorkerEntry.daemonStateFile = runtimeResult.daemonStateFile;
          if (lastSession) lastSession.daemonStateFile = runtimeResult.daemonStateFile;
          if (pendingFeatureIdx !== -1 && featuresList[pendingFeatureIdx]) {
            featuresList[pendingFeatureIdx].daemonStateFile = runtimeResult.daemonStateFile;
          }
        }
        if (runtimeResult.daemonStatus && typeof runtimeResult.daemonStatus === "string") {
          updatedState.activeWorker.daemonStatus = runtimeResult.daemonStatus;
          if (selectedWorkerEntry) selectedWorkerEntry.daemonStatus = runtimeResult.daemonStatus;
          if (lastSession) lastSession.daemonStatus = runtimeResult.daemonStatus;
          if (pendingFeatureIdx !== -1 && featuresList[pendingFeatureIdx]) {
            featuresList[pendingFeatureIdx].daemonStatus = runtimeResult.daemonStatus;
          }
        }
      };

      let receiptChangedFeatures = false;
      let approvalLogsCommitted = false;
      const runApprovalDispatch = (feature, worker, invoke) =>
        runMissionSteps(
          paths.dotMissionDir,
          (function* () {
            if (respondIfWorkerDispatchBlocked(res, updatedState, featuresList))
              return { rejected: true };
            const intent = prepareDispatch(paths.dotMissionDir, {
              state: existing,
              feature,
              worker,
              target: worker,
            });
            const runtimeWorker = {
              ...intent.worker,
              ...intent.target,
              clientRequestId: intent.clientRequestId,
              status: worker.status,
              dispatchPending: true,
            };
            updatedState.activeWorker = runtimeWorker;
            updatedState.sessions = (updatedState.sessions || []).map((row) =>
              row.runId === worker.runId ? { ...runtimeWorker } : row,
            );
            const index = featuresList.findIndex((row) => row.id === intent.featureId);
            if (index >= 0)
              featuresList[index] = {
                ...featuresList[index],
                runId: intent.runId,
                clientRequestId: intent.clientRequestId,
              };
            requireUnchangedMission(backup);
            const pendingDoc = Array.isArray(rawFeatures)
              ? { features: featuresList, updatedAt: nowIso }
              : { ...rawFeatures, features: featuresList, updatedAt: nowIso };
            commitMissionChanges(
              [
                [paths.featuresPath, pendingDoc],
                [paths.statePath, updatedState],
              ],
              approvalLogsCommitted ? [] : logEntries,
            );
            approvalLogsCommitted = true;
            backup = captureDiskBackup();
            const result = yield () =>
              awaitUnchangedWorkerResult(backup, existing, runtimeWorker, intent, () =>
                dispatchWithIntent(paths.dotMissionDir, intent, (call) => {
                  requireUnchangedMission(backup);
                  const reason = workerDispatchBlockReason(updatedState, runtimeWorker, {
                    features: featuresList,
                  });
                  if (reason)
                    throw Object.assign(new Error(reason), {
                      code: "MISSION_NOT_DISPATCHABLE",
                      runtimeResult: { accepted: false, code: "MISSION_NOT_DISPATCHABLE" },
                    });
                  return invokeHudHook(
                    () =>
                      invoke(
                        {
                          ...(featuresList[index] || feature),
                          invocationId: call.invocationId,
                          dispatchTitle: intent.recovery?.title,
                        },
                        runtimeWorker,
                        updatedState,
                      ),
                    typeof effectiveAdapter.startMissionRun === "function"
                      ? "startMissionRun"
                      : "runFeature",
                  );
                }),
              );
            const verdict = decideDispatchOutcome(result, { expectedIdentity: intent });
            if (verdict.outcome === "UNKNOWN") {
              const error = new Error(
                "Dispatch callback returned an unknown outcome; recover the original intent",
              );
              error.code = "DISPATCH_OUTCOME_UNKNOWN";
              throw error;
            }
            if (
              verdict.outcome === "NOT_ACCEPTED" &&
              verdict.errorCode &&
              !(
                effectiveAdapter.isDefaultHudRuntime &&
                result?.preSend === true &&
                result?.code === "NO_T3_TRANSPORT" &&
                result?.dispatchPending === true
              )
            ) {
              sendJson(res, 409, {
                ok: false,
                code: result.code || "APPROVAL_DISPATCH_REJECTED",
                error: result.error || "Runtime refused approval dispatch",
                state: safeReadJsonSync(paths.statePath, null),
              });
              return { rejected: true };
            }
            if (verdict.outcome === "NOT_ACCEPTED") {
              for (const row of [
                updatedState.activeWorker,
                ...(updatedState.sessions || []).filter((row) => row.runId === intent.runId),
                featuresList[index],
              ]) {
                if (!row) continue;
                row.dispatchPending = true;
                row.runtimeTransport = result.runtimeTransport || "orchestrator-pending";
                for (const key of [
                  "taskId",
                  "childThreadId",
                  "childRunId",
                  "workerPid",
                  "daemonStateFile",
                ])
                  delete row[key];
              }
            }
            if (verdict.outcome === "NOT_ACCEPTED") receiptChangedFeatures = true;
            if (verdict.outcome !== "ACCEPTED") return { rejected: false };
            const merged = mergeDispatchReceipt(
              updatedState,
              { features: featuresList },
              result,
              intent,
            );
            Object.assign(updatedState, merged.state);
            featuresList.splice(0, featuresList.length, ...merged.featuresDoc.features);
            receiptChangedFeatures ||= merged.changed;
            applyRuntimeDaemonMetadata(result);
            return { rejected: false };
          })(),
          { create: true },
        );
      if (selectedFeature && selectedWorkerEntry) {
        if (hasCustomAdapter && typeof effectiveAdapter.startMissionRun === "function") {
          const outcome = yield () =>
            runApprovalDispatch(selectedFeature, selectedWorkerEntry, (feature, worker, state) =>
              effectiveAdapter.startMissionRun(
                paths.dotMissionDir,
                { feature, state },
                effectiveAdapter,
              ),
            );
          if (outcome.rejected) return;
        } else if (typeof effectiveAdapter.runFeature === "function") {
          const outcome = yield () =>
            runApprovalDispatch(selectedFeature, selectedWorkerEntry, (feature, worker, state) =>
              effectiveAdapter.runFeature(feature, worker, state),
            );
          if (outcome.rejected) return;
        }
      } else {
        let worker = updatedState.activeWorker;
        const feature = worker && featuresList.find((row) => row.id === worker.featureId);
        if (worker && feature && !inspectRunDispatchBinding(existing, featuresList).hasIdentity)
          worker = { ...worker, ...resolveFeatureSlot(feature, modelSettings).slotConfig };
        if (worker && feature && !inspectRunDispatchBinding(existing, featuresList).hasIdentity) {
          if (typeof effectiveAdapter.startMissionRun === "function") {
            const outcome = yield () =>
              runApprovalDispatch(feature, worker, (feature, worker, state) =>
                effectiveAdapter.startMissionRun(
                  paths.dotMissionDir,
                  { feature, state },
                  effectiveAdapter,
                ),
              );
            if (outcome.rejected) return;
          } else if (typeof effectiveAdapter.runFeature === "function") {
            const outcome = yield () =>
              runApprovalDispatch(feature, worker, (feature, worker, state) =>
                effectiveAdapter.runFeature(feature, worker, state),
              );
            if (outcome.rejected) return;
          }
        } else if (
          hasCustomAdapter &&
          worker &&
          typeof effectiveAdapter.startMissionRun === "function"
        ) {
          // A known worker may use a lifecycle hook; it cannot replace task ownership.
          if (respondIfWorkerDispatchBlocked(res, updatedState, featuresList)) return;
          const result = yield () =>
            awaitUnchangedWorkerResult(backup, existing, worker, null, () =>
              runClaimedEffect(
                paths.dotMissionDir,
                `approve-hook:${worker.runId}:${body.commandId ?? "implicit"}`,
                () =>
                  invokeHudHook(
                    () =>
                      effectiveAdapter.startMissionRun(
                        paths.dotMissionDir,
                        { feature: worker || null, state: updatedState },
                        effectiveAdapter,
                      ),
                    "startMissionRun",
                  ),
              ),
            );
          const verdict = decideDispatchOutcome(result, { expectedIdentity: worker });
          if (verdict.outcome === "CONFLICT" || verdict.errorCode) {
            sendJson(res, 409, {
              ok: false,
              code: result.code || "APPROVAL_DISPATCH_REJECTED",
              error: result.error || "Runtime refused approval",
              state: safeReadJsonSync(paths.statePath, null),
            });
            return;
          }
          for (const key of ["taskId", "childThreadId"])
            if (worker?.[key] && result?.[key] && worker[key] !== result[key]) {
              const error = new Error(`Lifecycle hook changed accepted ${key}`);
              error.code = "DISPATCH_BINDING_CONFLICT";
              throw error;
            }
          if (verdict.outcome === "ACCEPTED") applyRuntimeDaemonMetadata(result);
        }
      }

      if (selectedFeature || receiptChangedFeatures) {
        const nextFeaturesDoc = Array.isArray(rawFeatures)
          ? { features: featuresList, updatedAt: nowIso }
          : {
              ...(rawFeatures && typeof rawFeatures === "object" ? rawFeatures : {}),
              features: featuresList,
              updatedAt: nowIso,
            };
        requireUnchangedMission(backup);
        commitMissionChanges(
          [
            [paths.featuresPath, nextFeaturesDoc],
            [paths.statePath, updatedState],
          ],
          approvalLogsCommitted ? [] : logEntries,
          {
            preserveReceipts: Boolean(
              updatedState.activeWorker?.taskId || updatedState.activeWorker?.childThreadId,
            ),
          },
        );
      } else {
        requireUnchangedMission(backup);
        commitMissionChanges(
          [[paths.statePath, updatedState]],
          approvalLogsCommitted ? [] : logEntries,
        );
      }

      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("plan_approved");
      yield () => emitWebhookNotification("approve", { body, logEntry, logEntries }, snapshot);
      sendJson(res, 200, {
        ok: true,
        state: snapshot ? snapshot.state : updatedState,
        logEntry,
        logEntries,
        snapshot,
      });
    }
  }

  function* handleRejectSteps(req, res) {
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("reject", body, res)) return;
    const backup = captureDiskBackup();
    const nowIso = new Date().toISOString();
    const existing =
      safeReadJsonSync(paths.statePath, null) || buildUninitializedState(paths.repoDir);
    const nextRevision = (typeof existing.revision === "number" ? existing.revision : 0) + 1;
    const feedback = String(
      body.feedback || body.reason || body.message || "Plan changes requested",
    );
    const updatedState = {
      ...existing,
      planAccepted: false,
      status: "planning",
      lastPlanFeedback: feedback,
      lastPlanRejectedAt: nowIso,
      rejectionRevision: nextRevision,
      revision: nextRevision,
    };
    const existingLogs = readProgressLogSync(paths.progressLogPath);
    const logEntries = buildProgressLogEntries(existingLogs, [
      {
        timestamp: nowIso,
        type: "plan_rejected",
        message: `Mission plan rejected: ${feedback}`,
        details: { feedback },
        featureId: null,
        workerNumber: null,
      },
    ]);
    const logEntry = logEntries[0];
    {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: safeReadJsonSync(paths.featuresPath, null),
        modelSettings: safeReadJsonSync(paths.modelSettingsPath, null),
        progressLog: [...existingLogs, ...logEntries],
      });
      yield () =>
        awaitUnchangedMission(backup, () =>
          notifyCommand("reject", { body, logEntry, logEntries }, preBroadcastSnapshot),
        );
      requireUnchangedMission(backup);
      commitMissionChanges([[paths.statePath, updatedState]], logEntries);
      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("plan_rejected");
      yield () => emitWebhookNotification("reject", { body, logEntry, logEntries }, snapshot);
      sendJson(res, 200, {
        ok: true,
        state: snapshot?.state || updatedState,
        logEntry,
        logEntries,
        snapshot,
      });
    }
  }

  function* handleModelSlotsSteps(req, res) {
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("model-slots", body, res)) return;
    const backup = captureDiskBackup();
    const nowIso = new Date().toISOString();

    const currentSettings = normalizeHudModelSettings(
      safeReadJsonSync(paths.modelSettingsPath, {}) || {},
      DEFAULT_HUD_MODEL_SETTINGS,
    );
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const buildSlotPatch = (prevSlot, incomingRaw) => {
      if (typeof incomingRaw === "string") {
        return incomingRaw;
      }
      if (!incomingRaw || typeof incomingRaw !== "object") {
        return prevSlot;
      }
      const incoming =
        typeof incomingRaw.config === "object" && incomingRaw.config
          ? { ...incomingRaw.config, ...incomingRaw }
          : incomingRaw;

      const hasEffort = incoming.effort !== undefined || incoming.options?.effort !== undefined;
      const hasReasoning =
        incoming.reasoningEffort !== undefined || incoming.options?.reasoningEffort !== undefined;

      const rawEffortVal =
        incoming.effort !== undefined ? incoming.effort : incoming.options?.effort;
      const derivedReasoning =
        hasEffort && !hasReasoning
          ? effortToReasoningEffort(rawEffortVal, prevSlot?.reasoningEffort || "high")
          : (incoming.reasoningEffort ?? incoming.options?.reasoningEffort);

      const nextOptions = {
        ...(prevSlot?.options || {}),
        ...(incoming.options || {}),
      };
      const numericEffort = hasEffort
        ? Math.max(1, Math.min(5, Math.round(Number(rawEffortVal) || 4)))
        : undefined;
      if (hasEffort) {
        if (!hasReasoning) {
          nextOptions.reasoningEffort = derivedReasoning;
        }
      }
      if (hasReasoning && derivedReasoning) {
        nextOptions.reasoningEffort = String(derivedReasoning).trim().toLowerCase();
      }

      const modelChanged = incoming.model !== undefined && incoming.model !== prevSlot?.model;
      const incomingEntry = incoming.model !== undefined ? findCatalogEntry(incoming.model) : null;
      const effectiveProvider =
        incoming.providerInstanceId ??
        (modelChanged ? incomingEntry?.providerInstanceId : undefined) ??
        prevSlot?.providerInstanceId;

      if (doesProviderDeclareEffortOption(effectiveProvider)) {
        if (numericEffort !== undefined) {
          nextOptions.effort = numericEffort;
        }
      } else {
        delete nextOptions.effort;
      }

      const merged = {
        ...prevSlot,
        ...(modelChanged
          ? {
              providerInstanceId:
                incoming.providerInstanceId ??
                incomingEntry?.providerInstanceId ??
                prevSlot?.providerInstanceId,
              label: incoming.label ?? incomingEntry?.label ?? incoming.model,
              supportsEffort: incoming.supportsEffort,
            }
          : {}),
        ...(incoming.model !== undefined ? { model: incoming.model } : {}),
        ...(incoming.providerInstanceId !== undefined
          ? { providerInstanceId: incoming.providerInstanceId }
          : {}),
        ...(incoming.label !== undefined ? { label: incoming.label } : {}),
        ...(numericEffort !== undefined ? { effort: numericEffort } : {}),
        ...(derivedReasoning !== undefined ? { reasoningEffort: derivedReasoning } : {}),
        options: nextOptions,
      };
      if (hasEffort && !hasReasoning) {
        merged.reasoningEffort = derivedReasoning;
      }
      return merged;
    };

    const patch = {};
    const slotKey = body.slot || body.role;
    if (slotKey && ["orchestrator", "worker", "validator"].includes(slotKey)) {
      patch[slotKey] = buildSlotPatch(currentSettings[slotKey], body);
    }

    const container = body.modelSettings || body.slots || body;
    for (const role of ["orchestrator", "worker", "validator"]) {
      if (container && container[role] !== undefined && role !== slotKey) {
        patch[role] = buildSlotPatch(currentSettings[role], container[role]);
      }
    }
    if (typeof container?.skipScrutiny === "boolean") {
      patch.skipScrutiny = container.skipScrutiny;
    }
    if (typeof container?.skipUserTesting === "boolean") {
      patch.skipUserTesting = container.skipUserTesting;
    }

    const changedRoles = Object.keys(patch).filter((k) =>
      ["orchestrator", "worker", "validator"].includes(k),
    );
    const modifiedKeys = [...changedRoles];
    if (typeof patch.skipScrutiny === "boolean") {
      modifiedKeys.push("skipScrutiny");
    }
    if (typeof patch.skipUserTesting === "boolean") {
      modifiedKeys.push("skipUserTesting");
    }
    const existingModified = Array.isArray(currentSettings.userModifiedSlots)
      ? currentSettings.userModifiedSlots
      : [];
    patch.userModifiedSlots = Array.from(new Set([...existingModified, ...modifiedKeys]));

    const updatedSettings = normalizeHudModelSettings(patch, currentSettings);
    const rawExistingState = safeReadJsonSync(paths.statePath, null);
    const existingState = rawExistingState || buildUninitializedState(paths.repoDir);
    const isUninitializedState = !isInitializedMissionState(rawExistingState);
    const updatedState = {
      ...existingState,
      initialized: isUninitializedState ? false : true,
      missionId: isUninitializedState ? "mission-uninitialized" : existingState.missionId,
      revision: (typeof existingState.revision === "number" ? existingState.revision : 0) + 1,
    };
    const summaryParts = (changedRoles.length ? changedRoles : ["validator"]).map((role) => {
      const slotCfg = updatedSettings[role];
      return slotCfg.supportsEffort === false
        ? `${role}=${slotCfg.model}`
        : `${role}=${slotCfg.model} (${slotCfg.reasoningEffort}/${slotCfg.effort})`;
    });

    const logEntries = buildProgressLogEntries(existingLogs, [
      {
        timestamp: nowIso,
        type: "model_slots_updated",
        message: `Model slots updated: ${summaryParts.join(", ")}`,
        details: { updatedSettings, changedRoles },
      },
    ]);
    const logEntry = logEntries[0];

    {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: rawFeatures,
        modelSettings: updatedSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      yield () =>
        awaitUnchangedMission(backup, () =>
          notifyCommand("model-slots", { body, updatedSettings, logEntry }, preBroadcastSnapshot),
        );

      requireUnchangedMission(backup);
      commitMissionChanges(
        [
          [paths.modelSettingsPath, updatedSettings],
          [paths.statePath, updatedState],
        ],
        logEntries,
      );

      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("model_slots_updated");
      yield () =>
        emitWebhookNotification("model-slots", { body, updatedSettings, logEntry }, snapshot);
      sendJson(res, 200, {
        ok: true,
        modelSettings: updatedSettings,
        state: updatedState,
        logEntry,
        snapshot,
      });
    }
  }

  function diskMatchesBackup(backup) {
    const current = captureDiskBackup();
    return current.every(
      (item, i) => item.exists === backup[i].exists && item.content === backup[i].content,
    );
  }

  function respondIfLifecycleChanged(res, backup, previousState, action) {
    if (diskMatchesBackup(backup)) return false;
    const snapshot = broadcastSnapshot("mission_state_changed") || loadSnapshot();
    const state = snapshot.state;
    const pausedDuringResume =
      action === "resume" &&
      state.status === "paused" &&
      state.activeWorker?.runId === previousState.activeWorker?.runId &&
      (state.pausedAt !== previousState.pausedAt || state.revision !== previousState.revision);
    sendJson(res, 409, {
      ok: false,
      resumed: false,
      code: pausedDuringResume ? "MISSION_PAUSED_DURING_RESUME" : "MISSION_STATE_CHANGED",
      error: "Mission changed while waiting for runtime; current state was preserved",
      state,
      snapshot,
    });
    return true;
  }

  function applyWorkerControlMetadata(state, result) {
    const worker = state.activeWorker;
    if (!worker) return;
    const remote = isRemoteWorker(worker) || isRemoteWorker(result);
    const local =
      !remote &&
      typeof result?.daemonStatus === "string" &&
      inspectOwnedLocalWorker(worker, paths.dotMissionDir);
    if (!remote && !local) return;
    const update = (row) => {
      const next = { ...row };
      if (remote) {
        return stripLocalWorkerMetadata(next);
      } else next.daemonStatus = result.daemonStatus;
      return next;
    };
    state.activeWorker = update(worker);
    state.sessions = (state.sessions || []).map((row) =>
      row.runId === worker.runId ? update(row) : row,
    );
  }

  function commitLifecycleState(state, logEntries) {
    applyWorkerControlMetadata(state);
    const changes = [[paths.statePath, state]];
    if (state.activeWorker) {
      const doc = safeReadJsonSync(paths.featuresPath, { features: [] });
      const features = Array.isArray(doc) ? doc : doc.features || [];
      let changed = false;
      const cleaned = features.map((feature) => {
        if (
          feature.id !== state.activeWorker.featureId ||
          (feature.runId && feature.runId !== state.activeWorker.runId)
        )
          return feature;
        const next = { ...feature, status: state.activeWorker.status };
        if (state.activeWorker.status === "paused") next.pausedAt = state.activeWorker.pausedAt;
        else delete next.pausedAt;
        if (isRemoteWorker(state.activeWorker))
          for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) delete next[key];
        if (JSON.stringify(next) !== JSON.stringify(feature)) changed = true;
        return next;
      });
      if (changed)
        changes.push([
          paths.featuresPath,
          Array.isArray(doc) ? cleaned : { ...doc, features: cleaned },
        ]);
    }
    commitMissionChanges(changes, logEntries);
  }

  function* handlePauseSteps(req, res) {
    if (yield () => handleAutopilotCommand(req, res, "pause")) return;
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("pause", body, res)) return;
    const existingState = safeReadJsonSync(paths.statePath, null);
    if (!isInitializedMissionState(existingState)) {
      sendJson(res, 409, {
        ok: false,
        code: "MISSION_NOT_INITIALIZED",
        error: "Cannot pause an uninitialized mission",
      });
      return;
    }
    const control = existingState.pauseControl;
    const effectsDir = path.join(paths.dotMissionDir, ".txn", "effects");
    const resuming =
      listTransactionFiles(effectsDir).some((name) => {
        if (!/^[a-f0-9]+\.json$/.test(name)) return false;
        const effect = JSON.parse(readTransactionFile(path.join(effectsDir, name)));
        return (
          effect.phase === "requested" &&
          ["resume:", "resume-hook:", "runtime-resume:"].some((prefix) =>
            effect.effectId?.startsWith(prefix),
          ) &&
          effect.effectId.includes(":" + existingState.activeWorker?.runId + ":")
        );
      }) ||
      listTransactionFiles(paths.dotMissionDir).some((name) => {
        if (!/^dispatch-[a-f0-9]+\.json$/.test(name)) return false;
        const record = JSON.parse(readTransactionFile(path.join(paths.dotMissionDir, name)));
        return (
          record.phase === "inflight" &&
          record.controlOperation === "resume" &&
          record.intent.runId === existingState.activeWorker?.runId
        );
      });
    if (
      existingState.status === "paused" &&
      control &&
      control.epoch === existingState.pauseEpoch &&
      control.runId === (existingState.activeWorker?.runId ?? null) &&
      !resuming
    ) {
      const status =
        control.httpStatus ??
        (control.phase === "confirmed" ? 200 : control.phase === "unknown" ? 500 : 409);
      sendJson(res, status, {
        ok: status === 200,
        code: control.code,
        ...(control.error ? { error: control.error } : {}),
        state: existingState,
      });
      return;
    }
    const now = new Date().toISOString();
    const updatedState = structuredClone(existingState);
    const started = Date.parse(updatedState.lastStartedAt);
    if (Number.isFinite(started))
      updatedState.elapsedMs = (updatedState.elapsedMs || 0) + Math.max(0, Date.now() - started);
    updatedState.lastStartedAt = null;
    updatedState.status = "paused";
    updatedState.pausedAt = now;
    updatedState.pauseEpoch = (existingState.pauseEpoch ?? 0) + 1;
    updatedState.revision = (existingState.revision ?? 0) + 1;
    updatedState.pauseControl = {
      phase: "requested",
      code: "PAUSE_CONTROL_PENDING",
      at: now,
      runId: existingState.activeWorker?.runId ?? null,
      epoch: updatedState.pauseEpoch,
    };
    const existingLogs = readProgressLogSync(paths.progressLogPath);
    const gateEntries = buildProgressLogEntries(existingLogs, [
      {
        timestamp: now,
        type: "mission_pause_requested",
        message: "Mission Pause gate committed; worker control awaits confirmation",
        featureId: existingState.activeWorker?.featureId ?? null,
        workerNumber: existingState.activeWorker?.workerNumber ?? null,
      },
    ]);
    commitMissionChanges([[paths.statePath, updatedState]], gateEntries);
    const backup = captureDiskBackup();
    const recordFailure = (phase, code, error, status, controlReceipt) => {
      const current = safeReadJsonSync(paths.statePath, null);
      if (
        current.missionId === existingState.missionId &&
        current.pauseEpoch === updatedState.pauseEpoch &&
        current.activeWorker?.runId === existingState.activeWorker?.runId
      ) {
        const at = new Date().toISOString();
        current.pauseControl = {
          ...updatedState.pauseControl,
          phase,
          code,
          at,
          error,
          httpStatus: status,
          controlReceipt,
        };
        current.revision++;
        const entries = buildProgressLogEntries(readProgressLogSync(paths.progressLogPath), [
          {
            timestamp: at,
            type: phase === "rejected" ? "pause_control_rejected" : "pause_control_unknown",
            message: error,
            featureId: existingState.activeWorker?.featureId ?? null,
            details: current.pauseControl,
          },
        ]);
        commitMissionChanges([[paths.statePath, current]], entries);
      }
      sendJson(res, status, {
        ok: false,
        code,
        error,
        state: safeReadJsonSync(paths.statePath, null),
      });
    };
    const results = [];
    try {
      yield () => notifyCommand("pause", { body, logEntries: gateEntries }, loadSnapshot());
      if (respondIfLifecycleChanged(res, backup, existingState, "pause")) return;
      const worker = existingState.activeWorker;
      const needsWorkerControl =
        worker && (worker.taskId || worker.childThreadId || !worker.dispatchPending);
      const controls = [];
      if (needsWorkerControl) {
        if (typeof effectiveAdapter.pauseWorker !== "function") {
          recordFailure(
            "rejected",
            "NO_T3_TRANSPORT",
            "No pauseWorker transport for the active run",
            409,
          );
          return;
        }
        controls.push([
          "worker",
          () =>
            invokeHudHook(() => effectiveAdapter.pauseWorker(worker, existingState), "pauseWorker"),
        ]);
      }
      if (typeof effectiveAdapter.pauseMission === "function")
        controls.push([
          "mission",
          () => invokeHudHook(() => effectiveAdapter.pauseMission(existingState), "pauseMission"),
        ]);
      for (const [kind, invoke] of controls) {
        const effectId = `pause:${existingState.missionId}:${worker?.runId ?? "mission"}:${updatedState.pauseEpoch}:${kind}`;
        const result = yield () =>
          runClaimedEffect(paths.dotMissionDir, effectId, invoke, {
            validate: () => requireUnchangedMission(backup),
          });
        if (respondIfLifecycleChanged(res, backup, existingState, "pause")) return;
        const verdict = classifyControlReceipt(result, "pause", worker ?? {});
        if (verdict.classification === "rejected") {
          const code =
            dispatchReceiptSources(result).find((row) => row.code)?.code ||
            "PAUSE_BLOCKED_BY_RUNTIME";
          const error =
            dispatchReceiptSources(result).find((row) => row.error)?.error ||
            `Runtime pause ${kind} rejected`;
          recordFailure("rejected", code, error, 409, verdict);
          return;
        }
        if (verdict.classification !== "confirmed") {
          recordFailure(
            "unknown",
            "PAUSE_UNCONFIRMED",
            `Runtime pause ${kind} did not confirm control`,
            409,
            verdict,
          );
          return;
        }
        results.push(verdict);
      }
    } catch (error) {
      if (!error.hudHookFailed && respondIfLifecycleChanged(res, backup, existingState, "pause"))
        return;
      if (!diskMatchesBackup(backup)) {
        sendJson(res, 500, {
          ok: false,
          code: error.code || "INTERNAL_ERROR",
          error: error.message,
        });
        return;
      }
      recordFailure("unknown", error.code || "PAUSE_CONTROL_FAILED", error.message, 500);
      return;
    }
    if (respondIfLifecycleChanged(res, backup, existingState, "pause")) return;
    const confirmedAt = new Date().toISOString();
    updatedState.pauseControl = {
      ...updatedState.pauseControl,
      phase: "confirmed",
      code: "PAUSE_CONFIRMED",
      at: confirmedAt,
      controlReceipts: results,
    };
    updatedState.revision++;
    const entries = [
      {
        timestamp: confirmedAt,
        type: "mission_paused",
        message: "Mission paused",
        featureId: updatedState.activeWorker?.featureId ?? null,
        workerNumber: updatedState.activeWorker?.workerNumber ?? null,
      },
    ];
    if (updatedState.activeWorker) {
      const runId = updatedState.activeWorker.runId;
      const update = (row) => ({ ...row, status: "paused", pausedAt: updatedState.pausedAt });
      updatedState.activeWorker = update(updatedState.activeWorker);
      updatedState.sessions = (updatedState.sessions || []).map((row) =>
        row.runId === runId ? update(row) : row,
      );
      const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
      const rows = Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || [];
      const features = rows.map((row) =>
        row.id === updatedState.activeWorker.featureId && (!row.runId || row.runId === runId)
          ? update(row)
          : row,
      );
      if (rawFeatures)
        commitMissionChanges(
          [
            [
              paths.featuresPath,
              Array.isArray(rawFeatures) ? features : { ...rawFeatures, features },
            ],
          ],
          [],
        );
      for (const result of results) applyWorkerControlMetadata(updatedState, result.raw);
      const worker = updatedState.activeWorker;
      const title = worker.featureTitle || worker.title || worker.featureId || "feature";
      entries.push({
        timestamp: confirmedAt,
        type: "worker_paused",
        message: `Worker #${worker.workerNumber ?? 1} paused ${title}`,
        featureId: updatedState.activeWorker.featureId,
        workerNumber: updatedState.activeWorker.workerNumber ?? null,
      });
    }
    const logEntries = buildProgressLogEntries(readProgressLogSync(paths.progressLogPath), entries);
    commitLifecycleState(updatedState, logEntries);
    const snapshot = broadcastSnapshot("mission_paused");
    yield () => emitWebhookNotification("pause", { body, logEntries }, snapshot);
    sendJson(res, 200, { ok: true, state: snapshot.state, logEntries, snapshot });
  }

  function* handleResumeSteps(req, res) {
    if (yield () => handleAutopilotCommand(req, res, "resume")) return;
    const body = yield () => readJsonBody(req);
    if (beginHudCommand("resume", body, res)) return;
    const nowIso = new Date().toISOString();

    const existingState = safeReadJsonSync(paths.statePath, null);
    if (!existingState || existingState.planAccepted !== true) {
      const stateFallback = existingState || buildUninitializedState(paths.repoDir);
      sendJson(res, 409, {
        ok: false,
        code: "PLAN_ACCEPTANCE_REQUIRED",
        error: "Cannot resume mission before plan is accepted",
        state: stateFallback,
      });
      return;
    }

    if (existingState.status !== "paused" && existingState.activeWorker?.status !== "paused") {
      sendJson(res, 409, {
        ok: false,
        code: "MISSION_NOT_PAUSED",
        error: "Mission is not in a paused state",
        state: existingState,
      });
      return;
    }

    if (existingState.lastHandoffNeedsAttention === true) {
      sendJson(res, 409, {
        ok: false,
        code: "HANDOFF_ATTENTION_REQUIRED",
        error: "Cannot resume mission while handoff items require orchestrator attention",
        state: existingState,
      });
      return;
    }

    let workerNumber = null;
    let featureId = "active-feature";
    let featureTitle = "active feature";

    if (existingState.activeWorker) {
      workerNumber = existingState.activeWorker.workerNumber ?? null;
      featureId =
        existingState.activeWorker.featureId || existingState.activeWorker.id || "active-feature";
      featureTitle =
        existingState.activeWorker.featureTitle || existingState.activeWorker.title || featureId;
    }

    const activeWorkerWorktreePath = existingState.activeWorker?.worktreePath || null;
    const candidateDir = activeWorkerWorktreePath || existingState.repoPath || paths.repoDir;
    const gitBackup = captureDiskBackup();
    const gitCheck = yield () =>
      inspectGitTreeForResume(candidateDir, featureId, {
        activeWorkerWorktreePath,
        gitPreflightTimeoutMs,
      });
    if (respondIfLifecycleChanged(res, gitBackup, existingState, "resume")) return;

    if (!gitCheck.canResume) {
      sendJson(res, 409, {
        ok: false,
        code:
          gitCheck.code ||
          (gitCheck.hasConflicts ? "GIT_RESUME_BLOCKED" : "RESUME_BLOCKED_BY_GIT_ERROR"),
        reasonCode: gitCheck.hasConflicts
          ? "RESUME_BLOCKED_BY_CONFLICTS"
          : "RESUME_BLOCKED_BY_GIT_ERROR",
        error: gitCheck.hasConflicts
          ? "Unresolved git merge conflicts in working tree"
          : gitCheck.error || gitCheck.summary || "Git preflight check failed",
        diagnostic: gitCheck.summary || gitCheck.diagnostic,
        gitCheck,
        state: existingState,
      });
      return;
    }

    const diagnostic = body.diagnostic || gitCheck.diagnostic;
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    if (respondIfDispatchBindingRequired(res, existingState, rawFeatures)) return;
    if (
      existingState.activeWorker &&
      respondIfWorkerDispatchBlocked(res, existingState, rawFeatures)
    )
      return;
    const rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const updatedState = structuredClone(existingState);
    updatedState.initialized = true;
    updatedState.status = "running";
    updatedState.lastStartedAt = nowIso;
    updatedState.resumedAt = nowIso;
    updatedState.revision =
      (typeof updatedState.revision === "number" ? updatedState.revision : 0) + 1;

    if (updatedState.activeWorker) {
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "running",
        resumePending: true,
        resumedAt: nowIso,
      };
      delete updatedState.activeWorker.pausedAt;

      if (Array.isArray(updatedState.sessions)) {
        updatedState.sessions = updatedState.sessions.map((s) =>
          s.runId === updatedState.activeWorker.runId ||
          s.workerNumber === workerNumber ||
          (featureId && s.featureId === featureId)
            ? { ...s, status: "running", resumePending: true, resumedAt: nowIso }
            : s,
        );
      }
    }

    updatedState.lastResumeTrigger = "[resume the mission]";
    updatedState.lastResumeDiagnostic = diagnostic;

    const resumeSummary =
      body.resumeSummary ||
      (updatedState.activeWorker
        ? `Resume ${featureId} (${featureTitle})`
        : "Resume mission execution");

    const entriesToAppend = [
      {
        timestamp: nowIso,
        type: "mission_resumed",
        message: "Mission resumed",
        featureId: updatedState.activeWorker ? featureId : null,
        workerNumber,
        details: {
          trigger: "[resume the mission]",
          diagnostic,
          gitCheck,
        },
      },
      {
        timestamp: nowIso,
        type: "run_started",
        message: `Run started: ${resumeSummary}`,
        featureId: updatedState.activeWorker ? featureId : null,
        workerNumber,
        details: {
          trigger: "[resume the mission]",
          diagnostic,
        },
      },
    ];

    const logEntries = buildProgressLogEntries(existingLogs, entriesToAppend);
    const backup = captureDiskBackup();

    const preBroadcastSnapshot = buildInMemorySnapshot({
      state: updatedState,
      features: rawFeatures,
      modelSettings: rawModelSettings,
      progressLog: [...existingLogs, ...logEntries],
    });

    yield () =>
      notifyCommand(
        "resume",
        {
          body,
          trigger: "[resume the mission]",
          diagnostic,
          gitCheck,
          logEntries,
        },
        preBroadcastSnapshot,
      );
    if (respondIfLifecycleChanged(res, backup, existingState, "resume")) return;

    let legacyResumeReceipt = null;
    const resumeCommandId = existingState.activeWorker
      ? resumeControlEffectId(paths.dotMissionDir, existingState.activeWorker, existingState)
      : "implicit";
    const pendingDispatch =
      !inspectRunDispatchBinding(
        existingState,
        Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || [],
      ).hasIdentity &&
      !existingState.activeWorker?.workerPid &&
      !existingState.activeWorker?.daemonStateFile &&
      (existingState.activeWorker?.dispatchPending === true ||
        (existingState.activeWorker?.runtimeTransport === "orchestrator-pending" &&
          !existingState.activeWorker.workerPid));
    if (
      !pendingDispatch &&
      existingState.activeWorker &&
      typeof effectiveAdapter.resumeWorker === "function"
    ) {
      const legacyFeature = (
        Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || []
      ).find((f) => f.id === existingState.activeWorker.featureId);
      const legacyIntent =
        !existingState.activeWorker.workerPid &&
        !existingState.activeWorker.daemonStateFile &&
        !inspectRunDispatchBinding(
          existingState,
          Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || [],
        ).hasIdentity
          ? prepareDispatch(paths.dotMissionDir, {
              state: existingState,
              feature: legacyFeature,
              worker: existingState.activeWorker,
              target: existingState.activeWorker,
            })
          : null;
      const invoke = (call) => {
        requireUnchangedMission(backup);
        return invokeHudHook(
          () =>
            effectiveAdapter.resumeWorker(
              {
                ...existingState.activeWorker,
                ...(legacyIntent
                  ? {
                      clientRequestId: legacyIntent.clientRequestId,
                      invocationId: call.invocationId,
                    }
                  : {}),
              },
              {
                trigger: "[resume the mission]",
                diagnostic,
                gitCheck,
                body,
                controlRequestId: resumeCommandId,
              },
              existingState,
            ),
          "resumeWorker",
        );
      };
      const rwRes = yield () =>
        legacyIntent
          ? dispatchWithIntent(paths.dotMissionDir, legacyIntent, invoke, { operation: "resume" })
          : runClaimedEffect(paths.dotMissionDir, resumeCommandId, invoke);
      if (legacyIntent) legacyResumeReceipt = { result: rwRes, intent: legacyIntent };
      if (!diskMatchesBackup(backup)) {
        yield () =>
          settlePausedWorkerResult(
            paths.dotMissionDir,
            existingState,
            existingState.activeWorker,
            rwRes,
            legacyIntent,
            effectiveAdapter,
            "resume",
          );
        respondIfLifecycleChanged(res, backup, existingState, "resume");
        return;
      }
      const verdict = classifyControlReceipt(rwRes, "resume", existingState.activeWorker);
      if (verdict.classification !== "confirmed") {
        sendJson(res, 409, {
          ok: false,
          code: rwRes?.code || "RESUME_BLOCKED_BY_RUNTIME",
          error: rwRes?.error || "Runtime resumeWorker did not confirm resume",
          controlReceipt: verdict,
          state: existingState,
        });
        return;
      }
      applyWorkerControlMetadata(updatedState, rwRes);
    } else if (
      !pendingDispatch &&
      existingState.activeWorker &&
      typeof effectiveAdapter.startMissionRun === "function"
    ) {
      requireUnchangedMission(backup);
      const legacyFeature = (
        Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || []
      ).find((f) => f.id === existingState.activeWorker.featureId);
      const legacyIntent =
        !existingState.activeWorker.workerPid &&
        !existingState.activeWorker.daemonStateFile &&
        !inspectRunDispatchBinding(
          existingState,
          Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || [],
        ).hasIdentity
          ? prepareDispatch(paths.dotMissionDir, {
              state: existingState,
              feature: legacyFeature,
              worker: existingState.activeWorker,
              target: existingState.activeWorker,
            })
          : null;
      const invoke = (call) =>
        invokeHudHook(
          () =>
            effectiveAdapter.startMissionRun(
              paths.dotMissionDir,
              {
                trigger: "[resume the mission]",
                diagnostic,
                gitCheck,
                body,
                invocationId: call?.invocationId,
              },
              effectiveAdapter,
            ),
          "startMissionRun",
        );
      const smRes = yield () =>
        legacyIntent
          ? dispatchWithIntent(paths.dotMissionDir, legacyIntent, invoke, { operation: "resume" })
          : runClaimedEffect(paths.dotMissionDir, resumeCommandId, invoke);
      if (legacyIntent) legacyResumeReceipt = { result: smRes, intent: legacyIntent };
      if (!diskMatchesBackup(backup)) {
        yield () =>
          settlePausedWorkerResult(
            paths.dotMissionDir,
            existingState,
            existingState.activeWorker,
            smRes,
            null,
            effectiveAdapter,
            "resume",
          );
        respondIfLifecycleChanged(res, backup, existingState, "resume");
        return;
      }
      const verdict = classifyControlReceipt(smRes, "resume", existingState.activeWorker);
      if (verdict.classification !== "confirmed") {
        sendJson(res, 409, {
          ok: false,
          code: smRes?.code || "RESUME_BLOCKED_BY_RUNTIME",
          error: smRes?.error || "Runtime startMissionRun did not confirm resume",
          controlReceipt: verdict,
          state: existingState,
        });
        return;
      }
      applyWorkerControlMetadata(updatedState, smRes);
    } else if (!pendingDispatch && existingState.activeWorker) {
      sendJson(res, 409, {
        ok: false,
        code: "NO_T3_TRANSPORT",
        error: "No adapter can resume the active run",
        state: existingState,
      });
      return;
    }

    if (respondIfLifecycleChanged(res, backup, existingState, "resume")) return;
    delete updatedState.pauseControl;
    if (legacyResumeReceipt) {
      const merged = mergeDispatchReceipt(
        updatedState,
        { features: Array.isArray(rawFeatures) ? rawFeatures : rawFeatures?.features || [] },
        legacyResumeReceipt.result,
        legacyResumeReceipt.intent,
      );
      commitMissionChanges(
        [
          [paths.featuresPath, merged.featuresDoc],
          [paths.statePath, merged.state],
        ],
        logEntries,
        { preserveReceipts: true },
      );
      lastDiskSignature = computeDiskSignature();
    } else commitLifecycleState(updatedState, logEntries);
    const snapshot = broadcastSnapshot("mission_resumed");
    yield () =>
      emitWebhookNotification(
        "resume",
        { body, trigger: "[resume the mission]", diagnostic, gitCheck, logEntries },
        snapshot,
      );
    sendJson(res, 200, {
      ok: true,
      trigger: "[resume the mission]",
      diagnostic,
      gitCheck,
      state: snapshot ? snapshot.state : updatedState,
      logEntries,
      snapshot,
    });
  }

  function serveStaticAsset(res, filename, contentType) {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: `Static asset not found: ${filename}` });
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  }

  async function handleMissionRead(pathname, urlObj, snapshot, res) {
    if (pathname === "/api/mission/state") {
      sendJson(res, 200, snapshot);
      return;
    }
    const threadId = urlObj.searchParams.get("threadId");
    const sessionId = urlObj.searchParams.get("sessionId");
    const sessions = [...snapshot.state.sessions, snapshot.state.activeWorker].filter(Boolean);
    const session =
      threadId || sessionId
        ? sessions.findLast(
            (row) =>
              (!threadId || (row.childThreadId || row.threadId) === threadId) &&
              (!sessionId || [row.sessionId, row.runId, row.id].includes(sessionId)),
          )
        : null;
    const isOwner = threadId && threadId === snapshot.state.ownerThreadId;
    if ((threadId || sessionId) && !session && !isOwner) {
      sendJson(res, 404, { ok: false, code: "SESSION_NOT_FOUND" });
      return;
    }
    let events = session
      ? snapshot.threadFeed.filter((row) => matchesFeedSession(row, session))
      : snapshot.threadFeed;
    let source = "mission";
    let unavailable = false;
    if (threadId) {
      try {
        const response = await threadReader(threadId);
        const messages = normalizeThreadMessages(response, threadId);
        events = [...events, ...messages].slice(-50);
        if (messages.length) source = "thread+mission";
      } catch {
        unavailable = true;
      }
    }
    sendJson(res, 200, { threadId, sessionId, source, unavailable, events });
  }

  const commandHandlers = {
    "/api/mission/approve": handleApprove,
    "/api/mission/reject": handleReject,
    "/api/mission/model-slots": handleModelSlots,
    "/api/mission/pause": handlePause,
    "/api/mission/resume": handleResume,
    "/api/mission/steer": handleSteer,
  };

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    const route = findHudRoute((req.method || "GET").toUpperCase(), (req.url || "/").split("?")[0]);
    const requestContext = diagnostics.beginRequest(req, res, route?.operationId || "unknown");
    try {
      assertTrustedRequest(req, { host, port: api.port });
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = urlObj.pathname;
      const method = (req.method || "GET").toUpperCase();

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID, X-Request-ID",
        });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          status: "alive",
          uptimeSeconds: diagnostics.snapshot().uptimeSeconds,
        });
        return;
      }

      if (method === "GET" && pathname === "/readyz") {
        try {
          const snapshot = loadSnapshot();
          sendJson(res, 200, {
            ok: true,
            status: snapshot.state.initialized ? "ready" : "onboarding",
          });
        } catch (error) {
          diagnostics.recordError(error, requestContext);
          sendJson(res, 503, {
            ok: false,
            code: "MISSION_NOT_READY",
            requestId: requestContext.requestId,
          });
        }
        return;
      }

      if (method === "GET" && pathname === "/metrics") {
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(diagnostics.metrics());
        return;
      }

      if (method === "GET" && pathname === "/api/mission/diagnostics") {
        sendJson(res, 200, diagnostics.snapshot());
        return;
      }

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        serveStaticAsset(res, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && (pathname === "/styles.css" || pathname === "/style.css")) {
        serveStaticAsset(res, "styles.css", "text/css; charset=utf-8");
        return;
      }

      if (method === "GET" && pathname === "/app.js") {
        serveStaticAsset(res, "app.js", "application/javascript; charset=utf-8");
        return;
      }

      if (
        method === "GET" &&
        ["/api/mission/state", "/api/mission/thread-feed"].includes(pathname)
      ) {
        const snapshot = loadSnapshot();
        await handleMissionRead(pathname, urlObj, snapshot, res);
        return;
      }

      if (
        method === "GET" &&
        (pathname === "/api/mission/stream" || pathname === "/api/mission/events")
      ) {
        const lastEventIdHeader =
          req.headers["last-event-id"] || urlObj.searchParams.get("lastEventId") || null;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        res.write(": connected\n\n");
        sseClients.add(res);

        const initialSnapshot = loadSnapshot();
        const eventId = sseEventSeq++;
        writeSseEvent(
          res,
          "mission_snapshot",
          {
            ...initialSnapshot,
            eventId,
            lastEventId: lastEventIdHeader ? String(lastEventIdHeader) : null,
            reason: "initial",
            emittedAt: new Date().toISOString(),
          },
          eventId,
        );

        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === "POST" && Object.hasOwn(commandHandlers, pathname)) {
        await commandHandlers[pathname](req, res);
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      hudCommandClaims.delete(res);
      const errorStatus =
        Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode <= 599
          ? err.statusCode
          : 500;
      if (errorStatus >= 500) diagnostics.recordError(err, requestContext);
      // An unknown dispatch outcome stays fenced for recover_dispatch; report it as a conflict, not a server fault.
      if (
        ["MISSION_STATE_CHANGED", "DISPATCH_OUTCOME_UNKNOWN"].includes(err?.code) &&
        !err.hudHookFailed
      ) {
        const snapshot = broadcastSnapshot(err.code.toLowerCase()) || loadSnapshot();
        sendJson(res, 409, {
          ok: false,
          code: err.code,
          error: err.message,
          runtimeResult: err.runtimeResult,
          state: snapshot.state,
          snapshot,
        });
        return;
      }
      sendJson(res, errorStatus, {
        ok: false,
        code: err?.code || "INTERNAL_ERROR",
        error: err?.message || "Internal server error",
        runtimeResult: err?.runtimeResult,
        requestId: requestContext.requestId,
      });
    }
  });

  setupWatchers();

  let listenPromise = null;
  function ensureListening() {
    if (listenPromise) return listenPromise;
    listenPromise = new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        server.removeListener("error", onError);
        closeServer().then(
          () => reject(err),
          () => reject(err),
        );
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(api);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(port, host);
      } catch (error) {
        onError(error);
      }
    });
    return listenPromise;
  }

  async function closeServer() {
    if (closed) return;
    closed = true;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        /* Optional cleanup or data is unavailable; retain the current state. */
      }
      fsWatcher = null;
    }
    if (parentWatcher) {
      try {
        parentWatcher.close();
      } catch {
        /* Optional cleanup or data is unavailable; retain the current state. */
      }
      parentWatcher = null;
    }
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* Optional cleanup or data is unavailable; retain the current state. */
      }
    }
    sseClients.clear();
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  const api = {
    server,
    missionDir: paths.repoDir,
    dotMissionDir: paths.dotMissionDir,
    paths,
    executionHooksConfigured: true,
    dispatchAdapter: effectiveAdapter,
    runtimeAdapter: effectiveAdapter,
    get port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    get url() {
      return `http://${host}:${this.port}`;
    },
    address() {
      return server.address();
    },
    getSnapshot: loadSnapshot,
    broadcastSnapshot,
    start: () => ensureListening(),
    listen: () => ensureListening(),
    close: closeServer,
    stop: closeServer,
  };

  // Start listening immediately and allow both `await createMissionHudServer(...)`
  // and `const s = createMissionHudServer(...); await s.start();`
  const ready = ensureListening();
  api.ready = ready;

  const thenable = Object.create(api);
  Object.defineProperty(thenable, "then", {
    value(onFulfilled, onRejected) {
      return ready.then(onFulfilled, onRejected);
    },
    configurable: true,
    enumerable: false,
  });

  return thenable;
}

function parseCliArgs(argv) {
  let missionDir = process.cwd();
  let port = 4319;
  let portExplicit = false;
  let host = "127.0.0.1";
  let foreground = false;
  let notifyUrl = process.env.T3_MISSION_NOTIFY_URL || null;
  let allowLocalDaemon = process.env.T3_MISSION_LOCAL_WORKER_DAEMON === "1";
  let gitPreflightTimeoutMs = DEFAULT_GIT_PREFLIGHT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--mission-dir" || arg === "--missionDir") && argv[i + 1]) {
      missionDir = argv[++i];
    } else if (arg.startsWith("--mission-dir=")) {
      missionDir = arg.slice("--mission-dir=".length);
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
      portExplicit = true;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      portExplicit = true;
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--git-preflight-timeout-ms") {
      gitPreflightTimeoutMs = Number(argv[++i]);
    } else if (arg.startsWith("--git-preflight-timeout-ms=")) {
      gitPreflightTimeoutMs = Number(arg.slice("--git-preflight-timeout-ms=".length));
    } else if (arg === "--foreground") {
      foreground = true;
    } else if ((arg === "--notify-url" || arg === "--notifyUrl") && argv[i + 1]) {
      notifyUrl = argv[++i];
    } else if (arg.startsWith("--notify-url=")) {
      notifyUrl = arg.slice("--notify-url=".length);
    } else if (arg === "--local-worker-daemon" || arg === "--allow-local-daemon") {
      allowLocalDaemon = true;
    }
  }

  return {
    missionDir,
    port,
    portExplicit,
    host,
    foreground,
    notifyUrl,
    allowLocalDaemon,
    gitPreflightTimeoutMs: validateGitPreflightTimeout(gitPreflightTimeoutMs),
  };
}

async function runCli() {
  const {
    missionDir,
    port,
    portExplicit,
    host,
    foreground,
    notifyUrl,
    allowLocalDaemon,
    gitPreflightTimeoutMs,
  } = parseCliArgs(process.argv.slice(2));
  const paths = resolveMissionPaths(missionDir);
  fs.mkdirSync(paths.dotMissionDir, { recursive: true });

  if (!foreground) {
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2), "--foreground"], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startupLine = await new Promise((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => {
        reject(new Error(`Timed out starting HUD server: ${stderrBuf}`));
      }, 4000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        const newlineIdx = stdoutBuf.indexOf("\n");
        if (newlineIdx !== -1) {
          clearTimeout(timer);
          resolve(stdoutBuf.slice(0, newlineIdx).trim());
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk;
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.once("exit", (code) => {
        clearTimeout(timer);
        if (stdoutBuf.trim()) {
          resolve(stdoutBuf.trim().split(/\r?\n/)[0]);
        } else {
          reject(new Error(`HUD background server exited with code ${code}: ${stderrBuf}`));
        }
      });
    });

    try {
      fs.writeFileSync(path.join(paths.dotMissionDir, "hud.pid"), `${child.pid}\n`, "utf8");
    } catch {
      /* Optional cleanup or data is unavailable; retain the current state. */
    }

    process.stdout.write(`${startupLine}\n`);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return;
  }

  let srv;
  try {
    srv = await createMissionHudServer({
      missionDir,
      port,
      host,
      notifyUrl,
      allowLocalDaemon,
      gitPreflightTimeoutMs,
    });
  } catch (err) {
    if (err && err.code === "EADDRINUSE" && !portExplicit) {
      srv = await createMissionHudServer({
        missionDir,
        port: 0,
        host,
        notifyUrl,
        allowLocalDaemon,
        gitPreflightTimeoutMs,
      });
    } else {
      throw err;
    }
  }

  const info = {
    ok: true,
    url: srv.url,
    port: srv.port,
    host,
    missionDir: srv.missionDir,
    dotMissionDir: srv.dotMissionDir,
    pid: process.pid,
  };
  process.stdout.write(`${JSON.stringify(info)}\n`);

  const shutdown = async () => {
    clearInterval(dirCheckTimer);
    await srv.close();
    process.exit(0);
  };

  const dirCheckTimer = setInterval(() => {
    if (!fs.existsSync(paths.dotMissionDir)) {
      shutdown();
    }
  }, 200);
  if (typeof dirCheckTimer.unref === "function") {
    dirCheckTimer.unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function resolveRealOrAbsPath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

if (process.argv[1] && resolveRealOrAbsPath(process.argv[1]) === resolveRealOrAbsPath(__filename)) {
  runCli().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}
