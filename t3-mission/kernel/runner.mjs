import { startElapsedClock } from "./elapsed.mjs";
import { hasAsciiControlCharacters } from "./text-validation.mjs";
import { readController, saveController } from "./autopilot-store.mjs";
import {
  missionTransaction,
  runMissionSteps,
  commandTransaction,
  readTransactionFile,
  writeTransactionFile,
  transactionHash,
  runClaimedEffect,
  listTransactionFiles,
} from "./mission-transaction.mjs";
import path from "node:path";
import { getMissionPaths } from "./store.mjs";
import {
  signalOwnedLocalWorker,
  isRemoteWorker,
  stripLocalWorkerMetadata,
} from "./worker-process.mjs";
import {
  prepareDispatch,
  dispatchWithIntent,
  mergeDispatchReceipt,
  recordAcceptedDispatch,
  assertNoUnresolvedDispatch,
} from "./dispatch-journal.mjs";

import { isDeepStrictEqual } from "node:util";
import {
  createRunId,
  dispatchReceiptSources,
  DEFAULT_MODEL_SETTINGS,
  doesProviderDeclareEffortOption,
  inferFeatureKind,
  getFeatureSlotOverride,
  classifyControlReceipt,
  decideDispatchOutcome,
  isResumeConfirmed,
  inspectRunDispatchBinding,
  isValidatorFeature,
  MissionKernelError,
  normalizeFeature,
  normalizeSlotConfig,
} from "./schema.mjs";
import {
  appendProgressLog,
  loadFeaturesDoc,
  loadModelSettings,
  loadState,
  saveFeaturesDoc,
  saveState,
} from "./store.mjs";
import { checkMilestoneCompletionAndInjectValidation, endFeatureRun } from "./tools.mjs";

export function cleanupLocalWorkerDaemon(worker, missionDir) {
  return signalOwnedLocalWorker(worker, missionDir, "SIGTERM");
}

export function resolveFeatureSlot(feature, modelSettings) {
  const validator = isValidatorFeature(feature);
  const slotName = validator ? "validator" : "worker";
  const baseSlot =
    (validator ? modelSettings?.validator : modelSettings?.worker) ||
    (validator ? DEFAULT_MODEL_SETTINGS.validator : DEFAULT_MODEL_SETTINGS.worker);
  const rawOverride = getFeatureSlotOverride(feature);
  const resolvedSlot =
    rawOverride !== null && rawOverride !== undefined
      ? normalizeSlotConfig(rawOverride, baseSlot)
      : normalizeSlotConfig(baseSlot, baseSlot);
  const cleanedOptions = { ...(resolvedSlot.options || {}) };
  if (!doesProviderDeclareEffortOption(resolvedSlot.providerInstanceId)) {
    delete cleanedOptions.effort;
  }
  if (resolvedSlot.providerInstanceId === "pi") {
    delete cleanedOptions.reasoningEffort;
  }
  return {
    slotName,
    slotConfig: {
      slot: slotName,
      ...resolvedSlot,
      options: cleanedOptions,
    },
  };
}

export function extractDelegationIdentity(result) {
  if (!result || typeof result !== "object") {
    return {};
  }
  const sources = dispatchReceiptSources(result);
  const identity = {};
  for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath"]) {
    const values = [
      ...new Set(
        sources
          .flatMap((src) => (key === "childThreadId" ? [src[key], src.threadId] : [src[key]]))
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => value.trim()),
      ),
    ];
    if (values.length > 1)
      throw new MissionKernelError("DISPATCH_RECEIPT_CONFLICT", "Conflicting receipt " + key);
    if (values.length) identity[key] = values[0];
  }
  return identity;
}

/** A bound child has one Resume claim per Pause, including legacy command IDs. */
export function resumeControlEffectId(missionDir, worker, state) {
  return missionTransaction(missionDir, () => {
    const epoch = state.pauseEpoch ?? state.pausedAt ?? "legacy";
    const prefixes = [`resume:${worker.runId}:${epoch}`, `resume-hook:${worker.runId}:${epoch}`];
    const dir = path.join(getMissionPaths(missionDir).baseDir, ".txn", "effects");
    const claims = listTransactionFiles(dir)
      .filter((name) => /^[a-f0-9]+\.json$/.test(name))
      .map((name) => JSON.parse(readTransactionFile(path.join(dir, name))))
      .filter((record) =>
        prefixes.some(
          (prefix) => record.effectId === prefix || record.effectId?.startsWith(prefix + ":"),
        ),
      );
    if (claims.length > 1)
      throw new MissionKernelError(
        "TX_EFFECT_OUTCOME_UNKNOWN",
        "Multiple retained Resume claims need owner reconciliation",
      );
    return claims[0]?.effectId ?? prefixes[0];
  });
}

