import crypto from "node:crypto";

export const MISSION_STATUSES = [
  "planning",
  "initializing",
  "awaiting_input",
  "running",
  "orchestrator_turn",
  "paused",
  "completed",
];

export const FEATURE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export const FEATURE_KINDS = [
  "implementation",
  "scrutiny",
  "user_testing",
  "repair",
  "explorer",
];

export const DISMISSAL_TYPES = [
  "discovered_issue",
  "critical_context",
  "incomplete_work",
  "non_interactive_check",
  "validator_failure",
];

export const ASSERTION_STATUSES = ["pending", "passed", "failed"];

export const EFFORT_LEVEL_TO_REASONING = {
  1: "minimal",
  2: "low",
  3: "medium",
  4: "high",
  5: "max",
};

export const REASONING_TO_EFFORT_LEVEL = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5,
};

export const DEFAULT_MODEL_SETTINGS = {
  orchestrator: {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {},
  },
  worker: {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {},
  },
  validator: {
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    options: { reasoningEffort: "high" },
  },
  skipScrutiny: false,
  skipUserTesting: false,
};

export class MissionKernelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MissionKernelError";
    this.code = code;
    this.details = details;
    if (details && typeof details === "object" && details.reasonCode) {
      this.reasonCode = details.reasonCode;
    } else if (code === "PLAN_ACCEPTANCE_REQUIRED") {
      this.reasonCode = "PLAN_NOT_ACCEPTED";
    } else if (code === "HANDOFF_ATTENTION_REQUIRED") {
      this.reasonCode = "HANDOFF_GATE_BLOCKED";
    }
  }
}

export function createMissionId() {
  return `mission-${crypto.randomUUID().slice(0, 8)}`;
}

export function createRunId() {
  return `run-${crypto.randomUUID().slice(0, 8)}`;
}

function parseEffortLevel(rawEffort) {
  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    return Math.max(1, Math.min(5, Math.round(rawEffort)));
  }
  if (typeof rawEffort === "string" && rawEffort.trim()) {
    const trimmed = rawEffort.trim().toLowerCase();
    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 1 && num <= 5) {
      return Math.round(num);
    }
    if (REASONING_TO_EFFORT_LEVEL[trimmed]) {
      return REASONING_TO_EFFORT_LEVEL[trimmed];
    }
  }
  return null;
}

function doesSlotSupportEffort(providerInstanceId, model, safeRaw = {}, safeBase = {}) {
  if (safeRaw.supportsEffort === false) return false;
  if (safeRaw.supportsEffort === true) return true;
  if (
    safeRaw.supportsEffort === undefined &&
    safeBase.supportsEffort === false &&
    (!safeRaw.model || safeRaw.model === safeBase.model)
  ) {
    return false;
  }
  if (String(providerInstanceId || "").trim().toLowerCase() === "antigravity") {
    return false;
  }
  if (/-(low|medium|high)$/i.test(String(model || "").trim())) {
    return false;
  }
  return true;
}

export function doesProviderDeclareEffortOption(providerInstanceId) {
  const norm = String(providerInstanceId || "").trim().toLowerCase();
  return (
    norm === "claudeagent" ||
    norm === "claude-code" ||
    norm === "claude-agent-acp" ||
    norm === "acpregistry_cursor"
  );
}

const KNOWN_MODEL_TO_PROVIDER = {
  "claude-opus-5-5": "claudeAgent",
  "claude-opus-4-6": "claudeAgent",
  "claude-sonnet-4-5": "claudeAgent",
  "gemini-4-argon-high": "antigravity",
  "gpt-6.1-sol": "codex",
  "gpt-5.4": "codex",
  "swe-2-max": "cpa",
  "grok-4.7": "cpa",
  "gpt-6-astra-high": "openai",
};

