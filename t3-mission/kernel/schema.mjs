import crypto from "node:crypto";

/** Inspect existing receipts before deciding that this run is still undispatched. */
export function inspectRunDispatchBinding(state, features = []) {
  const worker = state?.activeWorker;
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const hasIdentity = (record) => Boolean(record?.taskId || record?.childThreadId || record?.childRunId);
  if (!worker) {
    const orphan = features.some((f) => ["running", "paused"].includes(f.status) && hasIdentity(f)) ||
      sessions.some((s) => ["running", "paused"].includes(s.status) && hasIdentity(s));
    return { hasIdentity: orphan, requiresBinding: orphan };
  }
  const matchingSessions = sessions.filter((s) => s.runId === worker.runId);
  const feature = features.find((f) => f.id === worker.featureId && ["running", "paused"].includes(f.status));
  // A feature without runId is the legacy representation of the active attempt.
  const records = [worker, ...matchingSessions,
    ...(feature && (!feature.runId || feature.runId === worker.runId) ? [feature] : [])];
  const accepted = records.some(hasIdentity);
  const identityKeys = ["taskId", "childThreadId", "childRunId", "worktreePath", "clientRequestId"];
  const conflict = identityKeys.some((key) => new Set(records.map((r) => r[key]).filter(Boolean)).size > 1);
  const missingActiveIdentity = records.some((r) =>
    ["taskId", "childThreadId", "childRunId"].some((key) => r[key] && r[key] !== worker[key]));
  const wrongSession = matchingSessions.length > 1 || matchingSessions.some((s) => s.featureId !== worker.featureId);
  return {
    hasIdentity: accepted,
    requiresBinding: accepted && (conflict || wrongSession || missingActiveIdentity || !worker.childThreadId),
  };
}

export const MISSION_STATUSES = [
  "planning",
  "initializing",
  "awaiting_input",
  "running",
  "orchestrator_turn",
  "paused",
  "completed",
  "awaiting_merge",
];

export const FEATURE_STATUSES = [
  "pending",
  "running",
  "paused",
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

export function dispatchReceiptSources(result, { includeOperationRecords = false } = {}) {
  const sources = [], seen = new Set();
  const visit = value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return;
    seen.add(value); sources.push(value);
    visit(value.response); visit(value.delegation); visit(value.structuredContent);
    if (includeOperationRecords) { visit(value.task); visit(value.scheduledTask); }
    if (Array.isArray(value.content)) {
      const blocks = value.content.filter(block => block?.type === "text");
      if (blocks.length === 1 && typeof blocks[0].text === "string") {
        let parsed;
        try { parsed = JSON.parse(blocks[0].text); } catch { return; }
        visit(parsed);
      }
    }
  };
  visit(result);
  return sources;
}

