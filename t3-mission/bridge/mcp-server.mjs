import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DISMISSAL_TYPES } from "../kernel/schema.mjs";
import {
  checkGitTreeBeforeResume,
  createT3Adapter,
  delegateMissionTask,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  resumeWorker,
  runFeature,
  settleCompletedMilestoneThreads
} from "./t3-adapter.mjs";

export const MISSION_TOOL_NAMES = [
  "MissionTick",
  "ReconcileBoundedTimer",
  "ProposeMission",
  "ApproveMissionPlan",
  "BindFeatureDispatch",
  "StartMissionRun",
  "DismissHandoffItems",
  "EndFeatureRun",
  "UpdateMissionFeatures",
  "CheckMissionStateBeforeResuming",
  "WaitForApproval"
];

export const MISSION_TOOLS = [
  {
    name: "ReconcileBoundedTimer",
    description: "Record original enable and current disabled receipts for one interrupted bounded timer without scheduling or dispatching work.",
    inputSchema: { type: "object", properties: {
      missionDir: { type: "string" }, requestId: { type: "string" }, enabledResponse: { type: "object" },
      disabledResponse: { type: "object" }, newWakeInstructions: { type: "string", maxLength: 4000 }
    }, required: ["missionDir", "requestId", "enabledResponse", "disabledResponse", "newWakeInstructions"] }
  },
  {
    name: "MissionTick",
    description: "Advance approved Mission state deterministically and return exactly one owner action. Submit the original T3 responses as observations; never dispatch or End outside this loop.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string" },
        timerMaxWakeups: { type: "integer", minimum: 1, maximum: 12, description: "Optional fail-stop bound, set before the first timer and persisted for the Mission." },
        timerWakeInstructions: { type: "string", maxLength: 4000, description: "Optional immutable instructions retained in the bounded timer prompt." },
        dispatchResolution: { type: "object", description: "Explicit user selection after all conflicting executions have archived terminal proof; never infer userConfirmed.", properties: {
          intentId: { type: "string" }, userConfirmed: { type: "boolean", const: true }, reason: { type: "string" },
          terminalObservationIds: { type: "array", items: { type: "string" } }, selectedTaskId: { type: "string" }, selectedChildThreadId: { type: "string" }
        }, required: ["intentId", "userConfirmed", "reason", "terminalObservationIds", "selectedTaskId", "selectedChildThreadId"] },
        observations: { type: "array", items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["owner", "timer", "timer_disabled", "dispatch", "children", "task_status", "integration", "interrupt", "resume"] },
            featureId: { type: "string" }, runId: { type: "string" },
            intentId: { type: "string" }, invocationId: { type: "string" }, taskId: { type: "string" },
            requestId: { type: "string" }, controlId: { type: "string" }, cursor: { type: ["string", "null"] },
            response: { description: "Original, unedited tool return, including MCP content or structuredContent." }
          },
          required: ["type", "response"]
        } }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "ProposeMission",
    description:
      "Propose a new Mission plan with milestones, features, validation contract assertions (VAL-*), and 3-role model settings (orchestrator, worker, validator). Requires explicit user approval before execution.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        missionId: { type: "string" },
        title: { type: "string" },
        goal: { type: "string" },
        milestones: { type: "array", items: { type: "object" } },
        features: { type: "array", items: { type: "object" } },
        assertions: { type: "array", items: { type: "object" } },
        modelSettings: { type: "object" },
        integration: { type: "object", properties: { branch: { type: "string" }, auto: { type: "boolean" } }, required: ["branch", "auto"] },
        permissions: { type: "array", items: { type: "object" } },
        ownerThreadId: { type: "string" },
        pauseMode: { type: "string", enum: ["interrupt", "let_finish"] },
        timerEveryMs: { type: "integer", minimum: 1000 },
        retryPolicy: { type: "object", properties: { baseDelayMs: { type: "integer", minimum: 1 }, maxDelayMs: { type: "integer", minimum: 1 }, maxConsecutiveProviderErrors: { type: "integer", minimum: 1 }, maxStalledDecisionRepeats: { type: "integer", minimum: 1 }, maxResultFormatRetries: { type: "integer", minimum: 0 } } },
        fallbackTargets: { type: "object", description: "Approved role map: worker/validator/orchestrator arrays of providerInstanceId, model, and exact options objects." },
        autopilot: { type: "boolean", description: "HUD records user gates only; MissionTick owns dispatch and End." }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "ApproveMissionPlan",
    description:
      "Record explicit user approval of the proposed Mission plan in the Mission HUD, unlocking StartMissionRun.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        modelSettings: { type: "object" },
        approvedBy: { type: "string" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "BindFeatureDispatch",
    description: "Record an already accepted T3 task for the exact active run without dispatching, resuming or changing paused status. The caller must verify the task receipt against T3 before binding.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string" }, featureId: { type: "string" }, runId: { type: "string" },
        taskId: { type: "string" }, childThreadId: { type: "string" }, childRunId: { type: "string" },
        worktreePath: { type: "string" }, runtimeTransport: { type: "string", enum: ["t3-delegate-task"] },
        expectedRevision: { type: "integer", minimum: 0 }, workerNumber: { type: "integer" }, clientRequestId: { type: "string" }, target: { type: "object" },
        providerInstanceId: { type: "string" }, model: { type: "string" }, options: { type: "object" }
      },
      required: ["missionDir", "featureId", "runId", "taskId", "childThreadId", "runtimeTransport", "expectedRevision"]
    }
  },
  {
    name: "StartMissionRun",
    description:
      "Start or resume the Mission execution loop. When resuming from a paused state with an activeWorker, checks the Git tree and wakes up the original childThreadId via t3_thread_send; otherwise dispatches the next pending feature via delegate_task.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        repoPath: { type: "string" },
        worktreePath: { type: "string" },
        restartFeature: { type: "boolean" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "DismissHandoffItems",
    description:
      "Dismiss or acknowledge worker handoff attention items (discovered issues or left-undone items) with explicit justifications.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        dismissals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [...DISMISSAL_TYPES]
              },
              sourceFeatureId: {
                type: "string",
                description: "Feature ID that originated the handoff item"
              },
              summary: {
                type: "string",
                description: "Summary or identifier of the handoff item being dismissed"
              },
              justification: {
                type: "string",
                minLength: 20,
                description: "Explicit justification (at least 20 characters) for dismissing this item"
              },
              itemId: {
                type: "string",
                description: "Optional legacy item identifier alias for summary"
              },
              reason: {
                type: "string",
                description: "Optional legacy alias for justification"
              }
            },
            required: ["type", "sourceFeatureId", "summary", "justification"]
          }
        }
      },
      required: ["missionDir", "dismissals"]
    }
  },
  {
    name: "EndFeatureRun",
    description:
      "Complete an active Worker or Validator run with a structured handoff, updating feature status, validation assertions, and milestone validation injection.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        runId: {
          type: "string",
          description: "Active worker runId (required to fence stale worker runs)"
        },
        featureId: {
          type: "string",
          description: "Feature ID being completed by the active worker"
        },
        successState: { type: "string", enum: ["success", "failure", "partial"] },
        validatorsPassed: { type: "boolean" },
        returnToOrchestrator: { type: "boolean" },
        assertionResults: { type: "object" },
        handoff: { type: "object" }
      },
      required: ["missionDir", "runId", "featureId", "handoff"]
    }
  },
  {
    name: "UpdateMissionFeatures",
    description:
      "Add, update, or reorder features, milestones, validation assertions, modelSettings, or bonusAttempts in .mission/features.json and .mission/state.json.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        features: { type: "array", items: { type: "object" } },
        addFeatures: { type: "array", items: { type: "object" } },
        updateFeatures: { type: "array", items: { type: "object" } },
        updateAssertions: { type: "array", items: { type: "object" } },
        modelSettings: { type: "object" },
        bonusAttempts: { type: "object" },
        milestones: { type: "array", items: { type: "object" } },
        assertions: { type: "array", items: { type: "object" } }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "CheckMissionStateBeforeResuming",
    description:
      "Inspect .mission/state.json and check the Git working tree before resuming an interrupted or paused Mission.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        repoPath: { type: "string" },
        worktreePath: { type: "string" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "WaitForApproval",
    description:
      "Block and poll .mission/state.json and .mission/progress_log.jsonl until the user approves or rejects the proposed Mission plan in the HUD.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default 600000)" },
        pollMs: { type: "number", description: "Polling interval in milliseconds (default 200)" }
      },
      required: ["missionDir"]
    }
  }
];