export function inferProviderForModel(modelId, fallbackProvider = null) {
  const key = String(modelId || "").trim().toLowerCase();
  if (KNOWN_MODEL_TO_PROVIDER[key]) {
    return KNOWN_MODEL_TO_PROVIDER[key];
  }
  if (/^claude/i.test(key)) {
    return /-(low|medium|high)$/i.test(key) ? "antigravity" : "claudeAgent";
  }
  if (/^gemini/i.test(key)) return "antigravity";
  if (/^grok/i.test(key)) return fallbackProvider === "cpa" ? "cpa" : "grok";
  if (/^swe-/i.test(key)) return "cpa";
  if (/^gpt-6-astra/i.test(key)) return "openai";
  if (/^gpt-/i.test(key)) return "codex";
  return fallbackProvider;
}

const FEATURE_SLOT_FIELDS = ["model", "providerInstanceId", "effort", "reasoningEffort", "options"];

export function normalizeSparseSlotOverride(raw) {
  if (typeof raw === "string") return { model: raw.trim() };
  if (!raw || typeof raw !== "object") return {};
  return {
    ...raw,
    ...(raw.options && typeof raw.options === "object"
      ? { options: { ...raw.options } }
      : {}),
  };
}

export function getFeatureSlotOverride(feature = {}) {
  const nested = feature.target ?? feature.workerTarget ?? feature.slotConfig;
  if (nested !== undefined && nested !== null) return normalizeSparseSlotOverride(nested);
  const entries = FEATURE_SLOT_FIELDS
    .filter((key) => Object.hasOwn(feature, key) && feature[key] !== undefined)
    .map((key) => [key, feature[key]]);
  return entries.length ? normalizeSparseSlotOverride(Object.fromEntries(entries)) : null;
}

export function isDispatchRejected(result) {
  return [result, result?.response].some((value) =>
    value && typeof value === "object" &&
    (value.ok === false || value.accepted === false || value.started === false ||
      value.canStart === false || value.blocked === true ||
      (value.dispatched === false && value.dispatchPending !== true))
  );
}

export function normalizeSlotConfig(raw = {}, base = {}) {
  const safeRaw =
    typeof raw === "string" && raw.trim()
      ? { model: raw.trim() }
      : raw && typeof raw === "object"
        ? raw
        : {};
  const safeBase = base && typeof base === "object" ? base : {};

  const model = safeRaw.model ?? safeBase.model ?? "gemini-4-argon-high";
  const inferredProvider =
    safeRaw.model && safeRaw.model !== safeBase.model && !safeRaw.providerInstanceId
      ? inferProviderForModel(safeRaw.model, safeBase.providerInstanceId)
      : null;
  const providerInstanceId =
    safeRaw.providerInstanceId ??
    inferredProvider ??
    safeBase.providerInstanceId ??
    inferProviderForModel(model, "antigravity") ??
    "antigravity";

  const baseOptions =
    safeBase.options && typeof safeBase.options === "object"
      ? { ...safeBase.options }
      : {};
  const rawOptions =
    safeRaw.options && typeof safeRaw.options === "object"
      ? { ...safeRaw.options }
      : {};

  const options = {
    ...baseOptions,
    ...rawOptions,
  };

  if (!doesSlotSupportEffort(providerInstanceId, model, safeRaw, safeBase)) {
    delete options.effort;
    delete options.reasoningEffort;
    delete options.reasoning_effort;
    delete options.thinking;
    return {
      providerInstanceId,
      model,
      options,
    };
  }

  const rawEffortVal = safeRaw.effort ?? rawOptions.effort;
  const rawReasoningVal =
    safeRaw.reasoningEffort ?? rawOptions.reasoningEffort;

  let resolvedEffort =
    parseEffortLevel(safeBase.effort ?? baseOptions.effort) ??
    (safeBase.reasoningEffort || baseOptions.reasoningEffort
      ? REASONING_TO_EFFORT_LEVEL[
          String(safeBase.reasoningEffort || baseOptions.reasoningEffort)
            .trim()
            .toLowerCase()
        ] ?? null
      : null) ?? 4;
  let resolvedReasoning =
    typeof (safeBase.reasoningEffort ?? baseOptions.reasoningEffort) === "string"
      ? String(safeBase.reasoningEffort ?? baseOptions.reasoningEffort)
          .trim()
          .toLowerCase()
      : resolvedEffort !== null
        ? EFFORT_LEVEL_TO_REASONING[resolvedEffort]
        : null;

  const parsedLevel = parseEffortLevel(rawEffortVal);
  if (parsedLevel !== null) {
    const mappedReasoning = EFFORT_LEVEL_TO_REASONING[parsedLevel];
    const normRawReasoning =
      typeof rawReasoningVal === "string" && rawReasoningVal.trim()
        ? rawReasoningVal.trim().toLowerCase()
        : null;
    const rawReasoningLevel = normRawReasoning
      ? REASONING_TO_EFFORT_LEVEL[normRawReasoning] ?? null
      : null;

    resolvedEffort = parsedLevel;
    if (normRawReasoning && rawReasoningLevel === parsedLevel) {
      resolvedReasoning = normRawReasoning;
    } else {
      resolvedReasoning = mappedReasoning;
    }
  } else if (
    typeof rawReasoningVal === "string" &&
    rawReasoningVal.trim() !== ""
  ) {
    const normRawReasoning = rawReasoningVal.trim().toLowerCase();
    resolvedReasoning = normRawReasoning;
    if (REASONING_TO_EFFORT_LEVEL[normRawReasoning]) {
      resolvedEffort = REASONING_TO_EFFORT_LEVEL[normRawReasoning];
    }
  }

  if (resolvedReasoning) {
    options.reasoningEffort = resolvedReasoning;
  }
  if (doesProviderDeclareEffortOption(providerInstanceId)) {
    if (resolvedEffort !== null) {
      options.effort = resolvedEffort;
    }
  } else {
    delete options.effort;
  }

  const result = {
    providerInstanceId,
    model,
    options,
  };
  if (resolvedEffort !== null) {
    result.effort = resolvedEffort;
  }
  if (resolvedReasoning) {
    result.reasoningEffort = resolvedReasoning;
  }
  return result;
}