/** Record an already accepted T3 task. This never dispatches or resumes work. */
function bindFeatureDispatchImpl(missionDir, input = {}) {
  const fail = (code, message) => {
    throw new MissionKernelError(code, message);
  };
  const text = (value) =>
    typeof value === "string" && value.trim().length > 0 && !hasAsciiControlCharacters(value);
  if (
    ![input.featureId, input.runId, input.taskId, input.childThreadId].every(text) ||
    input.runtimeTransport !== "t3-delegate-task" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    fail(
      "INVALID_DISPATCH_BINDING",
      "Binding requires featureId, runId, accepted taskId/childThreadId, t3-delegate-task transport and expectedRevision",
    );
  }
  const state = loadState(missionDir);
  const worker = state.activeWorker;
  const verdict = decideDispatchOutcome(input, { expectedIdentity: worker ?? {} });
  if (verdict.outcome !== "ACCEPTED")
    throw new MissionKernelError(
      "INVALID_DISPATCH_BINDING",
      "Binding requires confirmed child evidence",
      { controlReceipt: verdict },
    );
  const featuresDoc = loadFeaturesDoc(missionDir);
  const featureIndex = featuresDoc.features.findIndex((f) => f.id === input.featureId);
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).filter(
    (s) => s.runId === input.runId,
  );
  if (
    state.initialized === false ||
    state.planAccepted !== true ||
    !worker ||
    worker.runId !== input.runId ||
    worker.featureId !== input.featureId ||
    !["running", "paused"].includes(state.status) ||
    !["running", "paused"].includes(worker.status) ||
    featureIndex < 0 ||
    !["running", "paused"].includes(featuresDoc.features[featureIndex].status) ||
    sessions.length !== 1 ||
    sessions[0].featureId !== input.featureId
  ) {
    fail(
      "STALE_DISPATCH_BINDING",
      "Binding does not match the current active feature/run and its session",
    );
  }
  const identity = { taskId: input.taskId.trim(), childThreadId: input.childThreadId.trim() };
  for (const key of ["childRunId", "worktreePath"]) {
    if (input[key] !== undefined) {
      if (!text(input[key])) fail("INVALID_DISPATCH_BINDING", `Invalid ${key}`);
      identity[key] = input[key].trim();
    }
  }
  const records = [worker, sessions[0], featuresDoc.features[featureIndex]];
  for (const record of records) {
    for (const [key, value] of Object.entries(identity)) {
      if (record[key] && record[key] !== value)
        fail("DISPATCH_BINDING_CONFLICT", `Existing ${key} belongs to another dispatch`);
    }
  }
  if (
    input.target !== undefined &&
    (!input.target || typeof input.target !== "object" || Array.isArray(input.target))
  )
    fail("INVALID_DISPATCH_BINDING", "target must be an object");
  const target = { ...input, ...(input.target || {}) };
  for (const key of ["providerInstanceId", "model", "options"]) {
    if (
      input[key] !== undefined &&
      input.target?.[key] !== undefined &&
      !isDeepStrictEqual(input[key], input.target[key])
    ) {
      fail("DISPATCH_TARGET_CONFLICT", `Conflicting top-level and nested ${key}`);
    }
  }
  if (
    records.some(
      (r) =>
        (typeof r.workerPid === "number" && r.workerPid > 0) ||
        (typeof r.daemonStateFile === "string" && r.daemonStateFile.length > 0),
    )
  ) {
    fail(
      "DISPATCH_BINDING_CONFLICT",
      "Local runtime ownership must be reconciled before binding an external task",
    );
  }
  const metadata = {};
  for (const key of ["providerInstanceId", "model"]) {
    if (target[key] !== undefined) {
      if (!text(target[key])) fail("INVALID_DISPATCH_BINDING", `Invalid ${key}`);
      metadata[key] = target[key].trim();
    }
  }
  if (target.options !== undefined) {
    if (!target.options || typeof target.options !== "object" || Array.isArray(target.options))
      fail("INVALID_DISPATCH_BINDING", "options must be an object");
    metadata.options = structuredClone(target.options);
  }
  if (input.workerNumber !== undefined && input.workerNumber !== worker.workerNumber)
    fail("STALE_DISPATCH_BINDING", "Worker number does not match the active run");
  if (sessions[0].workerNumber !== worker.workerNumber)
    fail("STALE_DISPATCH_BINDING", "Session worker number does not match the active run");
  for (const [key, value] of Object.entries(metadata)) {
    if (!isDeepStrictEqual(worker[key], value) || !isDeepStrictEqual(sessions[0][key], value)) {
      fail("DISPATCH_TARGET_CONFLICT", `Receipt ${key} differs from the recorded active target`);
    }
  }
  if (input.clientRequestId !== undefined) {
    if (!text(input.clientRequestId)) fail("INVALID_DISPATCH_BINDING", "Invalid clientRequestId");
    identity.clientRequestId = input.clientRequestId.trim();
    for (const record of records)
      if (record.clientRequestId && record.clientRequestId !== identity.clientRequestId)
        fail("DISPATCH_BINDING_CONFLICT", "Existing clientRequestId differs");
  }
  const complete =
    records.every(
      (r) =>
        Object.entries(identity).every(([k, v]) => r[k] === v) &&
        r.runtimeTransport === "t3-delegate-task" &&
        r.dispatchPending === undefined &&
        r.delegatedBy !== "hud-default-runtime",
    ) &&
    [worker, sessions[0]].every((r) =>
      Object.entries(metadata).every(([k, v]) => isDeepStrictEqual(r[k], v)),
    );
  if (complete) return state;
  if (state.revision !== input.expectedRevision)
    fail("STALE_DISPATCH_BINDING", "Mission revision changed before binding");
  const intent = recordAcceptedDispatch(missionDir, state, featuresDoc.features[featureIndex], {
    ...input,
    ...identity,
    runtimeTransport: "t3-delegate-task",
  });
  identity.clientRequestId = intent.clientRequestId;
  const merged = mergeDispatchReceipt(
    state,
    featuresDoc,
    { ...identity, ...metadata, runtimeTransport: "t3-delegate-task" },
    intent,
  );
  Object.assign(state, merged.state);
  featuresDoc.features = merged.featuresDoc.features;
  state.revision += 1;
  saveFeaturesDoc(missionDir, featuresDoc);
  saveState(missionDir, state);
  appendProgressLog(missionDir, {
    type: "feature_dispatch_bound",
    message: `Bound accepted T3 task to ${input.featureId}`,
    featureId: input.featureId,
    workerNumber: worker.workerNumber,
    details: { runId: input.runId, ...identity, runtimeTransport: "t3-delegate-task" },
  });
  return state;
}