/** Classify retained evidence before any caller projects a control result. */
function inspectControlReceipt(raw, operation, expected, { includeOperationRecords = false } = {}) {
  if (!["dispatch", "pause", "interrupt", "resume"].includes(operation) || !expected || typeof expected !== "object")
    throw new TypeError("Control classification requires an operation and expected child identity");
  const sources = dispatchReceiptSources(raw, { includeOperationRecords });
  const diagnostics = [];
  const text = value => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f]/u.test(value);
  const optionValue = value => Array.isArray(value) && value.every(row => typeof row?.id === "string")
    ? Object.fromEntries(value.map(row => [row.id, row.value])) : value;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
  const identity = {};
  const expectedThreads = ["childThreadId", "threadId"].map(alias => expected[alias]).filter(text);
  const resumeSameThread = operation === "resume" && expectedThreads.length > 0 &&
    sources.some(source => ["childThreadId", "threadId"].some(alias => expectedThreads.includes(source[alias]))) &&
    sources.some(source => typeof source.taskId === "string" && /(?:^|:|%3A)thread-send(?::|%3A)/i.test(source.taskId));
  for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath", "clientRequestId"]) {
    const keys = key === "childThreadId" ? [key, "threadId"] : [key];
    const values = sources.flatMap(source => keys.map(alias => source[alias])).filter(value => value !== undefined && value !== null);
    const unique = [...new Set(values.filter(text))];
    if (unique.length === 1) identity[key] = unique[0];
    if (unique.length > 1 || values.some(value => !text(value)))
      diagnostics.push({ code: "DISPATCH_RECEIPT_CONFLICT", key, observed: values });
    if (["taskId", "childThreadId", "childRunId"].includes(key)) {
      const wanted = keys.map(alias => expected[alias]).filter(text);
      const validResumeContinuation = resumeSameThread && (
        (key === "taskId" && unique.every(value => /(?:^|:|%3A)thread-send(?::|%3A)/i.test(value))) ||
        (key === "childRunId" && unique.every(value => /^run:thread:/i.test(value)))
      );
      if (!validResumeContinuation && (new Set(wanted).size > 1 || unique.some(value => wanted.length && !wanted.every(id => id === value))))
        diagnostics.push({ code: "CONTROL_IDENTITY_MISMATCH", key, expected: wanted, observed: unique });
    }
  }
  // Scope and target conflicts cannot be hidden in a plain or MCP container.
  for (const key of ["missionId", "missionRunId", "featureId", "runId", "providerInstanceId", "model", "options"]) {
    const targets = ["providerInstanceId", "model", "options"].includes(key) ? sources.flatMap(value => [value, value.target].filter(Boolean)) : sources;
    const values = targets.map(value => value[key]).filter(value => value !== undefined && value !== null);
    if (new Set(values.map(value => JSON.stringify(canonical(key === "options" ? optionValue(value) : value)))).size > 1)
      diagnostics.push({ code: "DISPATCH_RECEIPT_CONFLICT", key, observed: values });
  }
  const rejected = sources.some(value => value.ok === false || value.accepted === false || value.started === false ||
    value.canStart === false || value.blocked === true || value.isError === true || value.dispatchOutcome === "rejected" ||
    value.status === "blocked_by_conflicts" || value.action === "blocked_by_conflicts" ||
    (operation === "resume" && (value.resumed === false || value.canResume === false || value.sent === false)) ||
    (["pause", "interrupt"].includes(operation) && (value.paused === false || value.canPause === false || value.interrupted === false)) ||
    (value.dispatched === false && value.dispatchPending !== true));
  const pending = sources.some(value => value.dispatchPending === true || value.pending === true);
  const positiveAcceptance = sources.some(value => ["accepted", "started", "dispatched", "resumed", "sent", "paused", "interrupted"].some(key => value[key] === true));
  const hasChildIdentity = sources.some(value => ["taskId", "childThreadId", "threadId", "childRunId"].some(key => value[key] !== undefined && value[key] !== null));
  const hasExecutionEvidence = hasChildIdentity || sources.some(value => ["workerPid", "daemonStateFile", "handoff"].some(key => value[key] !== undefined && value[key] !== null));
  const identityConflict = diagnostics.length > 0;
  const malformedEnvelope = Array.isArray(raw) || sources.some(value => {
    for (const key of ["response", "delegation", "structuredContent", ...(includeOperationRecords ? ["task", "scheduledTask"] : [])]) {
      if (Object.hasOwn(value, key) && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) return true;
    }
    if (!Object.hasOwn(value, "content")) return false;
    if (!Array.isArray(value.content)) return true;
    const blocks = value.content.filter(block => block?.type === "text");
    if (blocks.length !== 1 || typeof blocks[0].text !== "string") return true;
    try { const parsed = JSON.parse(blocks[0].text); return !parsed || typeof parsed !== "object" || Array.isArray(parsed); }
    catch { return true; }
  });
  if (malformedEnvelope) diagnostics.push({ code: "INVALID_T3_OBSERVATION" });
  const affirmative = operation === "dispatch"
    ? hasChildIdentity || sources.some(value => value.workerPid || value.daemonStateFile || value.handoff)
    : operation === "resume"
      ? sources.some(value => value.resumed === true || value.sent === true || value.accepted === true ||
        ["started", "queued", "steered", "restarted"].includes(value.delivery) ||
        ((value.ok === true || ["running", "starting", "queued", "waiting", "completed"].includes(value.status)) && text(value.taskId)))
      : sources.some(value => value.paused === true || value.interrupted === true || value.accepted === true || value.ok === true);
  const classification = rejected ? "rejected" : identityConflict ? "identity_conflict" : pending ? "pending" : affirmative && !malformedEnvelope ? "confirmed" : "unknown";
  if (rejected) diagnostics.unshift({ code: "CONTROL_EXPLICIT_REJECTION" });
  else if (pending) diagnostics.push({ code: "CONTROL_PENDING" });
  else if (classification === "unknown") diagnostics.push({ code: "CONTROL_OUTCOME_UNKNOWN" });
  // A blocked dispatch states that it did not start, so it proves non-acceptance like started:false.
  // Plain and MCP-wrapped receipts share this set; isError alone is not proof.
  const explicitNonacceptance = sources.some(value => value.ok === false || value.accepted === false || value.started === false ||
    value.canStart === false || value.blocked === true || value.status === "blocked_by_conflicts" || value.action === "blocked_by_conflicts" ||
    value.dispatchOutcome === "rejected" || (value.dispatched === false && value.dispatchPending !== true));
  return { classification, raw, identity, diagnostics, sources, rejected, pending, positiveAcceptance, hasExecutionEvidence, malformedEnvelope,
    vetoed: rejected || pending || identityConflict || malformedEnvelope,
    explicitNonacceptance: explicitNonacceptance || (operation === "resume" && sources.some(value => value.resumed === false || value.canResume === false || value.sent === false)) };
}