export function normalizeModelSettings(
  partial = {},
  base = DEFAULT_MODEL_SETTINGS
) {
  const source =
    partial?.slots && typeof partial.slots === "object"
      ? { ...partial, ...partial.slots }
      : partial || {};
  const baseSource =
    base?.slots && typeof base.slots === "object"
      ? { ...base, ...base.slots }
      : base || DEFAULT_MODEL_SETTINGS;

  const rawModified = Array.isArray(source.userModifiedSlots)
    ? source.userModifiedSlots
    : Array.isArray(baseSource.userModifiedSlots)
      ? baseSource.userModifiedSlots
      : null;

  const normalized = {
    orchestrator: normalizeSlotConfig(
      source.orchestrator,
      baseSource.orchestrator || DEFAULT_MODEL_SETTINGS.orchestrator
    ),
    worker: normalizeSlotConfig(
      source.worker,
      baseSource.worker || DEFAULT_MODEL_SETTINGS.worker
    ),
    validator: normalizeSlotConfig(
      source.validator,
      baseSource.validator || DEFAULT_MODEL_SETTINGS.validator
    ),
    skipScrutiny:
      typeof source.skipScrutiny === "boolean"
        ? source.skipScrutiny
        : Boolean(baseSource.skipScrutiny),
    skipUserTesting:
      typeof source.skipUserTesting === "boolean"
        ? source.skipUserTesting
        : Boolean(baseSource.skipUserTesting),
  };

  if (rawModified && rawModified.length > 0) {
    normalized.userModifiedSlots = Array.from(
      new Set(rawModified.map((s) => String(s).trim()).filter(Boolean))
    );
  }
  return normalized;
}

export function normalizeMilestone(milestone, index = 0) {
  if (!milestone || typeof milestone !== "object") {
    throw new MissionKernelError(
      "INVALID_MILESTONE",
      `Invalid milestone at index ${index}`
    );
  }
  const id = String(milestone.id || `m${index + 1}`).trim();
  const title = String(milestone.title || `Milestone ${index + 1}`).trim();
  const ordinal =
    typeof milestone.ordinal === "number" ? milestone.ordinal : index + 1;
  return {
    ...milestone,
    id,
    title,
    ordinal,
  };
}