for (const tool of MISSION_TOOLS) tool.inputSchema.properties.commandId = { type: 'string', description: 'Stable caller command identity. Reusing it with a different payload is refused.' };

const TOOL_CAMEL_MAP = {
  MissionTick: "missionTick",
  ReconcileBoundedTimer: "reconcileBoundedTimer",
  ProposeMission: "proposeMission",
  ApproveMissionPlan: "approveMissionPlan",
  StartMissionRun: "startMissionRun",
  BindFeatureDispatch: "bindFeatureDispatch",
  DismissHandoffItems: "dismissHandoffItems",
  EndFeatureRun: "endFeatureRun",
  UpdateMissionFeatures: "updateMissionFeatures",
  CheckMissionStateBeforeResuming: "checkMissionStateBeforeResuming",
  WaitForApproval: "waitForApproval"
};

const CANONICAL_TOOL_BY_LOWER = new Map();
for (const name of MISSION_TOOL_NAMES) {
  CANONICAL_TOOL_BY_LOWER.set(name.toLowerCase(), name);
  const camel = TOOL_CAMEL_MAP[name];
  CANONICAL_TOOL_BY_LOWER.set(camel.toLowerCase(), name);
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  CANONICAL_TOOL_BY_LOWER.set(kebab, name);
}
CANONICAL_TOOL_BY_LOWER.set("waitforhuddecision", "WaitForApproval");
CANONICAL_TOOL_BY_LOWER.set("wait-for-hud-decision", "WaitForApproval");