function markDispatchPendingImpl(missionDir, runId, featureId, intent) {
  const state = loadState(missionDir),
    doc = loadFeaturesDoc(missionDir);
  const reason = workerDispatchBlockReason(state, { runId, featureId }, doc, intent.missionId);
  if (reason) throw new MissionKernelError("MISSION_NOT_DISPATCHABLE", reason);
  if (
    state.activeWorker?.runId !== runId ||
    inspectRunDispatchBinding(state, doc.features).hasIdentity
  )
    return state;
  const update = (entry, isFeature = false) => {
    const next = { ...entry, dispatchPending: true };
    delete next.dispatchNotInvoked;
    if (intent) next.clientRequestId = intent.clientRequestId;
    if (!isFeature && intent) Object.assign(next, intent.target);
    for (const key of [
      "taskId",
      "childThreadId",
      "childRunId",
      "workerPid",
      "daemonStateFile",
      "daemonStatus",
    ])
      delete next[key];
    return next;
  };
  state.activeWorker = update(state.activeWorker);
  state.sessions = (state.sessions || []).map((row) => (row.runId === runId ? update(row) : row));
  doc.features = doc.features.map((row) => (row.id === featureId ? update(row, true) : row));
  saveFeaturesDoc(missionDir, doc);
  saveState(missionDir, state);
  return state;
}

function missionDispatchBlockReason(state) {
  if (state.initialized === false) return "MISSION_NOT_INITIALIZED";
  if (state.planAccepted !== true) return "PLAN_ACCEPTANCE_REQUIRED";
  if (state.lastHandoffNeedsAttention === true) return "HANDOFF_ATTENTION_REQUIRED";
  if (["planning", "awaiting_input"].includes(state.status)) return "MISSION_WAITING_FOR_INPUT";
  return null;
}

function blockedDispatch(state, reason) {
  return { ...state, resumed: false, canResume: false, code: "MISSION_NOT_DISPATCHABLE", reason };
}

// Shared with HUD routes that stage approval before committing their projections.
export function workerDispatchBlockReason(state, worker, featuresDoc, missionId = state.missionId) {
  const closed = missionDispatchBlockReason(state);
  if (closed) return closed;
  if (state.missionId !== missionId) return "MISSION_REPLACED";
  if (
    !worker?.runId ||
    !worker.featureId ||
    state.activeWorker?.runId !== worker.runId ||
    state.activeWorker?.featureId !== worker.featureId
  )
    return "ACTIVE_WORKER_REPLACED";
  if (
    (state.status && !["running", "paused", "orchestrator_turn"].includes(state.status)) ||
    (state.activeWorker.status && !["running", "paused"].includes(state.activeWorker.status))
  )
    return "ACTIVE_WORKER_NOT_RUNNABLE";
  const features = featuresDoc.features.filter((row) => row.id === worker.featureId);
  if (
    features.length > 1 ||
    features.some(
      (row) =>
        ["completed", "failed", "cancelled"].includes(row.status) ||
        (row.runId && row.runId !== worker.runId),
    )
  )
    return "ACTIVE_FEATURE_REPLACED_OR_COMPLETED";
  const sessions = (state.sessions || []).filter(
    (row) =>
      row.runId === worker.runId ||
      (row.workerNumber !== undefined && row.workerNumber === state.activeWorker.workerNumber) ||
      (row.workerNumber === undefined && row.featureId === worker.featureId),
  );
  if (sessions.length > 1) return "ACTIVE_SESSION_NOT_UNIQUE";
  if (
    sessions.some(
      (row) =>
        (row.runId && row.runId !== worker.runId) ||
        (row.featureId && row.featureId !== worker.featureId) ||
        (row.status && !["running", "paused"].includes(row.status)) ||
        (row.workerNumber !== undefined &&
          state.activeWorker.workerNumber !== undefined &&
          row.workerNumber !== state.activeWorker.workerNumber) ||
        (row.attempt !== undefined &&
          state.activeWorker.attempt !== undefined &&
          row.attempt !== state.activeWorker.attempt),
    )
  )
    return "ACTIVE_SESSION_INCONSISTENT";
  return null;
}

function canApplyWorkerResult(state, worker, featuresDoc, missionId) {
  return workerDispatchBlockReason(state, worker, featuresDoc, missionId) === null;
}

function ownerLifecycleChanged(before, current) {
  return (
    current.revision !== before.revision ||
    current.status !== before.status ||
    current.pausedAt !== before.pausedAt ||
    current.activeWorker?.status !== before.activeWorker?.status ||
    current.activeWorker?.pausedAt !== before.activeWorker?.pausedAt
  );
}