export function classifyControlReceipt(raw, operation, expected) {
  const { classification, identity, diagnostics } = inspectControlReceipt(raw, operation, expected);
  return { classification, raw, identity, diagnostics };
}

/** The only authority for releasing, binding or recovering a dispatch intent. */
export function decideDispatchOutcome(raw, { expectedIdentity = {}, operation = "dispatch" } = {}) {
  if (expectedIdentity.worker) expectedIdentity = { ...expectedIdentity.worker, ...expectedIdentity, missionRunId: expectedIdentity.runId };
  const evidence = inspectControlReceipt(raw, operation, expectedIdentity);
  const { sources, rejected, pending, positiveAcceptance, hasExecutionEvidence, malformedEnvelope } = evidence;
  const diagnostics = [...evidence.diagnostics];
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
  const options = value => Array.isArray(value) && value.every(row => typeof row?.id === "string")
    ? Object.fromEntries(value.map(row => [row.id, row.value])) : value;
  for (const source of sources) {
    for (const key of ["missionId", "missionRunId", "featureId", "clientRequestId", "runId"]) {
      if (key === "runId" && source.featureId === undefined) continue;
      if (source[key] !== undefined && expectedIdentity[key] !== undefined && source[key] !== expectedIdentity[key])
        diagnostics.push({ code: "DISPATCH_RECEIPT_CONFLICT", key, expected: expectedIdentity[key], observed: source[key] });
    }
    for (const target of [source, source.target].filter(value => value && typeof value === "object")) {
      for (const key of ["providerInstanceId", "model", "options"]) {
        const wanted = expectedIdentity.target?.[key] ?? expectedIdentity[key];
        if (target[key] !== undefined && wanted !== undefined && JSON.stringify(canonical(key === "options" ? options(target[key]) : target[key])) !== JSON.stringify(canonical(key === "options" ? options(wanted) : wanted)))
          diagnostics.push({ code: "DISPATCH_TARGET_CONFLICT", key, expected: wanted, observed: target[key] });
      }
    }
  }
  for (const key of ["workerPid", "daemonStateFile"]) {
    const values = sources.map(source => source[key]).filter(value => value !== undefined && value !== null);
    if (new Set(values.map(value => JSON.stringify(value))).size > 1)
      diagnostics.push({ code: "DISPATCH_RECEIPT_CONFLICT", key, observed: values });
  }
  const controlReceipt = { classification: evidence.classification, raw, identity: evidence.identity, diagnostics };
  const result = { raw, diagnostics, controlReceipt };
  if (diagnostics.some(item => ["DISPATCH_RECEIPT_CONFLICT", "CONTROL_IDENTITY_MISMATCH", "DISPATCH_TARGET_CONFLICT"].includes(item.code)))
    return { ...result, outcome: "CONFLICT", errorCode: diagnostics.some(item => item.code === "DISPATCH_TARGET_CONFLICT") ? "DISPATCH_TARGET_CONFLICT" : "DISPATCH_RECEIPT_CONFLICT" };
  if (malformedEnvelope) return { ...result, outcome: "UNKNOWN", reason: "Malformed receipt envelope", errorCode: "DISPATCH_OUTCOME_UNKNOWN" };
  // Pending without any execution evidence is the established V02/V09 retry contract.
  if (!positiveAcceptance && !hasExecutionEvidence && (evidence.explicitNonacceptance || pending)) {
    const failure = sources.map(providerFailure).find(Boolean);
    const reason = failure?.message || sources.map(value => value.error ?? value.message ?? value.code).find(value => typeof value === "string") || (pending ? "Dispatch remains pending without a child" : "Transport explicitly did not accept the dispatch");
    return { ...result, outcome: "NOT_ACCEPTED", reason, providerFailureClass: failure?.kind ?? "provider_rejection", ...(rejected ? { errorCode: "DISPATCH_REJECTED" } : {}) };
  }
  if (rejected || pending) return { ...result, outcome: "UNKNOWN", reason: "Receipt cannot prove that execution did not start", errorCode: "DISPATCH_OUTCOME_UNKNOWN" };
  const identity = { ...evidence.identity };
  for (const key of ["workerPid", "daemonStateFile", "runtimeTransport", "daemonStatus", "delegatedBy"])
    for (const source of sources) if (source[key] !== undefined) identity[key] = source[key];
  if (operation === "resume" && evidence.classification === "confirmed")
    for (const key of ["taskId", "childThreadId", "childRunId"]) identity[key] ??= expectedIdentity[key];
  if (evidence.classification === "confirmed" && (identity.taskId || identity.childThreadId || identity.childRunId ||
      (Number.isSafeInteger(identity.workerPid) && identity.workerPid > 0) ||
      (typeof identity.daemonStateFile === "string" && identity.daemonStateFile.trim())))
    return { ...result, outcome: "ACCEPTED", identity };
  return { ...result, outcome: "UNKNOWN", reason: "No recoverable accepted identity", ...(positiveAcceptance ? { errorCode: "DISPATCH_OUTCOME_UNKNOWN" } : {}) };
}