/**
 * Resolve any tool alias (`ProposeMission`, `proposeMission`, `propose-mission`) to its canonical tool name.
 *
 * @param {string} rawName
 * @returns {string | null}
 */
export function resolveCanonicalToolName(rawName) {
  if (!rawName || typeof rawName !== "string") {
    return null;
  }
  return CANONICAL_TOOL_BY_LOWER.get(rawName.trim().toLowerCase()) ?? null;
}

/**
 * Resolve `.mission` storage directory for fallback persistence when `../kernel/index.mjs` is not yet merged.
 *
 * @param {string} missionDir
 */
function resolveFallbackBaseDir(missionDir) {
  const abs = path.resolve(String(missionDir || process.cwd()));
  if (path.basename(abs) === ".mission") {
    return abs;
  }
  const dotMission = path.join(abs, ".mission");
  if (fs.existsSync(dotMission)) {
    return dotMission;
  }
  if (
    fs.existsSync(path.join(abs, "state.json")) ||
    fs.existsSync(path.join(abs, "features.json")) ||
    fs.existsSync(path.join(abs, "model-settings.json"))
  ) {
    return abs;
  }
  return dotMission;
}

function readJsonFileSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Normalize legacy dismissal item aliases (`reason` -> `justification`, `itemId` -> `summary`)
 * at the Bridge boundary while preserving strict Kernel validation.
 *
 * @param {unknown[]} dismissals
 */
export function normalizeDismissalPayloadItems(dismissals) {
  if (!Array.isArray(dismissals)) {
    return dismissals;
  }
  return dismissals.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const normalized = { ...item };
    if (!normalized.justification && normalized.reason) {
      normalized.justification = normalized.reason;
    }
    if (!normalized.summary && normalized.itemId) {
      normalized.summary = normalized.itemId;
    }
    return normalized;
  });
}

function loadStateFromKernelOrDisk(missionDir, kernel) {
  if (typeof kernel?.tryLoadState !== 'function') throw kernelUnavailable(new Error('Consistent Mission reader is unavailable'));
  return kernel.tryLoadState(missionDir);
}

/** Preserve raw transport evidence; the real kernel owns receipt and lifecycle persistence. */
export function createBridgeDispatchAdapter(missionDir, baseAdapter = {}, kernel = undefined) {
  return baseAdapter;
}