/** A new user Pause owns the lifecycle, but an accepted child still needs control. */
function* settlePausedWorkerResultSteps(
  missionDir,
  before,
  worker,
  result,
  intent,
  adapter,
  operation = "dispatch",
) {
  if (operation === "resume" && !isResumeConfirmed(result, worker)) return null;
  let current = loadState(missionDir),
    doc = loadFeaturesDoc(missionDir);
  const newPause =
    current.status === "paused" &&
    (before.status !== "paused" ||
      current.pausedAt !== before.pausedAt ||
      current.activeWorker?.pausedAt !== before.activeWorker?.pausedAt);
  if (
    !newPause ||
    !canApplyWorkerResult(current, worker, doc, before.missionId) ||
    decideDispatchOutcome(result, { operation, expectedIdentity: intent ?? worker }).outcome !==
      "ACCEPTED"
  )
    return null;
  const receipt = {
    ...extractDelegationIdentity(worker),
    ...result,
    ...extractDelegationIdentity(result),
  };
  if (!receipt.taskId && !receipt.childThreadId && !receipt.childRunId) return null;
  intent ||= prepareDispatch(missionDir, {
    state: before,
    feature: doc.features.find((row) => row.id === worker.featureId),
    worker,
    target: worker,
  });
  const pauseEpoch = current.pauseEpoch ?? current.pausedAt ?? "legacy";
  let phase;
  const attach = (state, featuresDoc) => {
    const samePause = (state.pauseEpoch ?? state.pausedAt ?? "legacy") === pauseEpoch;
    const childState = (record) => {
      if (!samePause || phase === undefined || phase === "confirmed") return record;
      const next = { ...record, status: "running" };
      delete next.pausedAt;
      return next;
    };
    const target = { ...intent.target, ...(worker.slot ? { slot: worker.slot } : {}) };
    const staged = {
      ...state,
      activeWorker: childState({ ...state.activeWorker, ...target }),
      sessions: (state.sessions || []).map((row) =>
        row.runId === intent.runId ? childState({ ...row, ...target }) : row,
      ),
    };
    const merged = mergeDispatchReceipt(staged, featuresDoc, receipt, intent);
    merged.featuresDoc = {
      ...merged.featuresDoc,
      features: merged.featuresDoc.features.map((row) =>
        row.id === intent.featureId ? childState({ ...row, ...target }) : row,
      ),
    };
    return merged;
  };
  const accepted = attach(current, doc);
  const effectFile = path.join(
    getMissionPaths(missionDir).baseDir,
    ".txn",
    "effects",
    transactionHash(
      `late-pause:${intent.runId}:${current.pauseEpoch ?? current.pausedAt ?? "legacy"}`,
    ) + ".json",
  );
  if (readTransactionFile(effectFile) !== null) return current;
  writeTransactionFile(
    effectFile,
    JSON.stringify({ version: 1, phase: "requested", runId: intent.runId, receipt }) + "\n",
  );
  if (current.autopilot === true) {
    const ledger = readController(missionDir, current.missionId);
    const run = (ledger.runs[intent.runId] ??= {
      featureId: intent.featureId,
      intentId: intent.clientRequestId,
    });
    if (!run.pause || run.pause.phase === "resumed") {
      run.pause = {
        epoch: pauseEpoch,
        phase: "interrupt_requested",
        baselineRunId: receipt.childRunId ?? null,
        compensation: { effectId: `late-pause:${intent.runId}:${pauseEpoch}` },
      };
      saveController(missionDir, ledger);
    }
  }
  const projected = attach(current, doc);
  projected.state.revision = (current.revision || 1) + 1;
  saveFeaturesDoc(missionDir, projected.featuresDoc);
  saveState(missionDir, projected.state);
  let pauseError, pauseResponse, pauseVerdict;
  try {
    if (typeof adapter?.pauseWorker !== "function")
      throw new Error("No pauseWorker transport for accepted child");
    pauseResponse = yield () => adapter.pauseWorker(accepted.state.activeWorker, accepted.state);
    pauseVerdict = classifyControlReceipt(pauseResponse, "pause", accepted.state.activeWorker);
    if (pauseVerdict.classification === "rejected") {
      phase = "failed";
      pauseError =
        dispatchReceiptSources(pauseResponse).find((row) => row.error)?.error ||
        "Runtime refused accepted child pause";
    } else if (pauseVerdict.classification === "confirmed") phase = "confirmed";
    else {
      phase = "unknown";
      pauseError =
        "PAUSE_CONTROL_OUTCOME_UNKNOWN: accepted child Pause is pending or unconfirmed; reconcile the original once-only control";
    }
  } catch (error) {
    phase = "unknown";
    pauseError = error.message;
  }
  writeTransactionFile(
    effectFile,
    JSON.stringify({
      version: 1,
      phase,
      runId: intent.runId,
      receipt,
      responseDefined: pauseResponse !== undefined,
      response: pauseResponse,
      controlReceipt: pauseVerdict,
      ...(pauseError ? { error: pauseError } : {}),
    }) + "\n",
  );
  // The pause callback can itself await a newer owner commit. Read it again.
  current = loadState(missionDir);
  doc = loadFeaturesDoc(missionDir);
  if (current.status !== "paused" || !canApplyWorkerResult(current, worker, doc, before.missionId))
    return current;
  const merged = attach(current, doc);
  if (pauseError) {
    merged.state.activeWorker.pauseError = pauseError;
    merged.state.sessions = merged.state.sessions.map((row) =>
      row.runId === intent.runId ? { ...row, pauseError } : row,
    );
    merged.featuresDoc.features = merged.featuresDoc.features.map((row) =>
      row.id === intent.featureId ? { ...row, pauseError } : row,
    );
  }
  if (isDeepStrictEqual(merged.state, current) && isDeepStrictEqual(merged.featuresDoc, doc))
    return current;
  merged.state.revision = (current.revision || 1) + 1;
  saveFeaturesDoc(missionDir, merged.featuresDoc);
  saveState(missionDir, merged.state);
  return merged.state;
}