/** Merge observations of one intent without letting weaker evidence release it. */
export function mergeDispatchEvidence(receipts, { expectedIdentity = {}, operation = "dispatch", unsettledInvocation = false } = {}) {
  const identity = {};
  const diagnostics = [];
  for (const raw of receipts) {
    const evidence = inspectControlReceipt(raw, operation, expectedIdentity);
    for (const source of [evidence.identity, ...evidence.sources]) {
      for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath", "clientRequestId", "workerPid", "daemonStateFile"]) {
        if (source[key] === undefined || source[key] === null) continue;
        if (identity[key] !== undefined && !isSameEvidence(identity[key], source[key]))
          diagnostics.push({ code: "DISPATCH_RECEIPT_CONFLICT", key, expected: identity[key], observed: source[key] });
        else identity[key] = source[key];
      }
    }
  }
  const decisions = receipts.map(raw => decideDispatchOutcome(raw, { expectedIdentity: { ...identity, ...expectedIdentity }, operation }));
  for (const verdict of decisions) diagnostics.push(...verdict.diagnostics);
  const conflict = decisions.find(verdict => verdict.outcome === "CONFLICT");
  if (conflict || diagnostics.some(item => item.code === "DISPATCH_RECEIPT_CONFLICT"))
    return { ...(conflict ?? decisions[0]), outcome: "CONFLICT", errorCode: conflict?.errorCode ?? "DISPATCH_RECEIPT_CONFLICT", diagnostics };
  const accepted = decisions.find(verdict => verdict.outcome === "ACCEPTED");
  const refusal = decisions.findLast(verdict => verdict.outcome === "NOT_ACCEPTED");
  if (accepted) return { ...accepted, identity: { ...accepted.identity, ...identity }, diagnostics: refusal ? [...diagnostics, { code: "DISPATCH_WEAK_REFUSAL_IGNORED" }] : diagnostics };
  if (unsettledInvocation) return { ...(decisions.at(-1) ?? decideDispatchOutcome(undefined, { expectedIdentity, operation })), outcome: "UNKNOWN", errorCode: "DISPATCH_OUTCOME_UNKNOWN", reason: "The current callback invocation has no durable return yet", diagnostics: [...diagnostics, { code: "DISPATCH_INVOCATION_UNSETTLED" }] };
  const uncertain = decisions.find(verdict => verdict.outcome === "UNKNOWN");
  if (uncertain) return { ...uncertain, errorCode: "DISPATCH_OUTCOME_UNKNOWN", diagnostics: refusal ? [...diagnostics, { code: "DISPATCH_WEAK_REFUSAL_IGNORED" }] : diagnostics };
  return refusal ?? decideDispatchOutcome(undefined, { expectedIdentity, operation });
}
const isSameEvidence = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Remove only dispatch-failure projections, preserving real task terminal results. */
export function clearDispatchRejection(run) {
  if (!run) return;
  const rejected = run.rejectedObservationId;
  if (rejected && run.terminalObservationId === rejected) delete run.terminalObservationId;
  if (rejected && run.result?.observationId === rejected) delete run.result;
  delete run.rejectedObservationId;
  if (["not_accepted", "acceptance_unknown", "conflict"].includes(run.failure?.kind)) delete run.failure;
}