function kernelUnavailable(cause) {
  const error = new Error("The real Mission kernel is unavailable; lifecycle writes are disabled", { cause });
  error.code = "KERNEL_UNAVAILABLE";
  return error;
}

/** Compatibility sentinel: no fallback lifecycle implementation or writes. */
export function createFallbackKernel(cause) {
  const unavailable = () => { throw kernelUnavailable(cause); };
  return {
    __isFallbackKernel: true,
    __kernelUnavailable: true,
    cause,
    tryLoadState: unavailable,
    ...Object.fromEntries(Object.values(TOOL_CAMEL_MAP).map((name) => [name, unavailable])),
  };
}

/**
 * Dynamically import the real kernel; an import failure disables lifecycle tools.
 *
 * @param {Record<string, unknown>} [options={}]
 */
export async function resolveMissionKernel(options = {}) {
  if (options.kernel && typeof options.kernel === "object") {
    return options.kernel;
  }
  try {
    const kernelUrl = new URL("../kernel/index.mjs", import.meta.url);
    if (fs.existsSync(fileURLToPath(kernelUrl))) {
      return await import(kernelUrl.href);
    }
  } catch (error) {
    return createFallbackKernel(error);
  }
  return createFallbackKernel(new Error("Missing ../kernel/index.mjs"));
}

/**
 * Helper to call a function on either the real kernel (`(missionDir, payload, adapter)`)
 * or a mock kernel (`(payload)` or `(missionDir, payload)`).
 */
async function invokeKernelFunction(kernel, fn, missionDir, payload, extraArg) {
  const isStandardKernel =
    Boolean(kernel.__isFallbackKernel) ||
    typeof kernel.resolveMissionBaseDir === "function";

  if (isStandardKernel) {
    return await fn.call(kernel, missionDir, payload, extraArg);
  }

  // Inspect parameter signature for mock kernels (function, shorthand method, or arrow function)
  const fnSource = Function.prototype.toString.call(fn).trim();
  const paramMatch = fnSource.match(
    /^(?:async\s+)?(?:function\s*[^(]*\(([^)]*)\)|[A-Za-z0-9_$]+\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z0-9_$]+)\s*=>)/
  );
  const rawParams = (
    paramMatch?.[1] ??
    paramMatch?.[2] ??
    paramMatch?.[3] ??
    paramMatch?.[4] ??
    ""
  ).trim();
  const paramList = rawParams
    ? rawParams.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  const firstParam = paramList[0] || "";
  const expectsMissionDirFirst =
    /^_?(missionDir|dir|baseDir|projectDir)\b/i.test(firstParam) ||
    (paramList.length >= 2 && !firstParam.startsWith("{") && !/^(args|input|payload|params|opts|options)\b/i.test(firstParam));

  if (expectsMissionDirFirst) {
    return await fn.call(kernel, missionDir, payload, extraArg);
  }
  return await fn.call(kernel, payload, missionDir, extraArg);
}

/**
 * Execute one of the 7 Mission tools (`VAL-BRIDGE-003`).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} [rawArgs={}]
 * @param {Record<string, unknown>} [context={}]
 */