export function inferFeatureKind(feature) {
  if (feature.kind === "user-testing") {
    return "user_testing";
  }
  if (feature.kind && FEATURE_KINDS.includes(feature.kind)) {
    return feature.kind;
  }
  const skill = String(feature.skillName || "").toLowerCase();
  const id = String(feature.id || "").toLowerCase();
  if (skill.includes("scrutiny") || id.startsWith("scrutiny-validator")) {
    return "scrutiny";
  }
  if (
    skill.includes("user-testing") ||
    skill.includes("user_testing") ||
    id.startsWith("user-testing-validator")
  ) {
    return "user_testing";
  }
  if (skill.includes("repair")) {
    return "repair";
  }
  if (skill.includes("explorer") || id.startsWith("explorer-")) {
    return "explorer";
  }
  return "implementation";
}

export function normalizeFeature(feature, index = 0) {
  if (!feature || typeof feature !== "object") {
    throw new MissionKernelError(
      "INVALID_FEATURE",
      `Invalid feature at index ${index}`
    );
  }
  const id = String(feature.id || `f${index + 1}`).trim();
  const milestoneId = String(feature.milestoneId || "m1").trim();
  const title = String(feature.title || id).trim();
  const description = String(feature.description || "").trim();
  const kind = inferFeatureKind(feature);
  let defaultSkill = "worker-implementation";
  if (kind === "scrutiny") {
    defaultSkill = `scrutiny-validator-${milestoneId}`;
  } else if (kind === "user_testing") {
    defaultSkill = `user-testing-validator-${milestoneId}`;
  }
  const skillName = String(feature.skillName || defaultSkill).trim();
  const fulfills = Array.isArray(feature.fulfills)
    ? feature.fulfills.map((x) => String(x))
    : [];
  const status = FEATURE_STATUSES.includes(feature.status)
    ? feature.status
    : "pending";
  const attempts =
    typeof feature.attempts === "number" && feature.attempts >= 0
      ? feature.attempts
      : 0;
  const maxAttempts =
    typeof feature.maxAttempts === "number" && feature.maxAttempts > 0
      ? feature.maxAttempts
      : 5;
  const lastHandoff = feature.lastHandoff ?? null;

  const normalizedOverride = getFeatureSlotOverride(feature);

  const normalizedFeature = {
    ...feature,
    id,
    milestoneId,
    title,
    description,
    kind,
    skillName,
    fulfills,
    status,
    attempts,
    maxAttempts,
    lastHandoff,
  };

  for (const key of ["target", "workerTarget", "slotConfig"]) {
    if (feature[key] !== undefined && feature[key] !== null) {
      normalizedFeature[key] = normalizeSparseSlotOverride(feature[key]);
    }
  }
  if (normalizedOverride && feature.target == null && feature.workerTarget == null && feature.slotConfig == null) {
    normalizedFeature.target = normalizedOverride;
  }

  return normalizedFeature;
}

export function normalizeAssertion(assertion, index = 0) {
  if (!assertion || typeof assertion !== "object") {
    throw new MissionKernelError(
      "INVALID_ASSERTION",
      `Invalid assertion at index ${index}`
    );
  }
  const id = String(
    assertion.id || `VAL-${String(index + 1).padStart(3, "0")}`
  ).trim();
  const description = String(assertion.description || "").trim();
  const milestoneId = String(assertion.milestoneId || "m1").trim();
  const status = ASSERTION_STATUSES.includes(assertion.status)
    ? assertion.status
    : "pending";
  const stageResults =
    assertion.stageResults && typeof assertion.stageResults === "object"
      ? { ...assertion.stageResults }
      : undefined;

  return {
    ...assertion,
    id,
    description,
    milestoneId,
    status,
    ...(stageResults ? { stageResults } : {}),
  };
}