export function providerFailure(value) {
  const message = [value?.summary, value?.error?.message, value?.error, value?.message].filter(item => typeof item === "string").join(" ");
  const evidence = [message, value?.code, value?.status, value?.error?.code, value?.error?.status].filter(item => typeof item === "string" || Number.isInteger(item)).join(" ");
  if (/rate.?limit|\b429\b|\b50[234]\b|air_unavailable|service.?unavailable|bad.?gateway|gateway.?timeout|overloaded|try again later|quota|credit|billing|capacity|resource.?exhausted/i.test(evidence)) return { kind: "provider_rate", message: message || evidence.trim() };
  if (/unauthori[sz]ed|forbidden|authentication|permission.?denied|api.?key|\b40[13]\b/i.test(evidence)) return { kind: "provider_auth", message: message || evidence.trim() };
  return null;
}

/** Shared veto for observations whose confirmation fields belong to their operation. */
export function unwrapObservationResponse(raw, expected = {}, { allowList = false } = {}) {
  if (allowList && Array.isArray(raw)) return raw;
  const evidence = inspectControlReceipt(raw, "dispatch", expected, { includeOperationRecords: true });
  const decision = decideDispatchOutcome(raw, { expectedIdentity: expected });
  if (decision.outcome === "CONFLICT" || evidence.vetoed)
    throw new MissionKernelError("INVALID_T3_OBSERVATION", "Observation is rejected, pending, conflicting or malformed", { controlReceipt: classifyControlReceipt(raw, "dispatch", expected) });
  for (const key of ["scheduledTaskId", "id", "enabled", "parentThreadId", "branch", "sourceBranch", "commit", "mergeSha"]) {
    const values = evidence.sources.map(source => source[key]).filter(value => value !== undefined);
    if (new Set(values.map(value => JSON.stringify(value))).size > 1)
      throw new MissionKernelError("INVALID_T3_OBSERVATION", `Observation has conflicting ${key}`, { raw });
  }
  return Object.assign({}, decodeMcpResponse(raw), ...evidence.sources);
}

export function isDispatchRejected(result, operation = "dispatch", expected = {}) {
  return classifyControlReceipt(result, operation, expected).classification === "rejected";
}

export function isDispatchPending(result, expected = {}) {
  return classifyControlReceipt(result, "dispatch", expected).classification === "pending";
}

/** Decode supported MCP envelopes only after checking every retained layer. */
export function unwrapMcpResponse(raw, operation = "dispatch", expected = {}) {
  const outcome = decideDispatchOutcome(raw, { expectedIdentity: expected, operation });
  if (operation !== "dispatch") {
    const verdict = classifyControlReceipt(raw, operation, expected);
    const wrapped = dispatchReceiptSources(raw).some(value => value.structuredContent || Array.isArray(value.content));
    if (wrapped && verdict.classification === "rejected" && outcome.outcome !== "NOT_ACCEPTED")
      throw new MissionKernelError("T3_OBSERVATION_ERROR", "MCP wrapper explicitly refused the control", { controlReceipt: verdict });
    if (wrapped && verdict.classification === "pending")
      throw new MissionKernelError("DISPATCH_OUTCOME_UNKNOWN", "MCP wrapper is pending; reconcile the original control", { controlReceipt: verdict });
    if (outcome.outcome === "CONFLICT")
      throw new MissionKernelError(outcome.errorCode, "Conflicting or foreign control receipt", { controlReceipt: verdict });
    return decodeMcpResponse(raw);
  }
  if (outcome.outcome === "CONFLICT" || (outcome.outcome === "UNKNOWN" && outcome.errorCode))
    throw new MissionKernelError(outcome.errorCode, "Operation is unconfirmed; raw evidence is retained", { controlReceipt: outcome.controlReceipt, dispatchDecision: outcome });
  return decodeMcpResponse(raw);
}