export async function callMissionTool(toolName, rawArgs = {}, context = {}) {
  const canonicalName = resolveCanonicalToolName(toolName);
  if (!canonicalName) {
    const err = new Error(`Unknown mission tool: "${toolName}"`);
    /** @type {any} */ (err).code = -32601;
    throw err;
  }

  const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
  const missionDir = String(
    args.missionDir ?? context.missionDir ?? process.cwd()
  ).trim();
  args.missionDir = missionDir;

  if (canonicalName === "EndFeatureRun") {
    const hasFeatureId = typeof args.featureId === "string" && args.featureId.trim().length > 0;
    const hasRunId = typeof args.runId === "string" && args.runId.trim().length > 0;
    if (!hasFeatureId || !hasRunId) {
      const err = new Error(
        "MISSING_RUN_IDENTITY: EndFeatureRun requires both runId and featureId to fence worker completion"
      );
      /** @type {any} */ (err).code = "MISSING_RUN_IDENTITY";
      throw err;
    }
  }

  if (canonicalName === "DismissHandoffItems" && Array.isArray(args.dismissals)) {
    args.dismissals = normalizeDismissalPayloadItems(args.dismissals);
  }

  const kernel = await resolveMissionKernel(context);
  if (kernel.__kernelUnavailable) throw kernelUnavailable(kernel.cause);
  const adapter =
    context.adapter ??
    createT3Adapter({
      env: context.env ?? process.env,
      transportClient: context.transportClient,
      execFileImpl: context.execFileImpl
    });

  if (canonicalName === "WaitForApproval") {
    const customFn =
      kernel.WaitForApproval ??
      kernel.waitForApproval ??
      kernel.WaitForHudDecision ??
      kernel.waitForHudDecision;
    if (typeof customFn === "function") {
      return await invokeKernelFunction(kernel, customFn, missionDir, args, adapter);
    }

    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs >= 0
        ? args.timeoutMs
        : 600000;
    const pollMs =
      typeof args.pollMs === "number" && Number.isFinite(args.pollMs) && args.pollMs > 0
        ? Math.max(5, args.pollMs)
        : 200;

    const approvalSnapshot = () => {
      if (typeof kernel.readMissionSnapshot === 'function') return kernel.readMissionSnapshot(missionDir);
      if (typeof kernel.readProgressLog !== 'function') throw kernelUnavailable(new Error('Consistent approval snapshot is unavailable'));
      return { state: loadStateFromKernelOrDisk(missionDir, kernel), progressLog: kernel.readProgressLog(missionDir) };
    };
    const initial = approvalSnapshot();
    const initialState = initial.state;
    const initialLogs = initial.progressLog;
    const baselineRejectionRevision = initialState?.rejectionRevision;
    const baselineRejectedAt = initialState?.lastPlanRejectedAt;
    const baselineRejectedCount = initialLogs.filter(
      (e) => e && e.type === "plan_rejected"
    ).length;
    const baselineLastRejectedSeq = initialLogs
      .filter((e) => e && e.type === "plan_rejected")
      .reduce((max, e) => (typeof e.seq === "number" && e.seq > max ? e.seq : max), 0);

    const startTime = Date.now();
    while (true) {
      const current = approvalSnapshot();
      const currentState = current.state;
      const currentLogs = current.progressLog;

      if (currentState && currentState.planAccepted === true) {
        return {
          ok: true,
          event: "plan_approved",
          planAccepted: true,
          dispatchPending: Boolean(currentState.activeWorker?.dispatchPending),
          activeWorker: currentState.activeWorker ?? null,
          state: currentState
        };
      }

      const rejectedLogs = currentLogs.filter((e) => e && e.type === "plan_rejected");
      const latestRejected = rejectedLogs.at(-1);
      const latestRejectedSeq =
        typeof latestRejected?.seq === "number" ? latestRejected.seq : 0;
      const hasNewRejectionLog =
        rejectedLogs.length > baselineRejectedCount ||
        latestRejectedSeq > baselineLastRejectedSeq;
      const hasNewRejectionState = Boolean(
        currentState &&
          currentState.status === "planning" &&
          currentState.planAccepted === false &&
          ((currentState.rejectionRevision !== undefined &&
            currentState.rejectionRevision !== baselineRejectionRevision) ||
            (currentState.lastPlanRejectedAt !== undefined &&
              currentState.lastPlanRejectedAt !== baselineRejectedAt))
      );

      if (hasNewRejectionLog || hasNewRejectionState) {
        const feedbackFromLog =
          latestRejected?.details?.feedback ??
          (typeof latestRejected?.message === "string" &&
          latestRejected.message.startsWith("Mission plan rejected:")
            ? latestRejected.message.slice("Mission plan rejected:".length).trim()
            : null);
        return {
          ok: true,
          event: "plan_rejected",
          planAccepted: false,
          feedback: currentState?.lastPlanFeedback ?? feedbackFromLog ?? null,
          state: currentState
        };
      }

      if (Date.now() - startTime >= timeoutMs) {
        return {
          ok: false,
          timedOut: true,
          event: "timeout",
          state: currentState
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  if (canonicalName === "CheckMissionStateBeforeResuming") {
    const customFn =
      kernel.CheckMissionStateBeforeResuming ??
      kernel.checkMissionStateBeforeResuming;

    let missionState = null;
    if (typeof customFn === "function") {
      const customResult = await invokeKernelFunction(kernel, customFn, missionDir, args, adapter);
      if (customResult && typeof customResult === "object" && customResult.gitCheck) {
        return customResult;
      }
      missionState = customResult?.state ?? customResult;
    } else if (typeof kernel.reconcileMissionOnLoad === "function") {
      missionState =
        args.reconcile === false && typeof kernel.tryLoadState === "function"
          ? kernel.tryLoadState(missionDir)
          : kernel.reconcileMissionOnLoad(missionDir);
    } else if (typeof kernel.tryLoadState === "function") {
      missionState = kernel.tryLoadState(missionDir);
    } else {
      missionState = createFallbackKernel().tryLoadState(missionDir);
    }

    const activeWorker = missionState?.activeWorker ?? null;
    const targetTreePath =
      args.worktreePath ??
      activeWorker?.worktreePath ??
      args.repoPath ??
      missionState?.worktreePath ??
      missionState?.repoPath ??
      missionDir;

    const gitCheck = await adapter.checkGitTreeBeforeResume(String(targetTreePath), {
      featureId: activeWorker?.featureId ?? missionState?.currentFeatureId ?? null,
      workerTitle: activeWorker?.featureTitle ?? activeWorker?.title ?? null
    });

    const hasInterruptedWorker = Boolean(
      activeWorker &&
        (missionState?.status === "paused" ||
          activeWorker.status === "paused" ||
          activeWorker.status === "running")
    );
    const childThreadId = activeWorker?.childThreadId ?? activeWorker?.threadId ?? null;

    return {
      ok: true,
      tool: "CheckMissionStateBeforeResuming",
      missionDir,
      status: missionState?.status ?? "not_found",
      state: missionState,
      activeWorker,
      hasInterruptedWorker,
      shouldResumeExistingThread: Boolean(hasInterruptedWorker && childThreadId),
      childThreadId,
      canResume: Boolean(gitCheck.canResume),
      gitCheck,
      summary: gitCheck.summary
    };
  }

  const camelName = TOOL_CAMEL_MAP[canonicalName];
  const fn = kernel[canonicalName] ?? kernel[camelName];
  if (typeof fn !== "function") {
    throw kernelUnavailable(new Error(`Kernel does not implement tool "${canonicalName}"`));
  }

  if (canonicalName === "StartMissionRun") {
    const hasLiveT3Transport = Boolean(
      args.dispatchAdapter ||
        context.dispatchAdapter ||
        context.adapter ||
        context.transportClient ||
        context.kernel ||
        (context.env ?? process.env)?.T3_ACP_MCP_NODE
    );
    const rawDispatchAdapter =
      args.dispatchAdapter ??
      context.dispatchAdapter ??
      (hasLiveT3Transport ? adapter : {});
    const dispatchAdapter = createBridgeDispatchAdapter(missionDir, rawDispatchAdapter, kernel);
    const result = await invokeKernelFunction(kernel, fn, missionDir, args, dispatchAdapter);

    return result;
  }

  if (canonicalName === "UpdateMissionFeatures") {
    return await invokeKernelFunction(kernel, fn, missionDir, args, adapter);
  }

  return await invokeKernelFunction(kernel, fn, missionDir, args, adapter);
}

/**
 * Handle a single JSON-RPC 2.0 request or notification object (`VAL-BRIDGE-003`).
 *
 * @param {Record<string, unknown>} message
 * @param {Record<string, unknown>} [context={}]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function handleJsonRpcMessage(message, context = {}) {
  if (!message || typeof message !== "object") {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request"
      }
    };
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  try {
    if (method === "notifications/initialized" || method === "initialized") {
      return null;
    }

    if (method === "initialize") {
      const protocolVersion =
        params && typeof params === "object" && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05";
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: "t3-mission-mcp-server",
            version: "1.0.0"
          }
        }
      };
    }

    if (method === "ping") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {}
      };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          tools: MISSION_TOOLS
        }
      };
    }

    if (method === "tools/call") {
      const rawToolName = params && typeof params === "object" ? params.name : undefined;
      const rawToolArgs =
        params && typeof params === "object" && params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {};

      const canonical = resolveCanonicalToolName(String(rawToolName || ""));
      if (!canonical) {
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: {
            code: -32602,
            message: `Unknown tool: ${String(rawToolName || "")}`
          }
        };
      }

      const toolResult = await callMissionTool(canonical, rawToolArgs, context);
      const serialized = JSON.stringify(toolResult);
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: serialized
            }
          ],
          structuredContent: toolResult,
          isError: false
        }
      };
    }

    if (isNotification) {
      return null;
    }

    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32601,
        message: `Method not found: ${String(method)}`
      }
    };
  } catch (error) {
    if (isNotification) {
      return null;
    }
    const errMessage = error instanceof Error ? error.message : String(error);
    const errCode =
      error && typeof error === "object" && typeof /** @type {any} */ (error).code === "number"
        ? /** @type {any} */ (error).code
        : -32000;

    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: errCode,
        message: errMessage,
        data:
          error && typeof error === "object" && "code" in error
            ? { kernelCode: /** @type {any} */ (error).code }
            : undefined
      }
    };
  }
}