function* dispatchPreparedWorkerSteps(missionDir, feature, worker, slotConfig, adapter) {
  const state = loadState(missionDir),
    featuresDoc = loadFeaturesDoc(missionDir);
  const reason = workerDispatchBlockReason(state, worker, featuresDoc);
  if (reason) return blockedDispatch(state, reason);
  const intent = prepareDispatch(missionDir, { state, feature, worker, target: slotConfig });
  let before = state;
  let invoked = false;
  let result;

  result = yield () =>
    dispatchWithIntent(missionDir, intent, (call) => {
      invoked = true;
      try {
        before = markDispatchPending(missionDir, intent.runId, intent.featureId, intent);
      } catch (error) {
        error.runtimeResult = { accepted: false, code: error.code };
        throw error;
      }
      return adapter.runFeature(
        {
          ...feature,
          runId: intent.runId,
          clientRequestId: intent.clientRequestId,
          invocationId: call.invocationId,
          dispatchTitle: intent.recovery?.title,
        },
        { ...slotConfig, ...intent.target },
        loadState(missionDir),
      );
    });
  const verdict = decideDispatchOutcome(result, { expectedIdentity: intent });
  if (verdict.outcome === "NOT_ACCEPTED" && verdict.errorCode)
    throw new MissionKernelError(
      result?.code || result?.response?.code || verdict.errorCode,
      result?.error || "Runtime refused worker dispatch",
    );

  const paused = yield () =>
    settlePausedWorkerResult(missionDir, before, worker, result, intent, adapter);
  if (paused) return paused;
  let current = loadState(missionDir),
    doc = loadFeaturesDoc(missionDir);
  if (
    !canApplyWorkerResult(current, worker, doc, intent.missionId) ||
    inspectRunDispatchBinding(current, doc.features).hasIdentity
  )
    return current;
  // The journal owns the receipt; a newer owner commit owns all Mission projections.
  if (ownerLifecycleChanged(before, current)) return current;
  if (decideDispatchOutcome(result, { expectedIdentity: intent }).outcome !== "ACCEPTED")
    return current;
  // Retain the existing cleanup contract for an explicitly upgraded legacy runtime.
  // Accepted-journal replays never clean a PID added by a later writer.
  if (invoked && (worker.workerPid || worker.daemonStateFile))
    cleanupLocalWorkerDaemon(worker, missionDir);
  const resumed = (row) => {
    const next = { ...row, status: "running" };
    delete next.resumePending;
    return next;
  };
  current = {
    ...current,
    status: "running",
    activeWorker: resumed(current.activeWorker),
    sessions: current.sessions.map((row) => (row.runId === intent.runId ? resumed(row) : row)),
  };
  const merged = mergeDispatchReceipt(current, doc, result, intent);
  if (merged.changed || !isDeepStrictEqual(current, loadState(missionDir))) {
    merged.state.revision = (merged.state.revision || 1) + 1;
    saveFeaturesDoc(missionDir, merged.featuresDoc);
    saveState(missionDir, merged.state);
  }
  if (result?.handoff && loadState(missionDir).activeWorker?.runId === intent.runId)
    endFeatureRun(missionDir, { ...result, runId: intent.runId, featureId: intent.featureId });
  return loadState(missionDir);
}

function selectFeatureForWorkerImpl(
  missionDir,
  candidate,
  featureIdx,
  modelSettings,
  dispatchAdapter = {},
  dispatchTarget,
) {
  let state = loadState(missionDir),
    featuresDoc = loadFeaturesDoc(missionDir);
  assertNoUnresolvedDispatch(missionDir, candidate.id);
  const closed = missionDispatchBlockReason(state);
  if (closed) return blockedDispatch(state, closed);
  if (
    state.activeWorker ||
    !["running", "orchestrator_turn"].includes(state.status) ||
    candidate?.status !== "pending" ||
    !isDeepStrictEqual(featuresDoc.features[featureIdx], candidate) ||
    featuresDoc.features.filter((row) => row.id === candidate.id).length !== 1 ||
    featuresDoc.features.some((row) => ["running", "paused"].includes(row.status))
  ) {
    return blockedDispatch(state, "STALE_FEATURE_SELECTION");
  }
  const attempt = (candidate.attempts || 0) + 1,
    workerNumber = (state.sessions || []).length + 1;
  const { slotName, slotConfig } = resolveFeatureSlot(
    dispatchTarget ? { ...candidate, target: dispatchTarget } : candidate,
    modelSettings,
  );
  const kind = inferFeatureKind(candidate),
    isValidator = isValidatorFeature(candidate);
  let worker = {
    runId: createRunId(),
    workerNumber,
    role: isValidator ? "Validator" : kind === "explorer" ? "Explorer" : "Worker",
    featureId: candidate.id,
    featureTitle: candidate.title,
    milestoneId: candidate.milestoneId,
    kind,
    skillName: candidate.skillName,
    slot: slotName,
    providerInstanceId: slotConfig.providerInstanceId,
    model: slotConfig.model,
    options: slotConfig.options || {},
    status: "running",
    attempt,
    startedAt: new Date().toISOString(),
    handoff: null,
    dispatchPending: true,
    dispatchNotInvoked: true,
  };
  if (typeof dispatchAdapter.runFeature === "function") {
    const intent = prepareDispatch(missionDir, {
      state,
      feature: candidate,
      worker,
      target: slotConfig,
    });
    worker = { ...intent.worker, dispatchPending: true };
  }
  const nextFeature = {
    ...candidate,
    status: "running",
    attempts: attempt,
    runId: worker.runId,
    dispatchPending: true,
  };
  for (const key of ["taskId", "childThreadId", "childRunId", "clientRequestId"])
    delete nextFeature[key];
  if (worker.clientRequestId) nextFeature.clientRequestId = worker.clientRequestId;
  featuresDoc.features[featureIdx] = normalizeFeature(nextFeature, featureIdx);
  saveFeaturesDoc(missionDir, featuresDoc);
  state = {
    ...state,
    activeWorker: worker,
    status: "running",
    sessions: [...(state.sessions || []), { ...worker }],
    revision: (state.revision || 1) + 1,
  };
  startElapsedClock(state, worker.startedAt);
  saveState(missionDir, state);
  appendProgressLog(missionDir, {
    timestamp: worker.startedAt,
    type: "run_started",
    message: `Worker #${workerNumber} started ${candidate.id}: ${candidate.title}`,
    featureId: candidate.id,
    workerNumber,
  });
  return loadState(missionDir);
}

export function selectFeatureForWorker(dir, ...args) {
  return missionTransaction(dir, () => selectFeatureForWorkerImpl(dir, ...args));
}
export async function dispatchFeatureToWorker(
  dir,
  candidate,
  featureIdx,
  settings,
  adapter = {},
  dispatchTarget,
) {
  const state = selectFeatureForWorker(
    dir,
    candidate,
    featureIdx,
    settings,
    adapter,
    dispatchTarget,
  );
  if (state.code === "MISSION_NOT_DISPATCHABLE" || typeof adapter.runFeature !== "function")
    return state;
  const feature = loadFeaturesDoc(dir).features.find((row) => row.id === candidate.id);
  const { slotConfig } = resolveFeatureSlot(
    dispatchTarget ? { ...feature, target: dispatchTarget } : feature,
    settings,
  );
  return dispatchPreparedWorker(dir, feature, state.activeWorker, slotConfig, adapter);
}