function decodeMcpResponse(raw) {
  const decode = value => {
    if (!value || typeof value !== "object") throw new MissionKernelError("INVALID_T3_OBSERVATION", "T3 response must be JSON data");
    if (Array.isArray(value)) return value;
    let inner = value.structuredContent;
    if (!inner && Array.isArray(value.content)) {
      const blocks = value.content.filter(block => block?.type === "text");
      if (blocks.length !== 1) throw new MissionKernelError("INVALID_T3_OBSERVATION", "Expected one JSON text block or structuredContent");
      try { inner = JSON.parse(blocks[0].text); }
      catch { throw new MissionKernelError("INVALID_T3_OBSERVATION", "Cannot decode MCP text JSON"); }
    }
    if (inner) {
      const { content, structuredContent, ...outer } = value;
      const decoded = decode(inner);
      return Array.isArray(decoded) ? decoded : { ...outer, ...decoded };
    }
    const decoded = { ...value };
    for (const key of ["response", "delegation"]) if (value[key] && typeof value[key] === "object") decoded[key] = decode(value[key]);
    return decoded;
  };
  return decode(raw);
}

export function isPauseConfirmed(result, expected = {}) {
  return classifyControlReceipt(result, "pause", expected).classification === "confirmed";
}

export function isResumeConfirmed(result, expected = {}) {
  return classifyControlReceipt(result, "resume", expected).classification === "confirmed";
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

function validateAutopilotPolicy(input) {
  const fail = message => { throw new MissionKernelError("INVALID_AUTOPILOT_POLICY", message); };
  const text = value => typeof value === "string" && value.trim().length > 0;
  if (input.pauseMode !== undefined && !["interrupt", "let_finish"].includes(input.pauseMode)) fail("pauseMode must be interrupt or let_finish");
  if (input.timerEveryMs !== undefined && (!Number.isSafeInteger(input.timerEveryMs) || input.timerEveryMs < 1000)) fail("timerEveryMs must be an integer of at least 1000");
  if (input.ownerThreadId !== undefined && !text(input.ownerThreadId)) fail("ownerThreadId must be nonempty");
  if (input.retryPolicy !== undefined) {
    const p = input.retryPolicy;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(key => !["baseDelayMs", "maxDelayMs", "maxConsecutiveProviderErrors", "maxStalledDecisionRepeats", "maxResultFormatRetries"].includes(key)) || Object.entries(p).some(([key, value]) => !Number.isSafeInteger(value) || value < (key === "maxResultFormatRetries" ? 0 : 1)) || (p.baseDelayMs ?? 30000) > (p.maxDelayMs ?? 1800000)) fail("Invalid retryPolicy");
  }
  if (input.fallbackTargets !== undefined) {
    if (!input.fallbackTargets || typeof input.fallbackTargets !== "object" || Array.isArray(input.fallbackTargets)) fail("fallbackTargets must be a role map");
    for (const [role, targets] of Object.entries(input.fallbackTargets)) {
      if (!["worker", "validator", "orchestrator"].includes(role) || !Array.isArray(targets) || !targets.every(target => text(target?.providerInstanceId) && text(target.model) && target.options && typeof target.options === "object" && !Array.isArray(target.options))) fail("Each fallback role requires approved provider/model/options targets");
    }
  }
}

/** Return the same state for an idempotent approval; only a new approval advances its epoch. */
export function approvePlanState(state, approvedAt = new Date().toISOString()) {
  if (state.planAccepted === true && !["planning", "awaiting_input"].includes(state.status)) return state;
  return { ...state, planAccepted: true, planApprovalEpoch: (state.planApprovalEpoch ?? 0) + 1, planApprovedAt: approvedAt };
}