/**
 * Create an in-memory or stream-attachable Mission MCP Server instance.
 *
 * @param {Record<string, unknown>} [context={}]
 */
export function createMissionMcpServer(context = {}) {
  return {
    tools: MISSION_TOOLS,
    toolNames: MISSION_TOOL_NAMES,
    callTool: (name, args, overrideContext) =>
      callMissionTool(name, args, { ...context, ...(overrideContext || {}) }),
    handleRequest: (message, overrideContext) =>
      handleJsonRpcMessage(message, { ...context, ...(overrideContext || {}) }),
    handleJsonRpcMessage: (message, overrideContext) =>
      handleJsonRpcMessage(message, { ...context, ...(overrideContext || {}) }),
    startStdio: (stdioOptions = {}) =>
      startStdioMcpServer({ ...context, ...stdioOptions })
  };
}

/**
 * Start the JSON-RPC 2.0 MCP Server over `stdin` / `stdout` (NDJSON lines).
 *
 * @param {Record<string, unknown>} [options={}]
 */
export function startStdioMcpServer(options = {}) {
  const input = /** @type {NodeJS.ReadableStream} */ (options.input ?? process.stdin);
  const output = /** @type {NodeJS.WritableStream} */ (options.output ?? process.stdout);

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false
  });

  const pending = new Set();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || /^Content-Length:/i.test(trimmed)) {
      return;
    }

    const task = (async () => {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const parseErr = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        };
        output.write(`${JSON.stringify(parseErr)}\n`);
        return;
      }

      if (Array.isArray(parsed)) {
        const responses = [];
        for (const item of parsed) {
          const res = await handleJsonRpcMessage(item, options);
          if (res !== null) {
            responses.push(res);
          }
        }
        if (responses.length > 0) {
          output.write(`${JSON.stringify(responses)}\n`);
        }
        return;
      }

      const response = await handleJsonRpcMessage(parsed, options);
      if (response !== null) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  return {
    close: async () => {
      rl.close();
      await Promise.allSettled([...pending]);
    }
  };
}

function resolveRealOrAbs(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isExecutedAsMain(metaUrl, argv1 = process.argv[1]) {
  return Boolean(
    argv1 && resolveRealOrAbs(argv1) === resolveRealOrAbs(fileURLToPath(metaUrl))
  );
}

const isMainModule = isExecutedAsMain(import.meta.url);

if (isMainModule) {
  startStdioMcpServer();
}

export default {
  MISSION_TOOL_NAMES,
  MISSION_TOOLS,
  resolveCanonicalToolName,
  resolveMissionKernel,
  normalizeDismissalPayloadItems,
  createBridgeDispatchAdapter,
  callMissionTool,
  handleJsonRpcMessage,
  createMissionMcpServer,
  startStdioMcpServer,
  isExecutedAsMain,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  delegateMissionTask,
  runFeature,
  checkGitTreeBeforeResume,
  resumeWorker,
  settleCompletedMilestoneThreads
};