export function createInitialState(input = {}, existingState = null) {
  const isUninitializedPlaceholder = Boolean(
    !existingState ||
      existingState.initialized === false ||
      existingState.missionId === "mission-uninitialized"
  );
  const validInputMissionId =
    typeof input.missionId === "string" &&
    input.missionId.trim() &&
    input.missionId.trim() !== "mission-uninitialized"
      ? input.missionId.trim()
      : null;
  const validExistingMissionId =
    !isUninitializedPlaceholder &&
    typeof existingState?.missionId === "string" &&
    existingState.missionId.trim() &&
    existingState.missionId.trim() !== "mission-uninitialized"
      ? existingState.missionId.trim()
      : null;
  const validExistingTitle =
    !isUninitializedPlaceholder &&
    typeof existingState?.title === "string" &&
    existingState.title.trim() &&
    existingState.title.trim() !== "Waiting for Mission Initialization"
      ? existingState.title.trim()
      : null;

  const milestones = Array.isArray(input.milestones)
    ? input.milestones.map((m, i) => normalizeMilestone(m, i))
    : existingState?.milestones ?? [];
  const assertions = Array.isArray(input.assertions)
    ? input.assertions.map((a, i) => normalizeAssertion(a, i))
    : existingState?.assertions ?? [];

  return {
    initialized: true,
    missionId: validInputMissionId || validExistingMissionId || createMissionId(),
    title: String(input.title || validExistingTitle || "Untitled Mission"),
    repoPath: String(input.repoPath || existingState?.repoPath || process.cwd()),
    status: input.status || "awaiting_input",
    revision:
      typeof existingState?.revision === "number"
        ? existingState.revision + 1
        : 1,
    elapsedMs:
      typeof existingState?.elapsedMs === "number" ? existingState.elapsedMs : 0,
    lastStartedAt: null,
    planAccepted: Boolean(input.planAccepted ?? false),
    milestones,
    assertions,
    activeWorker: existingState?.activeWorker ?? null,
    sessions: Array.isArray(existingState?.sessions)
      ? existingState.sessions
      : [],
    pendingHandoffItems: Array.isArray(input.pendingHandoffItems)
      ? input.pendingHandoffItems
      : [],
    lastHandoffNeedsAttention: false,
    lastHandoffSummary: null,
    lastHandoffAt: null,
    milestoneValidationTriggered:
      existingState?.milestoneValidationTriggered &&
      typeof existingState.milestoneValidationTriggered === "object"
        ? { ...existingState.milestoneValidationTriggered }
        : {},
  };
}

export function validateDismissals(dismissals) {
  if (!Array.isArray(dismissals) || dismissals.length === 0) {
    throw new MissionKernelError(
      "INVALID_DISMISSALS",
      "Dismissals must be a non-empty array"
    );
  }
  return dismissals.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_ITEM",
        `Dismissal at index ${idx} must be an object`
      );
    }
    if (!DISMISSAL_TYPES.includes(item.type)) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_TYPE",
        `Dismissal at index ${idx} has invalid type "${item.type}". Expected one of: ${DISMISSAL_TYPES.join(", ")}`
      );
    }
    const sourceFeatureId = String(item.sourceFeatureId || "").trim();
    if (!sourceFeatureId) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_SOURCE",
        `Dismissal at index ${idx} requires sourceFeatureId`
      );
    }
    const itemId =
      typeof item.itemId === "string" && item.itemId.trim()
        ? item.itemId.trim()
        : undefined;
    const summary = String(item.summary || item.itemId || "").trim();
    if (!summary) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_SUMMARY",
        `Dismissal at index ${idx} requires summary`
      );
    }
    const justification = String(
      item.justification ?? item.reason ?? ""
    ).trim();
    if (justification.length < 20) {
      throw new MissionKernelError(
        "INVALID_JUSTIFICATION",
        `Dismissal justification at index ${idx} must be at least 20 characters (got ${justification.length})`
      );
    }
    const normalized = {
      type: item.type,
      sourceFeatureId,
      summary,
      justification,
    };
    if (itemId) {
      normalized.itemId = itemId;
    }
    return normalized;
  });
}

export function isNonEmptyLeftUndone(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower === "none" ||
    lower === "n/a" ||
    lower === "nil" ||
    trimmed === "无" ||
    trimmed === "没有"
  ) {
    return false;
  }
  return true;
}

export function isValidatorFeature(feature) {
  if (!feature) return false;
  const kind = inferFeatureKind(feature);
  return (
    kind === "scrutiny" ||
    kind === "user_testing" ||
    feature.kind === "user-testing"
  );
}