export function createInitialState(input = {}, existingState = null) {
  validateAutopilotPolicy(input);
  if (input.autopilot !== undefined && typeof input.autopilot !== "boolean") throw new MissionKernelError("INVALID_AUTOPILOT_POLICY", "autopilot must be a boolean");
  const integration = input.integration ?? existingState?.integration;
  if (integration !== undefined && (!integration || typeof integration !== "object" || Array.isArray(integration) ||
      typeof integration.branch !== "string" || !integration.branch.trim() || typeof integration.auto !== "boolean")) {
    throw new MissionKernelError("INVALID_INTEGRATION_POLICY", "integration requires branch and an explicit auto boolean");
  }
  const permissions = input.permissions ?? existingState?.permissions;
  if (permissions !== undefined && (!Array.isArray(permissions) || !permissions.every(item => item && typeof item.id === "string" && item.id.trim() && ["pending", "approved", "denied"].includes(item.status)))) {
    throw new MissionKernelError("INVALID_PERMISSIONS", "permissions require an id and pending, approved, or denied status");
  }
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
    ...((input.autopilot ?? existingState?.autopilot) !== undefined ? { autopilot: input.autopilot ?? existingState.autopilot } : {}),
    ...(integration !== undefined ? { integration: structuredClone(integration) } : {}),
    ...(permissions !== undefined ? { permissions: structuredClone(permissions) } : {}),
    ...((input.ownerThreadId ?? existingState?.ownerThreadId) ? { ownerThreadId: input.ownerThreadId ?? existingState.ownerThreadId } : {}),
    ...Object.fromEntries(["pauseMode", "timerEveryMs", "retryPolicy", "fallbackTargets"].filter(key => (input[key] ?? existingState?.[key]) !== undefined).map(key => [key, structuredClone(input[key] ?? existingState[key])])),
    status: input.status || "awaiting_input",
    revision:
      typeof existingState?.revision === "number"
        ? existingState.revision + 1
        : 1,
    elapsedMs:
      typeof existingState?.elapsedMs === "number" ? existingState.elapsedMs : 0,
    lastStartedAt: null,
    planAccepted: Boolean(input.planAccepted ?? false),
    planApprovalEpoch: existingState?.planApprovalEpoch ?? 0,
    ...(existingState?.planApprovedAt ? { planApprovedAt: existingState.planApprovedAt } : {}),
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

/** Order-independent intent verdict after receipts have been attributed to calls. */
export function mergeInvocationEvidence(invocations, unowned = [], options = {}) {
  const calls = invocations.map(row => ({ invocationId: row.invocationId, phase: row.phase, ...mergeDispatchEvidence(row.receipts, options) }));
  // Unattributed refusals cannot settle any registered invocation. Identity and
  // execution evidence still participate in conflict detection and recovery.
  const strengthening = unowned.filter(raw => {
    const verdict = decideDispatchOutcome(raw, options);
    return verdict.outcome === "ACCEPTED" || verdict.outcome === "CONFLICT" || verdict.errorCode === "DISPATCH_OUTCOME_UNKNOWN";
  });
  const merged = mergeDispatchEvidence([...invocations.flatMap(row => row.receipts), ...strengthening], options);
  const diagnostic = unowned.length ? [{ code: "DISPATCH_UNATTRIBUTED_EVIDENCE", count: unowned.length }] : [];
  let outcome = merged;
  if (!["ACCEPTED", "CONFLICT"].includes(merged.outcome)) {
    const unsettled = calls.find(row => row.phase !== "returned" || row.outcome !== "NOT_ACCEPTED");
    if (unsettled || !calls.length || strengthening.length) outcome = { ...merged, outcome: "UNKNOWN", errorCode: "DISPATCH_OUTCOME_UNKNOWN", reason: "Not every invocation has its own trusted nonacceptance" };
    else outcome = { ...calls[0], outcome: "NOT_ACCEPTED" };
  }
  return { ...outcome, diagnostics: [...(outcome.diagnostics ?? []), ...diagnostic], invocations: calls.map(({ invocationId, phase, outcome }) => ({ invocationId, phase, outcome })), hasDurableEvidence: invocations.length > 0 || unowned.length > 0 };
}