function* startMissionRunSteps(missionDir, options = {}, dispatchAdapter = {}) {
  const effectiveAdapter = {
    ...(options && typeof options === "object" ? options : {}),
    ...(dispatchAdapter && typeof dispatchAdapter === "object" ? dispatchAdapter : {}),
  };
  let state = loadState(missionDir);

  if (state.planAccepted !== true) {
    throw new MissionKernelError(
      "PLAN_ACCEPTANCE_REQUIRED",
      "Mission plan must be approved before starting a mission run",
    );
  }

  if (state.lastHandoffNeedsAttention === true) {
    throw new MissionKernelError(
      "HANDOFF_ATTENTION_REQUIRED",
      "Previous worker handoff requires orchestrator attention (updateMissionFeatures or dismissHandoffItems) before continuing",
    );
  }

  const closed = missionDispatchBlockReason(state);
  if (closed) return blockedDispatch(state, closed);
  const currentFeatures = loadFeaturesDoc(missionDir);
  if (
    !state.activeWorker &&
    (currentFeatures.features.some((row) => ["running", "paused"].includes(row.status)) ||
      new Set(currentFeatures.features.map((row) => row.id)).size !==
        currentFeatures.features.length)
  ) {
    return blockedDispatch(state, "STALE_FEATURE_SELECTION");
  }
  if (state.activeWorker) {
    const reason = workerDispatchBlockReason(state, state.activeWorker, currentFeatures);
    if (reason) return blockedDispatch(state, reason);
  }

  const binding = inspectRunDispatchBinding(state, loadFeaturesDoc(missionDir).features);
  if (binding.requiresBinding) {
    return { ...state, resumed: false, canResume: false, code: "DISPATCH_BINDING_REQUIRED" };
  }

  const needsResume =
    state.status === "paused" ||
    state.activeWorker?.status === "paused" ||
    state.activeWorker?.resumePending === true;

  // An active run owns the feature regardless of the mission's display status.
  if (state.activeWorker) {
    const existing = state.activeWorker;
    const hasAcceptedIdentity = binding.hasIdentity;
    const pendingDispatch =
      !hasAcceptedIdentity &&
      (existing.dispatchPending === true ||
        (existing.runtimeTransport === "orchestrator-pending" &&
          !existing.taskId &&
          !existing.childThreadId &&
          !existing.workerPid) ||
        existing.delegatedBy === "hud-default-runtime" ||
        existing.runtimeTransport === "bridge-cli-subprocess" ||
        existing.runtimeTransport === "hud-default-runtime");
    if (pendingDispatch) {
      if (typeof effectiveAdapter.runFeature !== "function") return state;
      const feature = loadFeaturesDoc(missionDir).features.find((f) => f.id === existing.featureId);
      if (!feature)
        throw new MissionKernelError("STALE_DISPATCH_BINDING", "Pending feature is missing");
      const { slotConfig } = resolveFeatureSlot(feature, loadModelSettings(missionDir));
      return yield () =>
        dispatchPreparedWorker(
          missionDir,
          feature,
          { ...existing, ...slotConfig },
          slotConfig,
          effectiveAdapter,
        );
    }
    if (!needsResume) return state;
  }

  // Resume interrupted worker first if recovering from paused state
  if (needsResume && state.activeWorker && !options?.restartFeature) {
    const pausedActiveWorker = { ...state.activeWorker };
    const workerNumber = pausedActiveWorker.workerNumber ?? 1;
    const featureTitle =
      pausedActiveWorker.featureTitle || pausedActiveWorker.title || pausedActiveWorker.featureId;

    if (typeof effectiveAdapter?.resumeWorker !== "function") {
      return { ...state, resumed: false, canResume: false, code: "NO_T3_TRANSPORT" };
    }
    const resumeMissionId = state.missionId;
    const beforeResume = state;
    const resumeCommandId = resumeControlEffectId(missionDir, pausedActiveWorker, beforeResume);
    let resumeResult = null;
    if (typeof effectiveAdapter?.resumeWorker === "function") {
      const legacyIntent =
        !binding.hasIdentity && !state.activeWorker.workerPid && !state.activeWorker.daemonStateFile
          ? prepareDispatch(missionDir, {
              state,
              feature: loadFeaturesDoc(missionDir).features.find(
                (f) => f.id === state.activeWorker.featureId,
              ),
              worker: state.activeWorker,
              target: state.activeWorker,
            })
          : null;
      const invoke = (call) => {
        const current = loadState(missionDir);
        const reason = workerDispatchBlockReason(
          current,
          pausedActiveWorker,
          loadFeaturesDoc(missionDir),
          resumeMissionId,
        );
        if (reason)
          throw Object.assign(new MissionKernelError("MISSION_NOT_DISPATCHABLE", reason), {
            runtimeResult: { accepted: false, code: "MISSION_NOT_DISPATCHABLE" },
          });
        return effectiveAdapter.resumeWorker(
          {
            ...state.activeWorker,
            ...(legacyIntent
              ? { clientRequestId: legacyIntent.clientRequestId, invocationId: call.invocationId }
              : {}),
          },
          { ...options, controlRequestId: resumeCommandId },
          current,
        );
      };
      resumeResult = yield () =>
        legacyIntent
          ? dispatchWithIntent(missionDir, legacyIntent, invoke, { operation: "resume" })
          : runClaimedEffect(missionDir, resumeCommandId, invoke);
      const paused = yield () =>
        settlePausedWorkerResult(
          missionDir,
          beforeResume,
          pausedActiveWorker,
          resumeResult,
          legacyIntent,
          effectiveAdapter,
          "resume",
        );
      if (paused) return paused;
      if (legacyIntent) resumeResult = { ...resumeResult, __dispatchIntent: legacyIntent };

      const afterCallback = loadState(missionDir);
      if (
        !canApplyWorkerResult(
          afterCallback,
          pausedActiveWorker,
          loadFeaturesDoc(missionDir),
          resumeMissionId,
        )
      )
        return afterCallback;
      if (ownerLifecycleChanged(beforeResume, afterCallback)) return afterCallback;
      const resumeVerdict = classifyControlReceipt(resumeResult, "resume", pausedActiveWorker);
      if (resumeVerdict.classification === "identity_conflict")
        throw new MissionKernelError(
          resumeVerdict.diagnostics.some((item) => item.code === "DISPATCH_RECEIPT_CONFLICT")
            ? "DISPATCH_RECEIPT_CONFLICT"
            : "DISPATCH_BINDING_CONFLICT",
          "Resume returned conflicting child identity",
          { controlReceipt: resumeVerdict },
        );
      if (resumeVerdict.classification !== "confirmed") {
        return {
          ...afterCallback,
          resumed: false,
          canResume: false,
          code: resumeResult?.code || resumeResult?.response?.code || "RESUME_UNCONFIRMED",
          resumeResult,
        };
      }
    }
    const currentAfterResume = loadState(missionDir);
    if (
      !canApplyWorkerResult(
        currentAfterResume,
        pausedActiveWorker,
        loadFeaturesDoc(missionDir),
        resumeMissionId,
      )
    )
      return currentAfterResume;
    if (ownerLifecycleChanged(beforeResume, currentAfterResume)) return currentAfterResume;

    const nowIso = new Date().toISOString();
    const identity = extractDelegationIdentity(resumeResult);
    for (const key of ["taskId", "childThreadId"])
      if (pausedActiveWorker[key] && identity[key] && pausedActiveWorker[key] !== identity[key])
        throw new MissionKernelError(
          "DISPATCH_BINDING_CONFLICT",
          `Resume changed the accepted ${key}`,
        );
    state = loadState(missionDir);

    const workerStillActive = Boolean(
      state.activeWorker && state.activeWorker.runId === pausedActiveWorker.runId,
    );

    if (workerStillActive) {
      state.status = "running";
      startElapsedClock(state, nowIso);
      state.revision = (state.revision || 1) + 1;
      state.activeWorker = {
        ...state.activeWorker,
        ...identity,
        status: "running",
        resumedAt: nowIso,
      };
      delete state.activeWorker.resumePending;
      const remote = isRemoteWorker(state.activeWorker) || isRemoteWorker(resumeResult);
      const resumedRecord = (row) => (remote ? stripLocalWorkerMetadata(row) : row);
      state.activeWorker = resumedRecord(state.activeWorker);

      if (Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((s) =>
          s.runId === pausedActiveWorker.runId
            ? resumedRecord({ ...s, ...identity, status: "running", resumedAt: nowIso })
            : s,
        );
      }
      if (resumeResult?.__dispatchIntent) {
        const merged = mergeDispatchReceipt(
          state,
          loadFeaturesDoc(missionDir),
          resumeResult,
          resumeResult.__dispatchIntent,
        );
        state = merged.state;
        saveFeaturesDoc(missionDir, merged.featuresDoc);
      }
      saveState(missionDir, state);

      const featuresDoc = loadFeaturesDoc(missionDir);
      const fIdx = featuresDoc.features.findIndex((f) => f.id === pausedActiveWorker.featureId);
      if (fIdx !== -1) {
        const featureIdentity = {};
        if (identity.taskId) featureIdentity.taskId = identity.taskId;
        if (identity.childThreadId) featureIdentity.childThreadId = identity.childThreadId;
        if (identity.worktreePath) featureIdentity.worktreePath = identity.worktreePath;
        if (identity.childRunId) featureIdentity.childRunId = identity.childRunId;

        featuresDoc.features[fIdx] = resumedRecord({
          ...featuresDoc.features[fIdx],
          ...featureIdentity,
          status: "running",
        });
        saveFeaturesDoc(missionDir, featuresDoc);
      }
    } else {
      if (state.status === "paused") {
        state.status = "running";
        startElapsedClock(state, nowIso);
        state.revision = (state.revision || 1) + 1;
      }
      if (Object.keys(identity).length > 0 && Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((s) =>
          s.runId === pausedActiveWorker.runId ? { ...s, ...identity } : s,
        );
      }
      saveState(missionDir, state);
    }

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "mission_resumed",
      message: "Mission resumed",
      featureId: pausedActiveWorker.featureId,
      workerNumber,
    });

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "worker_resumed",
      message: `Run started: Resume ${featureTitle}`,
      featureId: pausedActiveWorker.featureId,
      workerNumber,
    });

    if (resumeResult && resumeResult.handoff) {
      const currentAfterResume = loadState(missionDir);
      if (currentAfterResume.activeWorker) {
        const endOutcome = endFeatureRun(missionDir, {
          runId: pausedActiveWorker.runId,
          featureId: pausedActiveWorker.featureId,
          ...resumeResult,
        });
        if (endOutcome.shouldReturnToOrchestrator) {
          return loadState(missionDir);
        }
      }
    }

    const postResumeState = loadState(missionDir);
    if (
      (!resumeResult || !resumeResult.handoff) &&
      postResumeState.activeWorker?.status === "running"
    ) {
      return postResumeState;
    }

    if (
      postResumeState.status === "orchestrator_turn" ||
      postResumeState.status === "paused" ||
      postResumeState.status === "completed" ||
      postResumeState.lastHandoffNeedsAttention
    ) {
      return postResumeState;
    }
  } else if (needsResume && state.activeWorker && options?.restartFeature === true) {
    const nowIso = new Date().toISOString();
    const oldFeatureId = state.activeWorker.featureId;
    cleanupLocalWorkerDaemon(state.activeWorker, missionDir);
    state.activeWorker = null;
    state.status = "running";
    startElapsedClock(state, nowIso);
    state.revision = (state.revision || 1) + 1;
    saveState(missionDir, state);

    const featuresDoc = loadFeaturesDoc(missionDir);
    const fIdx = featuresDoc.features.findIndex((f) => f.id === oldFeatureId);
    if (fIdx !== -1 && ["running", "paused"].includes(featuresDoc.features[fIdx].status)) {
      featuresDoc.features[fIdx].status = "pending";
      saveFeaturesDoc(missionDir, featuresDoc);
    }
  } else if (state.status !== "running") {
    const featuresDocBeforeStart = loadFeaturesDoc(missionDir);
    const hasPendingOrRunning =
      featuresDocBeforeStart.features.some((f) =>
        ["pending", "running", "paused"].includes(f.status),
      ) || Boolean(state.activeWorker);
    if (state.status === "completed" && !hasPendingOrRunning) {
      return loadState(missionDir);
    }
    const nowIso = new Date().toISOString();
    state.status = "running";
    startElapsedClock(state, nowIso);
    state.revision = (state.revision || 1) + 1;
    saveState(missionDir, state);
  }

  // Serial feature loop
  while (true) {
    // Check if any milestone just finished its implementation/repair features and needs validators
    checkMilestoneCompletionAndInjectValidation(missionDir);

    state = loadState(missionDir);
    if (
      state.status === "paused" ||
      state.status === "orchestrator_turn" ||
      state.lastHandoffNeedsAttention
    ) {
      return state;
    }

    const featuresDoc = loadFeaturesDoc(missionDir);
    const modelSettings = loadModelSettings(missionDir);

    const nextIdx = featuresDoc.features.findIndex((f) => f.status === "pending");

    if (nextIdx === -1) {
      const anyRunning =
        featuresDoc.features.some((f) => ["running", "paused"].includes(f.status)) ||
        Boolean(state.activeWorker && state.activeWorker.status === "running");

      if (!anyRunning) {
        if (state.status === "completed") {
          return loadState(missionDir);
        }

        const hasValidatorFeatures = featuresDoc.features.some((f) => isValidatorFeature(f));
        const hasFailedValidator = featuresDoc.features.some(
          (f) => isValidatorFeature(f) && f.status === "failed",
        );
        const hasFailedAssertion = (state.assertions || []).some(
          (a) => a.status === "failed" || (hasValidatorFeatures && a.status !== "passed"),
        );
        if (hasFailedAssertion || hasFailedValidator) {
          state.status = "orchestrator_turn";
          state.lastHandoffNeedsAttention = true;
          if (!Array.isArray(state.pendingHandoffItems) || state.pendingHandoffItems.length === 0) {
            state.pendingHandoffItems = [
              {
                id: "mission:validator_failure",
                type: "validator_failure",
                sourceFeatureId: "validator",
                summary: "Validator or assertion failure",
              },
            ];
          }
          cleanupLocalWorkerDaemon(state.activeWorker, missionDir);
          state.activeWorker = null;
          state.revision = (state.revision || 1) + 1;
          saveState(missionDir, state);
          return loadState(missionDir);
        }

        const finishIso = new Date().toISOString();
        if (state.lastStartedAt) {
          const startedMs = Date.parse(state.lastStartedAt);
          const endMs = Date.parse(finishIso);
          if (!Number.isNaN(startedMs) && endMs > startedMs) {
            state.elapsedMs = (state.elapsedMs || 0) + (endMs - startedMs);
          }
        }
        state.lastStartedAt = null;
        state.status = "completed";
        cleanupLocalWorkerDaemon(state.activeWorker, missionDir);
        state.activeWorker = null;
        state.revision = (state.revision || 1) + 1;
        saveState(missionDir, state);

        appendProgressLog(missionDir, {
          timestamp: finishIso,
          type: "mission_completed",
          message: "Mission completed",
          featureId: null,
          workerNumber: null,
        });
      }
      return loadState(missionDir);
    }

    const candidate = featuresDoc.features[nextIdx];
    const maxAttempts = typeof candidate.maxAttempts === "number" ? candidate.maxAttempts : 5;
    const currentAttempts = typeof candidate.attempts === "number" ? candidate.attempts : 0;

    if (currentAttempts >= maxAttempts) {
      const pauseIso = new Date().toISOString();
      state.status = "paused";
      state.lastStartedAt = null;
      state.revision = (state.revision || 1) + 1;
      saveState(missionDir, state);

      appendProgressLog(missionDir, {
        timestamp: pauseIso,
        type: "max_attempts_exceeded",
        message: `Feature ${candidate.id} reached maxAttempts (${maxAttempts}); mission paused awaiting bonus attempts grant`,
        featureId: candidate.id,
        workerNumber: null,
      });

      return loadState(missionDir);
    }

    const dispatched = yield () =>
      dispatchFeatureToWorker(missionDir, candidate, nextIdx, modelSettings, effectiveAdapter);
    if (dispatched.code === "MISSION_NOT_DISPATCHABLE") return dispatched;

    state = loadState(missionDir);

    if (
      state.status === "orchestrator_turn" ||
      state.status === "paused" ||
      state.lastHandoffNeedsAttention
    ) {
      return state;
    }

    // If worker is still active (e.g. async worker launched via delegate_task), return immediately
    if (state.activeWorker && state.activeWorker.status === "running") {
      return state;
    }

    if (state.activeWorker) {
      return state;
    }
  }
}

export function bindFeatureDispatch(dir, input = {}) {
  return commandTransaction(dir, "bindFeatureDispatch", input, () =>
    bindFeatureDispatchImpl(dir, input),
  );
}
function markDispatchPending(dir, ...args) {
  return missionTransaction(dir, () => markDispatchPendingImpl(dir, ...args));
}

export async function settlePausedWorkerResult(dir, ...args) {
  return runMissionSteps(dir, settlePausedWorkerResultSteps(dir, ...args));
}
async function dispatchPreparedWorker(dir, ...args) {
  return runMissionSteps(dir, dispatchPreparedWorkerSteps(dir, ...args));
}
export async function startMissionRun(dir, ...args) {
  return runMissionSteps(dir, startMissionRunSteps(dir, ...args));
}
