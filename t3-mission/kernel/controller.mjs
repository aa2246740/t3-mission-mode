import { commandTransaction, missionTransaction, runMissionSteps, readTransactionFile, writeTransactionFile, transactionHash } from './mission-transaction.mjs';
import path from 'node:path';
import { getMissionPaths } from './store.mjs';
import { digest } from './autopilot-store.mjs';
import { isDeepStrictEqual } from "node:util";
import { MissionKernelError, inferFeatureKind, isValidatorFeature, unwrapMcpResponse, unwrapObservationResponse, classifyControlReceipt, clearDispatchRejection, dispatchReceiptSources, decideDispatchOutcome } from "./schema.mjs";
import { loadState, loadFeaturesDoc, loadModelSettings, saveState, saveFeaturesDoc, appendProgressLog } from "./store.mjs";
import { selectFeatureForWorker, bindFeatureDispatch, resolveFeatureSlot } from "./runner.mjs";
import { prepareDispatch, claimDispatchIntent, inspectDispatchRecords, observeDispatchReceipt, observeDispatchRejection, dispatchRecordOutcome, retainDispatchEvidence, fenceDispatchEvidence, markDispatchInvocationInflight, dispatchRejectionEvidence, dispatchIntentRecords, refreshDispatchReconciliations, createTaskStatusOwnerResolver } from "./dispatch-journal.mjs";
import { checkMilestoneCompletionAndInjectValidation, endFeatureRun } from "./tools.mjs";
import { readController, saveController, archiveObservation, readObservations } from "./autopilot-store.mjs";
import { parseMissionResult, isSha } from "./mission-result.mjs";
import { buildDelegateTask } from "./mission-brief.mjs";
import { recoverTask, providerFailure, retryDeadline, latestCompletion } from "./autopilot-policy.mjs";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const text = value => typeof value === "string" && value.trim().length > 0;
const wait = (gate, reason, message, context = {}) => ({ type: "wait_user", gate, reason, message, ...context });
const decision = (kind, context) => ({ type: "orchestrator_decision", kind, context });
const fail = (code, message) => { throw new MissionKernelError(code, message); };
const globalTypes = new Set(["owner", "timer", "timer_disabled"]);
const handoffInstruction = "For incomplete_work, use UpdateMissionFeatures to insert or rewrite a recover-and-finish task, with resolvesHandoffItemIds linking the pending items. Preserve the original worktree and history. Close already resolved items with DismissHandoffItems and evidence in the justification, then tick again.";

function handoffDecision(state) {
  const latest = new Map((state.sessions ?? []).filter(session => session.endedAt).map(session => [session.featureId, session]));
  const partial = [...latest.values()].reverse().find(session => session.handoff?.successState === "partial" &&
    state.pendingHandoffItems?.some(item => item.sourceFeatureId === session.featureId));
  return decision(partial ? "incomplete_work" : "handoff", { items: state.pendingHandoffItems,
    ...(partial ? { featureId: partial.featureId, result: partial.handoff } : {}), instruction: handoffInstruction });
}

function decisionProgress(missionDir) {
  return { revision: loadState(missionDir).revision,
    observationHash: digest(readObservations(missionDir).filter(row => !["timer", "timer_disabled"].includes(row.observation.type)).map(row => [row.id, digest(row.observation)])) };
}

function waitWithTimer(missionDir, state, ledger, action) {
  const timer = ledger.timer && timerAction(missionDir, state, ledger, true);
  return timer ? { ...timer, nextAction: action } : action;
}

function stalledWait(missionDir, state, ledger) {
  return waitWithTimer(missionDir, state, ledger, wait("STALLED_DECISION", "STALLED_DECISION",
    "The same decision repeated without a new observation or revision. Resolve its cause before ticking again.",
    { originalDecision: ledger.decisionRepeat.action, repeatCount: ledger.decisionRepeat.count }));
}

function integrationResponse(raw, expected = {}) {
  // A blocked report is an owner observation, not a rejected dispatch receipt.
  if (raw?.blocked === true) {
    if (Object.keys(raw).some(key => !["blocked", "reason", "dirtyFiles", "featureId", "runId"].includes(key)) ||
        !text(raw.reason) || !Array.isArray(raw.dirtyFiles) || !raw.dirtyFiles.every(text) ||
        ["featureId", "runId"].some(key => raw[key] !== undefined && raw[key] !== expected[key]))
      fail("INVALID_INTEGRATION_OBSERVATION", "Blocked integration requires a plain reason/dirtyFiles report with matching identity");
    return raw;
  }
  return unwrapObservationResponse(raw, expected);
}

function currentTerminalProof(status, identity) {
  const completion = status && latestCompletion(status);
  return text(status?.taskId) && text(status.childThreadId) &&
    ['taskId', 'childThreadId', 'childRunId'].every(key => !identity[key] || status[key] === identity[key]) &&
    (status.latestTerminalRunId === undefined || (text(status.childRunId) && status.latestTerminalRunId === status.childRunId)) &&
    (!identity.childRunId || !completion.terminalRunId || completion.terminalRunId === identity.childRunId) &&
    terminal.has(status.status) && terminal.has(completion.status) &&
    status.workState === 'result_available' && status.hasPendingChildRuns === false &&
    (status.pendingChildRuns === undefined || (Array.isArray(status.pendingChildRuns) && status.pendingChildRuns.length === 0));
}

function ingestGlobal(missionDir, ledger, state, observation) {
  const response = unwrapObservationResponse(observation.response);
  if (observation.type === "owner") {
    if (!text(response.parentThreadId)) fail("INVALID_OWNER", "Return orchestrator_capabilities.parentThreadId verbatim");
    if (state.ownerThreadId && state.ownerThreadId !== response.parentThreadId) fail("OWNER_CONFLICT", "Mission already belongs to another owner");
    if (!state.ownerThreadId) { state.ownerThreadId = response.parentThreadId; state.revision++; saveState(missionDir, state); }
  } else {
    if (!ledger.timer && observation.type === "timer" && observation.requestId === `mission-timer:${state.missionId}`) ledger.timer = { requestId: observation.requestId, phase: "requested" };
    if (!ledger.timer || observation.requestId !== ledger.timer.requestId) fail("TIMER_IDENTITY_CONFLICT", "Timer response does not match the durable request");
    const task = response.task ?? response.scheduledTask ?? response;
    const ids = dispatchReceiptSources(response, { includeOperationRecords: true }).flatMap(source => [source.scheduledTaskId, source.taskId, source.id]).filter(value => value !== undefined);
    if (!ids.every(text) || new Set(ids).size !== 1) fail("TIMER_IDENTITY_CONFLICT", "Scheduler task identities are invalid or conflicting");
    const id = ids[0];
    if (!text(id)) fail("INVALID_TIMER_RECEIPT", "Scheduler did not confirm a task ID");
    if (ledger.timer.scheduledTaskId && ledger.timer.scheduledTaskId !== id) fail("TIMER_IDENTITY_CONFLICT", "Scheduler returned a different timer");
    if (observation.type === "timer_disabled") {
      if (id !== ledger.timer.scheduledTaskId || task.enabled !== false) fail("INVALID_TIMER_RECEIPT", "Return the scheduler's disabled task record");
      ledger.timer.phase = "disabled";
    } else {
      if (task.enabled !== true || ledger.timer.phase !== "requested") fail("INVALID_TIMER_RECEIPT", "Timer creation is not pending or task is disabled");
      if (ledger.timer.guard && (task.boundThreadId !== state.ownerThreadId || task.schedule?.type !== "once" ||
          Date.parse(task.schedule.runAt) !== ledger.timer.guard.dueAt || Date.parse(task.nextRunAt) !== ledger.timer.guard.dueAt || task.blockedByPolicy))
        fail("INVALID_TIMER_RECEIPT", "The bounded timer receipt must confirm the expected one-shot schedule and owner");
      ledger.timer.scheduledTaskId = id; ledger.timer.phase = "confirmed";
    }
  }
  delete ledger.controlError;
}

function nextBoundedTimer(missionDir, state, ledger, now) {
  const timer = ledger.timer, guard = timer.guard;
  if (now >= guard.deadline || guard.scheduled >= guard.maxWakeups) {
    return wait("timer", "TIMER_WAKE_LIMIT_REACHED", "The bounded timer has no further automatic wakeups. Reconcile the Mission before continuing.", { scheduledTaskId: timer.scheduledTaskId });
  }
  guard.scheduled += 1;
  guard.dueAt = Math.min(now + guard.periodMs, guard.deadline);
  timer.requestId = `mission-timer:${state.missionId}:wake:${guard.scheduled}`;
  timer.phase = "requested";
  saveController(missionDir, ledger);
  const schedule = { type: "once", runAt: new Date(guard.dueAt).toISOString() };
  return { type: "ensure_timer", requestId: timer.requestId, scheduledTaskId: timer.scheduledTaskId,
    updateScheduledTask: { scheduledTaskId: timer.scheduledTaskId, enabled: true, schedule } };
}

function timerAction(missionDir, state, ledger, done = false, now = Date.now()) {
  const timer = ledger.timer;
  if (timer && ledger.timerGuardPolicy && !timer.guard) fail("INVALID_TIMER_GUARD", "A bounded timer is missing its durable guard");
  if (timer?.guard) {
    const guard = timer.guard;
    if (!ledger.timerGuardPolicy || guard.maxWakeups !== ledger.timerGuardPolicy.maxWakeups ||
        !Number.isSafeInteger(guard.maxWakeups) || guard.maxWakeups < 1 || guard.maxWakeups > 12 ||
        !Number.isSafeInteger(guard.scheduled) || guard.scheduled < 1 || guard.scheduled > guard.maxWakeups ||
        !Number.isSafeInteger(guard.periodMs) || guard.periodMs < 1000 ||
        !Number.isSafeInteger(guard.dueAt) || !Number.isSafeInteger(guard.deadline) || guard.dueAt > guard.deadline)
      fail("INVALID_TIMER_GUARD", "The bounded timer guard is malformed");
  }
  if (done && timer?.phase === "disabled") return null;
  if (!done && timer?.phase === "confirmed") {
    const guard = timer.guard;
    if (!guard || now < guard.dueAt) return null;
    return nextBoundedTimer(missionDir, state, ledger, now);
  }
  if (!done && timer?.phase === "disabled") {
    if (timer.guard && now >= timer.guard.dueAt) return nextBoundedTimer(missionDir, state, ledger, now);
    if (timer.guard) timer.requestId = `mission-timer:${state.missionId}:enable:${timer.guard.scheduled}:${(timer.guard.enables = (timer.guard.enables ?? 0) + 1)}`;
    timer.phase = "requested"; saveController(missionDir, ledger);
    return { type: "ensure_timer", requestId: timer.requestId, scheduledTaskId: timer.scheduledTaskId,
      updateScheduledTask: { scheduledTaskId: timer.scheduledTaskId, enabled: true } };
  }
  if (done && timer?.phase === "confirmed") {
    timer.phase = "disable_requested"; saveController(missionDir, ledger);
    return { type: "disable_timer", scheduledTaskId: timer.scheduledTaskId, requestId: timer.requestId, updateScheduledTask: { scheduledTaskId: timer.scheduledTaskId, enabled: false } };
  }
  if (timer) return wait("timer", "TIMER_OUTCOME_UNKNOWN", "Reconcile the original scheduler operation and return its raw receipt; do not create another timer.", { requestId: timer.requestId, scheduledTaskId: timer.scheduledTaskId });
  ledger.timer = { requestId: `mission-timer:${state.missionId}`, phase: "requested" };
  const periodMs = state.timerEveryMs ?? 600000;
  if (ledger.timerGuardPolicy) {
    const deadline = now + periodMs * ledger.timerGuardPolicy.maxWakeups;
    if (!Number.isSafeInteger(deadline) || !Number.isFinite(new Date(deadline).getTime())) fail("INVALID_TIMER_GUARD", "The bounded timer deadline is outside the supported clock range");
    ledger.timer.guard = { maxWakeups: ledger.timerGuardPolicy.maxWakeups, scheduled: 1, periodMs, dueAt: now + periodMs, deadline };
  }
  saveController(missionDir, ledger);
  const schedule = ledger.timer.guard
    ? { type: "once", runAt: new Date(ledger.timer.guard.dueAt).toISOString() }
    : { type: "interval", everyMs: periodMs };
  const prompt = `Execute one MissionTick loop for missionDir=${JSON.stringify(missionDir)}. Execute each returned owner action and submit its raw response. Stop on sleep, wait_user, or done. Never bypass user gates.${ledger.timerGuardPolicy?.wakeInstructions ? `\n\n${ledger.timerGuardPolicy.wakeInstructions}` : ""}`;
  return { type: "ensure_timer", requestId: ledger.timer.requestId, schedule, prompt,
    scheduleTask: { clientRequestId: ledger.timer.requestId, schedule, prompt, bindToCurrentThread: true } };
}

function recoveryAction(state, feature, record, run) {
  return { type: "recover_dispatch", intentId: record.intent.clientRequestId, clientRequestId: record.intent.clientRequestId, featureId: feature.id, runId: record.intent.runId,
    t3ThreadList: { includeSubagents: true, titleContains: record.intent.recovery?.title ?? buildDelegateTask(state, feature, record.intent).title, limit: 100, ...(run?.recoveryCursor ? { cursor: run.recoveryCursor } : {}) },
    recoveryCoordinates: record.intent.recovery ?? { ownerThreadId: state.ownerThreadId, parentThreadId: state.ownerThreadId, clientRequestId: record.intent.clientRequestId },
    ...(!record.intent.recovery ? { diagnostics: [{ code: "LEGACY_RECOVERY_COORDINATES", message: "Intent predates frozen lookup coordinates; using the current owner and title without redispatch authority." }] } : {}),
    instruction: "Call t3_thread_list with these arguments. Return the entire raw page and the request cursor as a children observation. Follow every nextCursor before resolving identity. Never redispatch." };
}

function syncCompensationPause(missionDir, state, record, run, ledger) {
  if (!record?.receipt?.childThreadId) return;
  const epoch = state.pauseEpoch ?? state.pausedAt ?? "legacy";
  const effectId = run.pause?.compensation?.effectId ?? `late-pause:${record.intent.runId}:${epoch}`;
  const file = path.join(getMissionPaths(missionDir).baseDir, '.txn', 'effects', transactionHash(effectId) + '.json');
  const bytes = readTransactionFile(file);
  if (bytes === null) return;
  const effect = JSON.parse(bytes);
  if (effect.runId !== record.intent.runId || ['taskId', 'childThreadId', 'childRunId'].some(key =>
      effect.receipt?.[key] !== record.receipt[key])) return;
  if (run.pause?.epoch !== epoch && run.pause && !run.pause.compensation && run.pause.phase !== "resumed") return;
  if (run.pause?.compensation?.effectId !== effectId) {
    run.pause = { epoch, phase: "interrupt_requested", baselineRunId: record.receipt.childRunId ?? null, compensation: {effectId} };
  }
  if (run.pause.phase === "interrupt_requested" && !run.pause.interruptObservationId && effect.phase === "confirmed")
    run.pause.phase = "interrupted";
  saveController(missionDir, ledger);
}

function controlAction(missionDir, state, record, run, ledger) {
  syncCompensationPause(missionDir, state, record, run, ledger);
  if (state.status === "paused" && state.pauseControl && state.pauseControl.phase !== "confirmed")
    return wait("pause", state.pauseControl.code, "The Pause gate is committed. Reconcile its original control before advancing.");
  if (state.status === "paused" && state.pauseControl?.phase === "confirmed" && state.pauseControl.runId === record?.intent.runId) return null;
  if (run.pause?.compensation && run.pause.phase === "interrupt_requested")
    return wait("pause", "WORKER_CONTROL_OUTCOME_UNKNOWN", "Reconcile the original accepted-child Pause before applying another child control.",
      { controlId: `${record.intent.runId}:${run.pause.epoch}:interrupt`, threadId: record.receipt.childThreadId,
        taskId: record.receipt.taskId, featureId: record.intent.featureId, runId: record.intent.runId,
        clientRequestId: record.intent.clientRequestId, compensation: run.pause.compensation });
  if (run.controlError) return wait("pause", run.controlError.code, run.controlError.message, { controlPhase: run.pause?.phase });
  if (run.pause?.phase === "resume_requested") return wait("pause", "WORKER_CONTROL_OUTCOME_UNKNOWN", "Confirm the original resume before applying another child control.");
  if (!record?.receipt?.childThreadId) return null;
  if (run.pause?.phase === "required") {
    run.pause.phase = "interrupt_requested";
    saveController(missionDir, ledger);
    return { type: "interrupt_worker", threadId: record.receipt.childThreadId, clientRequestId: record.intent.clientRequestId,
      featureId: record.intent.featureId, runId: record.intent.runId, controlId: `${record.intent.runId}:${run.pause.epoch}:interrupt` };
  }
  if ((state.pauseMode ?? "interrupt") === "let_finish" && (!run.pause?.compensation || run.pause.phase === "resumed")) return null;
  const paused = state.status === "paused" || state.activeWorker?.status === "paused";
  if (paused) {
    if (run.pause?.compensation && run.pause.phase === "interrupted") return null;
    const epoch = state.pauseEpoch ?? state.pausedAt ?? "legacy-pause";
    if (run.pause?.epoch === epoch) return run.pause.phase === "interrupt_requested" ? wait("pause", "INTERRUPT_OUTCOME_UNKNOWN", "Reconcile the original interrupt response before resuming.") : null;
    if (run.terminalObservationId && run.lastStatus?.status !== "interrupted") return null;
    run.pause = { epoch, phase: "interrupt_requested", baselineRunId: run.lastStatus?.latestTerminalRunId ?? run.lastStatus?.childRunId ?? null };
    saveController(missionDir, ledger);
    return { type: "interrupt_worker", threadId: record.receipt.childThreadId, clientRequestId: record.intent.clientRequestId, featureId: record.intent.featureId, runId: record.intent.runId, controlId: `${record.intent.runId}:${epoch}:interrupt` };
  }
  if (!run.pause || run.pause.phase === "resumed") return null;
  if (run.pause.phase === "interrupt_requested" || run.pause.phase === "resume_requested") return wait("pause", "WORKER_CONTROL_OUTCOME_UNKNOWN", "Return the original interrupt/resume receipt before advancing.");
  if (run.terminalObservationId && !run.pause.compensation) {
    const completion = latestCompletion(unwrapT3Response(observationById(missionDir, run.terminalObservationId).response));
    try {
      const feature = loadFeaturesDoc(missionDir).features.find(item => item.id === record.intent.featureId);
      parseMissionResult(completion.summary, { feature, runId: record.intent.runId, assertions: state.assertions });
      if (["completed", "failed"].includes(completion.status)) return null;
    } catch { /* The interrupted turn has no consumable result; continue the same child. */ }
  }
  run.pause.phase = "resume_requested";
  run.pause.baselineRunId = run.lastStatus?.latestTerminalRunId ?? run.pause.baselineRunId;
  saveController(missionDir, ledger);
  return { type: "resume_worker", threadId: record.receipt.childThreadId, featureId: record.intent.featureId, runId: record.intent.runId, controlId: `${record.intent.runId}:${run.pause.epoch}:resume`,
    message: `Continue the existing Mission feature ${record.intent.featureId}, run ${record.intent.runId}. Finish the original task and return the required mission-result envelope. Keep the same child and worktree.` };
}

/** Accept plain JSON, MCP structuredContent, or the MCP text JSON representation. */
export function unwrapT3Response(raw, operation = "dispatch", expected = {}) {
  return unwrapMcpResponse(raw, operation, expected);
}

// T3 reports option arrays, whereas the R8 journal compares normalized objects.
function normalizeReceipt(raw) {
  const value = structuredClone(unwrapT3Response(raw));
  const visit = node => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (Array.isArray(node.options)) {
      const entries = node.options;
      if (!entries.every(item => text(item?.id) && ["string", "boolean"].includes(typeof item.value)) || new Set(entries.map(item => item.id)).size !== entries.length)
        fail("INVALID_T3_OBSERVATION", "T3 options have invalid or duplicate IDs");
      node.options = Object.fromEntries(entries.map(item => [item.id, item.value]));
    } else if (node.options === null) node.options = {};
    visit(node.response); visit(node.delegation); visit(node.target);
  };
  visit(value);
  return value;
}

function gateFor(state, feature) {
  if (state.initialized === false || state.planAccepted !== true || state.status === "planning") return wait("plan", "PLAN_ACCEPTANCE_REQUIRED", "Review and approve the Mission plan.");
  if (state.status === "paused" || state.activeWorker?.status === "paused") return wait("pause", "USER_PAUSED", "Mission is paused. Explicitly resume before advancing.");
  if (state.status === "awaiting_input") return wait("input", "AWAITING_INPUT", "Mission needs the user's input.");
  const permission = (state.permissions || []).find(item => item.status !== "approved" && (!item.featureId || item.featureId === feature?.id));
  if (permission) return wait("permission", permission.id, permission.message || permission.reason || "A declared permission needs user approval.", { permission });
  if (state.lastHandoffNeedsAttention && (state.pendingHandoffItems || []).some(item => item.requiresUser === true)) return wait("handoff", "HANDOFF_USER_DECISION", "Resolve the handoff item that requires a user decision.", { items: state.pendingHandoffItems });
  return null;
}

const consumedSession = (state, runId) => (state.sessions || []).some(session => session.runId === runId && session.endedAt && session.handoff?.runId === runId);
function readyToFinish(state, features, records, ledger) {
  if (state.activeWorker || state.lastHandoffNeedsAttention || state.pendingHandoffItems?.length || !features.length || !state.milestones?.length) return false;
  if (features.some(feature => feature.status !== "completed" && !(feature.required === false && feature.status === "cancelled"))) return false;
  if (records.some(record => record.intent.missionId === state.missionId && !consumedSession(state, record.intent.runId))) return false;
  if (Object.entries(ledger.runs).some(([runId, run]) => run.result && !consumedSession(state, runId))) return false;
  if (state.milestones.some(milestone => ["scrutiny", "user_testing"].some(kind => !features.some(feature => feature.milestoneId === milestone.id && inferFeatureKind(feature) === kind && feature.status === "completed" && feature.lastHandoff?.validatorsPassed === true)))) return false;
  if ((state.assertions || []).some(assertion => assertion.stageResults?.scrutiny !== "passed" || assertion.stageResults?.user_testing !== "passed")) return false;
  if (state.milestones.some(milestone => !isSha(milestone.mergeSha) || ["scrutiny", "user_testing"].some(kind => !features.some(feature => feature.milestoneId === milestone.id && inferFeatureKind(feature) === kind && feature.lastHandoff?.testedSha === milestone.mergeSha)))) return false;
  if (state.milestones.some(milestone => milestone.mergeSha !== state.integration?.mergeSha)) return false;
  if ((state.assertions || []).some(assertion => ["scrutiny", "user_testing"].some(kind => assertion.stageTestedSha?.[kind] !== state.milestones.find(m => m.id === assertion.milestoneId)?.mergeSha))) return false;
  return features.filter(feature => ["implementation", "repair"].includes(inferFeatureKind(feature))).every(feature => feature.integration?.runId === feature.runId && isSha(feature.integration.mergeSha));
}

function ingest(missionDir, ledger, state, records, freshIds) {
  const archived = readObservations(missionDir);
  const resolveStatusOwner = createTaskStatusOwnerResolver(records, archived, state.missionId);
  // Replay dispatch identity before task results, even if a process died between archive and ledger.
  const rank = { owner: -2, timer: -1, timer_disabled: -1, dispatch: 0, children: 0, interrupt: 1, resume: 1, task_status: 2, integration: 3 };
  archived.sort((a, b) => rank[a.observation.type] - rank[b.observation.type] || a.sequence - b.sequence);
  for (const { id, observation: observation } of archived) {
    const pendingTimerReceipt = freshIds.has(id) && ((observation.type === "timer" && ledger.timer?.phase === "requested") ||
      (observation.type === "timer_disabled" && ledger.timer?.phase === "disable_requested"));
    const freshBlockedIntegration = freshIds.has(id) && observation.type === "integration" && observation.response?.blocked === true &&
      observation.runId === state.activeWorker?.runId && observation.featureId === state.activeWorker?.featureId;
    const retryConfirmedResume = observation.type === "resume" && ledger.observations[id]?.outcome === "refused" &&
      ledger.runs[observation.runId]?.pause?.phase === "resume_requested" &&
      (() => {
        const rec = records.find(item => item.intent.runId === observation.runId && item.intent.featureId === observation.featureId);
        return rec && classifyControlReceipt(observation.response, "resume", rec.receipt ?? rec.intent.worker).classification === "confirmed";
      })();
    if (ledger.observations[id] && !pendingTimerReceipt && !freshBlockedIntegration && !retryConfirmedResume && !(observation.type === "task_status" && freshIds.has(id) && !consumedSession(state, observation.runId))) continue;
    if (globalTypes.has(observation.type)) {
      try { ingestGlobal(missionDir, ledger, state, observation); ledger.observations[id] = { outcome: "applied" }; }
      catch (error) {
        if (!(error instanceof MissionKernelError)) throw error;
        ledger.controlError = { code: error.code, message: error.message }; ledger.observations[id] = { outcome: "refused", code: error.code };
      }
      continue;
    }
    let record;
    try {
      record = observation.type === 'task_status' ? resolveStatusOwner(observation) :
        records.find(item => item.intent.missionId === state.missionId && item.intent.runId === observation.runId && item.intent.featureId === observation.featureId);
    } catch (error) {
      if (!['TASK_STATUS_OWNERSHIP_AMBIGUOUS', 'TASK_STATUS_OWNERSHIP_UNRESOLVED'].includes(error.code)) throw error;
      ledger.observations[id] = { outcome: "unattributed", code: error.code, message: error.message, details: error.details };
      // The rolling progress slot may be replaced; retain its unowned raw status.
      appendProgressLog(missionDir, { type: "task_status_unattributed", featureId: observation.featureId,
        message: error.message, details: { observationId: id, code: error.code, ownership: error.details, observation } });
      continue;
    }
    const consumed = consumedSession(state, observation.runId);
    if (!record || record.historical || consumed || (observation.intentId && observation.intentId !== record.intent.clientRequestId)) {
      ledger.observations[id] = { outcome: "stale", runId: observation.runId };
      continue;
    }
    const intent = record.intent;
    const run = ledger.runs[intent.runId] ??= { featureId: intent.featureId, intentId: intent.clientRequestId };
    try {
      if (["dispatch", "children"].includes(observation.type)) {
        if (observation.intentId !== intent.clientRequestId) fail("DISPATCH_INTENT_CONFLICT", "Observation intentId does not match");
        let receipt = observation.response;
        if (observation.type === "dispatch") {
          const verdict = retainDispatchEvidence(missionDir, intent, receipt, observation.invocationId);
          run.dispatchDecision = verdict;
          run.dispatchControlReceipt = verdict.controlReceipt;
          const classification = verdict.outcome === "NOT_ACCEPTED" ? { kind: "not_accepted", message: verdict.reason, provider: { kind: verdict.providerFailureClass, message: verdict.reason } } : { kind: "acceptance_unknown" };
          if (verdict.outcome === "CONFLICT")
            throw new MissionKernelError(verdict.errorCode, "Dispatch receipt conflicts with the original intent", { controlReceipt: verdict.controlReceipt, dispatchDecision: verdict });
          if (verdict.outcome === "UNKNOWN") {
            clearDispatchRejection(run);
            run.failure = classification;
            delete run.dispatchError;
            ledger.observations[id] = { outcome: "unknown", runId: intent.runId };
            continue;
          }
          if (verdict.outcome === "NOT_ACCEPTED") {
            observeDispatchRejection(missionDir, intent, receipt);
            run.failure = classification;
            run.rejectedObservationId = id; delete run.dispatchError;
            ledger.observations[id] = { outcome: "applied", runId: intent.runId };
            continue;
          }
          receipt = verdict.identity;
        } else receipt = unwrapObservationResponse(receipt, {}, { allowList: true });
        if (observation.type === "children") {
          const children = Array.isArray(receipt) ? receipt : receipt.tasks ?? receipt.threads;
          if (!Array.isArray(children)) fail("INVALID_RECOVERY_LIST", "Expected the original owner's raw tasks or threads list");
          if ((observation.cursor ?? null) !== (run.recoveryCursor ?? null)) fail("INVALID_RECOVERY_PAGE", "Recovery page does not match the requested cursor");
          run.recoveryPages ??= [];
          run.recoveryPages.push(receipt);
          if (receipt.nextCursor) {
            if (!text(receipt.nextCursor) || (run.recoveryCursors ?? []).includes(receipt.nextCursor)) fail("INVALID_RECOVERY_PAGE", "Repeated or invalid nextCursor");
            (run.recoveryCursors ??= []).push(receipt.nextCursor);
            run.recoveryCursor = receipt.nextCursor;
            ledger.observations[id] = { outcome: "applied", runId: intent.runId };
            continue;
          }
          receipt = recoverTask(run.recoveryPages, intent, intent.recovery?.parentThreadId ?? state.ownerThreadId);
          delete run.recoveryCursor;
        }
        const merged = retainDispatchEvidence(missionDir, intent, normalizeReceipt(receipt));
        if (merged.outcome === "CONFLICT") throw new MissionKernelError(merged.errorCode, "Recovery identity conflicts with durable dispatch evidence", { dispatchDecision: merged });
        observeDispatchReceipt(missionDir, intent, normalizeReceipt(merged.identity ?? receipt));
        if (record.phase !== "accepted" && state.status === "paused" && !run.pause) {
          run.pause = { epoch: state.pauseEpoch ?? state.pausedAt ?? "legacy", phase: "required",
            baselineRunId: (merged.identity ?? receipt).childRunId ?? null, compensation: {} };
        }
        clearDispatchRejection(run);
        run.dispatchDecision = merged;
        delete run.dispatchError;
      } else if (["interrupt", "resume"].includes(observation.type)) {
        const verdict = classifyControlReceipt(observation.response, observation.type, record.receipt ?? intent.worker);
        run.controlReceipt = verdict;
        const phase = observation.type === "interrupt" ? "interrupt_requested" : "resume_requested";
        const compensationConfirmation = observation.type === "interrupt" && run.pause?.compensation &&
          ["interrupted", "resume_requested", "resumed"].includes(run.pause.phase);
        if (!run.pause || (run.pause.phase !== phase && !compensationConfirmation) || observation.controlId !== `${intent.runId}:${run.pause.epoch}:${observation.type}` || verdict.classification !== "confirmed")
          throw new MissionKernelError("INVALID_WORKER_CONTROL_RECEIPT", "Return the original successful child control response with matching controlId and identity", { controlReceipt: verdict });
        if (!compensationConfirmation) run.pause.phase = observation.type === "interrupt" ? "interrupted" : "resumed";
        run.pause[`${observation.type}ObservationId`] = id;
        if (observation.type === "resume") {
          if (text(verdict.identity?.taskId) && verdict.identity.taskId !== (record.receipt ?? intent.worker)?.taskId) {
            run.pause.resumeTaskId = verdict.identity.taskId;
          }
          delete run.terminalObservationId; delete run.result;
        }
        delete run.controlError;
        delete run.statusError;
      } else if (observation.type === "task_status") {
        const current = inspectDispatchRecords(missionDir).find(item => item.intent.runId === intent.runId);
        const resumeTaskId = run.pause?.phase === "resumed" && text(run.pause?.resumeTaskId) ? run.pause.resumeTaskId : null;
        const expectedTaskId = resumeTaskId && (observation.taskId === resumeTaskId || dispatchReceiptSources(observation.response).some(source => source.taskId === resumeTaskId))
          ? resumeTaskId : current?.receipt?.taskId;
        const status = unwrapObservationResponse(observation.response, { taskId: expectedTaskId, childThreadId: current?.receipt?.childThreadId });
        if (!current?.receipt?.taskId) continue; // Receipt observation may arrive on a later tick.
        if (observation.taskId !== expectedTaskId || status.taskId !== expectedTaskId) fail("TASK_IDENTITY_CONFLICT", "Status does not identify the accepted task");
        for (const key of ["childThreadId"])
          if (current.receipt[key] && status[key] !== current.receipt[key]) fail("TASK_IDENTITY_CONFLICT", `Status ${key} does not match the accepted task`);
        if (current.receipt.childRunId && status.childRunId !== current.receipt.childRunId && run.pause?.phase !== "resumed") fail("TASK_IDENTITY_CONFLICT", "Status childRunId changed without an acknowledged resume");
        const normalized = normalizeReceipt(status);
        for (const key of ["providerInstanceId", "model", "options"])
          if (normalized[key] !== undefined && !isDeepStrictEqual(normalized[key], intent.target[key])) fail("DISPATCH_TARGET_CONFLICT", `Status ${key} differs from the original target`);
        if (!["queued", "running", "waiting", ...terminal].includes(status.status) || !["working", "waiting_for_children", "result_available"].includes(status.workState) || typeof status.hasPendingChildRuns !== "boolean") fail("INVALID_TASK_STATUS", "T3 status, workState, and hasPendingChildRuns are required");
        const oldWorking = run.terminalObservationId && !terminal.has(status.status) && status.workState === "working" &&
          status.hasPendingChildRuns === false && !status.pendingChildRuns?.length &&
          text(status.childRunId) && status.childRunId === run.lastStatus?.childRunId;
        const resumeSequence = archived.find(row => row.id === run.pause?.resumeObservationId)?.sequence;
        const oldTerminal = run.pause?.phase === "resumed" && text(status.latestTerminalRunId) && archived.some(row =>
          row.sequence < resumeSequence && ledger.observations[row.id]?.outcome === "applied" && row.observation.type === "task_status" && row.observation.runId === intent.runId && [current.receipt.taskId, resumeTaskId].filter(Boolean).includes(row.observation.taskId) &&
          dispatchReceiptSources(row.observation.response).some(source => source.latestTerminalRunId === status.latestTerminalRunId));
        if (!oldWorking && !oldTerminal) {
          run.lastStatus = { observationId: id, ...status };
          delete run.terminalObservationId;
          const resumedTerminal = run.pause?.phase !== "resumed" || (text(status.latestTerminalRunId) && status.latestTerminalRunId !== run.pause.baselineRunId);
          if (resumedTerminal && terminal.has(status.status) && terminal.has(latestCompletion(status).status) && status.workState === "result_available" && status.hasPendingChildRuns === false && (!status.pendingChildRuns || (Array.isArray(status.pendingChildRuns) && status.pendingChildRuns.length === 0))) run.terminalObservationId = id;
        }
        delete run.statusError;
      } else {
        integrationResponse(observation.response, {featureId: intent.featureId, runId: intent.runId});
        run.integrationObservationId = id;
      }
      ledger.observations[id] = { outcome: "applied", runId: intent.runId };
    } catch (error) {
      if (!(error instanceof MissionKernelError)) throw error;
      run[["interrupt", "resume"].includes(observation.type) ? "controlError" : observation.type === "task_status" ? "statusError" : "dispatchError"] = { code: error.code, message: error.message, observationId: id, ...(error.details?.controlReceipt ? { controlReceipt: error.details.controlReceipt } : {}) };
      ledger.observations[id] = { outcome: "refused", runId: intent.runId, code: error.code };
    }
  }
  saveController(missionDir, ledger);
}

function validateTaskResult(state, feature, runId, completion, pause) {
  const parsed = parseMissionResult(completion.summary, { feature, runId, assertions: state.assertions });
  const resumedLatest = pause?.phase === "resumed" && completion.terminalRunId && completion.terminalRunId !== pause.baselineRunId && !completion.latestTerminalStatus;
  if (completion.status !== "completed" && parsed.envelope.status === "success" && !resumedLatest) fail("RESULT_STATUS_CONFLICT", "T3 failure cannot be consumed as envelope success");
  if (isValidatorFeature(feature)) {
    const expected = state.milestones.find(item => item.id === feature.milestoneId)?.mergeSha;
    if (!isSha(expected) || parsed.envelope.testedSha !== expected) fail("VALIDATION_SHA_MISMATCH", `Validator testedSha must equal the current milestone mergeSha ${expected}`);
  }
  return parsed;
}

function reconcileLateExecution(missionDir, state, records, ledger) {
  refreshDispatchReconciliations(missionDir, state, records, ledger);
  const intents = dispatchIntentRecords(records);
  let pendingAction = null;
  for (const gate of Object.values(ledger.dispatchReconciliations ?? {}).filter(row => !row.resolutionId)) {
    const record = intents.find(item => item.intent.clientRequestId === gate.intentId);
    const action = record ? reconcileLateIntent(missionDir, state, record, ledger, gate) :
      wait("dispatch", "DISPATCH_RECONCILIATION_MISSING", "Return the original intent and task evidence.");
    pendingAction ??= action;
  }
  return pendingAction;
}

function reconcileLateIntent(missionDir, state, record, ledger, gate) {
  const intent = record.intent;
  const archived = readObservations(missionDir).filter(({ observation: o }) => o.runId === intent.runId && o.featureId === intent.featureId);
  const outcome = dispatchRecordOutcome(missionDir, record);
  const conflict = code => wait("dispatch", code, "Collect current terminal proof for every original execution; selection records an audit result only.", {
    intentId: gate.intentId, recovery: { command: "MissionTick.dispatchResolution", requiresUserSelection: true,
      terminalObservationIds: archived.filter(row => row.observation.type === "task_status").map(row => row.id),
      instruction: "Submit intentId, terminalObservationIds, selectedTaskId, selectedChildThreadId, reason and userConfirmed:true. Running tasks cannot be force-cleared. No late result will be merged or adopted." }
  });
  let receipt = outcome.outcome === "ACCEPTED" ? outcome.identity : record.receipt;
  const pages = archived.filter(({ observation: o }) => o.type === "children" && o.intentId === intent.clientRequestId);
  if (pages.length) {
    let collected = [], cursor = null;
    try {
      for (const { observation: o } of pages) {
        if (!o.cursor) { collected = []; cursor = null; }
        if ((o.cursor ?? null) !== cursor) fail("INVALID_RECOVERY_PAGE", "Recovery page does not match the requested cursor");
        const page = unwrapObservationResponse(o.response, {}, { allowList: true });
        collected.push(page); cursor = page.nextCursor ?? null;
      }
      if (cursor) return recoveryAction(state, intent.feature, record, { recoveryCursor: cursor });
      receipt = normalizeReceipt(recoverTask(collected, intent, intent.recovery?.parentThreadId ?? state.ownerThreadId));
    } catch (error) {
      if (!(error instanceof MissionKernelError)) throw error;
      return conflict(error.code);
    }
  }
  if (outcome.outcome === "CONFLICT") return conflict(outcome.errorCode);
  if (!receipt?.taskId || !receipt.childThreadId) return recoveryAction(state, intent.feature, record);
  if (!record.historical && record.phase !== "accepted") {
    observeDispatchReceipt(missionDir, intent, receipt);
    refreshDispatchReconciliations(missionDir, state, inspectDispatchRecords(missionDir), ledger);
  }
  const poll = { type: "poll", taskId: receipt.taskId, featureId: intent.featureId, runId: intent.runId, reconciliation: true, intentId: intent.clientRequestId };
  const resolveStatusOwner = createTaskStatusOwnerResolver(inspectDispatchRecords(missionDir), archived, state.missionId);
  let latest;
  for (const row of archived.filter(({observation: o}) => o.type === 'task_status' && o.taskId === receipt.taskId)) {
    try { if (resolveStatusOwner(row.observation).intent.clientRequestId === intent.clientRequestId) latest = row; }
    catch (error) {
      if (!['TASK_STATUS_OWNERSHIP_AMBIGUOUS', 'TASK_STATUS_OWNERSHIP_UNRESOLVED'].includes(error.code)) throw error;
    }
  }
  if (!latest) return poll;
  let status;
  try { status = unwrapObservationResponse(latest.observation.response, { taskId: receipt.taskId, childThreadId: receipt.childThreadId }); }
  catch (error) { if (!(error instanceof MissionKernelError)) throw error; return conflict(error.code); }
  try {
    const normalized = normalizeReceipt(status);
    if (["providerInstanceId", "model", "options"].some(key => normalized[key] !== undefined && !isDeepStrictEqual(normalized[key], intent.target[key]))) return conflict("DISPATCH_TARGET_CONFLICT");
  } catch (error) { if (!(error instanceof MissionKernelError)) throw error; return conflict(error.code); }
  const completion = latestCompletion(status);
  if (!currentTerminalProof(status, receipt)) return poll;
  const resolutionId = `late:${intent.clientRequestId}:${latest.id}`;
  if (!(ledger.dispatchResolutions ??= {})[resolutionId]) {
    let result, validationError;
    if (completion.status === "completed") {
      try { result = validateTaskResult(state, loadFeaturesDoc(missionDir).features.find(row => row.id === intent.featureId) ?? intent.feature, intent.runId, completion); }
      catch (error) { if (!(error instanceof MissionKernelError)) throw error; validationError = { code: error.code, message: error.message }; }
    }
    const refusalIds = archived.filter(({ observation: o }) => o.type === "dispatch" && o.intentId === intent.clientRequestId && decideDispatchOutcome(o.response, { expectedIdentity: intent }).outcome === "NOT_ACCEPTED").map(row => row.id);
    const resolution = { resolutionId, intentId: intent.clientRequestId, featureId: intent.featureId, runId: intent.runId,
      rejectionObservationId: gate.rejectionObservationId ?? refusalIds[0], refusalEvidenceIds: refusalIds, acceptedEvidenceIds: [...gate.evidenceIds],
      terminalObservationId: latest.id, terminalStatus: completion.status, receipt, response: latest.observation.response,
      ...(result ? { result } : {}), ...(validationError ? { validationError } : {}) };
    ledger.dispatchResolutions[resolutionId] = resolution;
    appendProgressLog(missionDir, { type: "late_execution_resolved", featureId: intent.featureId, details: resolution, message: "Original execution stopped. Its result is retained for audit; normal attempt budgets still apply." });
  }
  gate.resolutionId = resolutionId;
  saveController(missionDir, ledger);
  return null;
}

function observationById(missionDir, id) {
  return readObservations(missionDir).find(item => item.id === id)?.observation;
}

function integrationAction(missionDir, state, feature, run, ledger) {
  const envelope = run.result.envelope;
  if (!run.integration && run.integrationObservationId) {
    const raw = observationById(missionDir, run.integrationObservationId);
    const observed = integrationResponse(raw.response, { featureId: feature.id, runId: feature.runId });
    if (observed.blocked !== true) {
      const fullCommit = typeof observed.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(observed.commit);
      const exactLegacy = observed.commit === envelope.commit && observed.mergeSha === envelope.commit && observed.sourceBranch === envelope.branch;
      const resolvedFull = fullCommit && observed.commit === observed.mergeSha && observed.commit.toLowerCase().startsWith(envelope.commit.toLowerCase());
      if (!text(observed.branch) || (state.integration?.branch && observed.branch !== state.integration.branch) || !text(observed.sourceBranch) ||
          !isSha(observed.mergeSha) || !(resolvedFull || (!ledger.timer?.guard && exactLegacy)))
        return decision("integration_conflict", { featureId: feature.id, runId: feature.runId, expected: { branch: state.integration?.branch, commit: envelope.commit, sourceBranch: envelope.branch }, observed });
      if (state.integration?.auto !== true && observed.approved !== true) return wait("merge", "MERGE_APPROVAL_REQUIRED", "Approve integration of this exact feature commit before recording the merge.", { featureId: feature.id, runId: feature.runId, commit: envelope.commit });
      run.integration = { runId: feature.runId, branch: observed.branch, sourceBranch: observed.sourceBranch, commit: observed.commit, mergeSha: observed.mergeSha };
      saveController(missionDir, ledger);
    }
  }
  if (run.integration) {
    const doc = loadFeaturesDoc(missionDir);
    const current = doc.features.find(item => item.id === feature.id);
    if (!isDeepStrictEqual(current.integration, run.integration)) {
      current.integration = run.integration;
      saveFeaturesDoc(missionDir, doc);
    }
    recordMilestoneIntegration(missionDir, feature, run.integration);
    return null;
  }
  const context = { featureId: feature.id, runId: feature.runId, branch: state.integration?.branch ?? null, sourceBranch: envelope.branch, commit: envelope.commit };
  if (state.integration?.auto !== true) return wait("merge", "MERGE_APPROVAL_REQUIRED", "Approve the target branch and this exact feature commit for integration.", context);
  return decision("integrate", { ...context, instruction: 'Resolve the reported commit uniquely with Git and verify it equals the actual source HEAD. Fast-forward that full commit into the declared integration branch. Return an integration observation containing branch, sourceBranch, full commit and full mergeSha. If unknown dirty files or conflicts block integration, preserve them and report {type:"integration",featureId,runId,response:{blocked:true,reason,dirtyFiles:[...]}}. Never push or deploy.' });
}

function recordMilestoneIntegration(missionDir, feature, integration) {
  const state = loadState(missionDir), doc = loadFeaturesDoc(missionDir);
  if (state.integration?.mergeSha === integration.mergeSha && state.milestones.every(milestone => milestone.mergeSha === integration.mergeSha)) return;
  state.integration = { ...state.integration, branch: integration.branch, auto: state.integration?.auto ?? false, mergeSha: integration.mergeSha };
  // This plan has one shared integration branch. Every prior stage must test its new head.
  for (const milestone of state.milestones) {
    milestone.mergeSha = integration.mergeSha;
    milestone.integrationRunId = feature.runId;
  }
  for (const assertion of state.assertions) {
    for (const kind of ["scrutiny", "user_testing"]) {
      if (assertion.stageResults?.[kind]) assertion.stageResults[kind] = "stale";
    }
    assertion.status = "pending";
  }
  let changed = false;
  for (const validator of doc.features.filter(isValidatorFeature)) {
    if (validator.lastHandoff || validator.status === "completed" || validator.status === "failed") {
      validator.staleHandoff = validator.lastHandoff;
      validator.lastHandoff = null; validator.status = "pending"; validator.validationState = "stale";
      changed = true;
    }
  }
  // Features first: a crash before the state write repeats this invalidation safely.
  if (changed) saveFeaturesDoc(missionDir, doc);
  state.revision++; saveState(missionDir, state);
}

function recordProviderFailure(missionDir, state, feature, run, ledger, failure, completion, now) {
  if (run.providerFailure) return;
  const budget = (ledger.features ??= {})[feature.id] ??= { providerErrors: 0 };
  budget.providerErrors++;
  ledger.consecutiveProviderErrors = (ledger.consecutiveProviderErrors ?? 0) + 1;
  budget.nextRetryAt = retryDeadline(completion, now, budget.providerErrors, state.retryPolicy);
  const role = isValidatorFeature(feature) ? "validator" : "worker";
  const prior = new Set((budget.switches ?? []).map(item => JSON.stringify(item.to)));
  const current = { providerInstanceId: state.activeWorker.providerInstanceId, model: state.activeWorker.model, options: state.activeWorker.options };
  const fallback = (state.fallbackTargets?.[role] ?? []).find(target => !isDeepStrictEqual(target, current) && !prior.has(JSON.stringify(target)));
  if (fallback) {
    budget.target = structuredClone(fallback);
    budget.approvalEpoch = state.planApprovalEpoch ?? 0;
    (budget.switches ??= []).push({ from: current, to: fallback, reason: failure.message, runId: feature.runId, approvalEpoch: budget.approvalEpoch });
  }
  if (failure.kind === "provider_auth" && !fallback) {
    budget.blocked = "PROVIDER_AUTH_REQUIRED";
    budget.authBlock = { code: budget.blocked, target: structuredClone(current), approvalEpoch: state.planApprovalEpoch ?? 0, runId: feature.runId };
  }
  run.providerFailure = { ...failure, nextRetryAt: budget.nextRetryAt };
  saveController(missionDir, ledger);
}

function failureEnvelope(provider) {
  return { status: "failure", summary: `The provider failed before producing a consumable Mission result. ${provider.message}`, tests: [], discoveredIssues: [], whatWasLeftUndone: [], commit: null, branch: null };
}

function consumeDispatchFailure(missionDir, state, feature, run, ledger, record, now) {
  const proof = dispatchRejectionEvidence(missionDir, record);
  if (!proof) fail("DISPATCH_OUTCOME_UNKNOWN", "Every invocation must prove its own nonacceptance");
  const verdict = dispatchRecordOutcome(missionDir, record);
  const candidates = proof.flatMap(row => row.receipts).map(({ raw }) => ({ raw, decision: decideDispatchOutcome(raw, { expectedIdentity: record.intent, operation: record.controlOperation ?? "dispatch" }), completion: latestCompletion(raw) }));
  const selected = candidates.find(row => row.decision.providerFailureClass === "provider_auth") ?? candidates.find(row => row.decision.providerFailureClass === "provider_rate") ?? candidates[0];
  const failure = selected?.decision ?? verdict;
  const provider = { kind: failure.providerFailureClass, message: failure.reason };
  const failures = (ledger.features?.[feature.id]?.providerErrors ?? 0) + 1;
  const completion = candidates.reduce((latest, row) => !latest || retryDeadline(row.completion, now, failures, state.retryPolicy) > retryDeadline(latest, now, failures, state.retryPolicy) ? row.completion : latest, null);
  recordProviderFailure(missionDir, state, feature, run, ledger, provider, completion, now);
  run.result = { observationId: run.rejectedObservationId, rejectionEvidence: proof, envelope: failureEnvelope(provider) };
  return provider;
}

/** One owner executes actions. No T3 transport, Git command, HUD, or timer runs inside this function. */
function* missionTickSteps(missionDir, { observations = [], now = Date.now(), timerMaxWakeups, timerWakeInstructions } = {}) {
  if (!Array.isArray(observations)) fail("INVALID_OBSERVATIONS", "observations must be an array");
  if (!Number.isFinite(now)) fail("INVALID_CLOCK", "now must be a finite epoch in milliseconds");
  for (const observation of observations) {
    if (!observation || ![...globalTypes, "dispatch", "children", "task_status", "integration", "interrupt", "resume"].includes(observation.type) || (!globalTypes.has(observation.type) && (!text(observation.runId) || !text(observation.featureId))) || !Object.hasOwn(observation, "response")) fail("INVALID_OBSERVATIONS", "Each observation needs type, run identity (unless global), and the original response");
  }
  let state = loadState(missionDir);
  let ledger = readController(missionDir, state.missionId);
  if (timerMaxWakeups !== undefined || timerWakeInstructions !== undefined) {
    if (timerMaxWakeups !== undefined && (!Number.isSafeInteger(timerMaxWakeups) || timerMaxWakeups < 1 || timerMaxWakeups > 12)) fail("INVALID_TIMER_GUARD", "timerMaxWakeups must be an integer between 1 and 12");
    if (timerWakeInstructions !== undefined && (!text(timerWakeInstructions) || timerWakeInstructions.length > 4000 || /[\u0000-\u0008\u000b-\u001f]/u.test(timerWakeInstructions))) fail("INVALID_TIMER_GUARD", "timerWakeInstructions must be bounded plain text");
    if (ledger.timerGuardPolicy && ((timerMaxWakeups !== undefined && ledger.timerGuardPolicy.maxWakeups !== timerMaxWakeups) ||
        (timerWakeInstructions !== undefined && ledger.timerGuardPolicy.wakeInstructions !== timerWakeInstructions))) fail("TIMER_GUARD_LOCKED", "The bounded timer policy cannot change during this Mission");
    if (!ledger.timerGuardPolicy) {
      if (timerMaxWakeups === undefined || ledger.timer || state.planAccepted !== true || state.activeWorker) fail("TIMER_GUARD_TOO_LATE", "Set a bounded timer only on an approved Mission before its first timer or worker");
      ledger.timerGuardPolicy = { maxWakeups: timerMaxWakeups, ...(timerWakeInstructions === undefined ? {} : { wakeInstructions: timerWakeInstructions }) };
      saveController(missionDir, ledger);
    }
  }
  const result = (action, controlWaiting = false) => {
    if (action.type === "orchestrator_decision" || controlWaiting) {
      const progress = decisionProgress(missionDir), previous = ledger.decisionRepeat;
      const progressChanged = previous && (previous.revision !== progress.revision || previous.observationHash !== progress.observationHash);
      const same = previous && !progressChanged && digest(previous.action) === digest(action);
      const maximum = loadState(missionDir).retryPolicy?.maxStalledDecisionRepeats ?? 3;
      if (controlWaiting && ["requested", "disable_requested"].includes(ledger.timer?.phase)) {
        action = { ...timerAction(missionDir, state, ledger, false, now), nextAction: action };
      } else if (controlWaiting && progressChanged && ledger.timer?.phase === "disabled" && state.status !== "paused") {
        delete ledger.decisionRepeat; saveController(missionDir, ledger);
        action = { ...timerAction(missionDir, state, ledger, false, now), nextAction: action };
      } else {
        ledger.decisionRepeat = { ...progress, action, count: same ? Math.min(previous.count + 1, maximum) : 1 };
        saveController(missionDir, ledger);
        if (ledger.decisionRepeat.count >= maximum && (controlWaiting || same)) action = stalledWait(missionDir, state, ledger);
      }
    }
    return { action, missionId: state.missionId, revision: loadState(missionDir).revision };
  };
  const freshIds = new Set(observations.map(observation => archiveObservation(missionDir, observation)));
  let records = inspectDispatchRecords(missionDir);
  const activeRecord = records.find(item => item.intent.runId === state.activeWorker?.runId);
  if (activeRecord) {
    const activeRun = ledger.runs[activeRecord.intent.runId] ??= { featureId: activeRecord.intent.featureId, intentId: activeRecord.intent.clientRequestId };
    syncCompensationPause(missionDir, state, activeRecord, activeRun, ledger);
  }
  const hasPendingResumeUpgrade = readObservations(missionDir).some(({ id, observation }) =>
    observation.type === "resume" && ledger.observations[id]?.outcome === "refused" && ledger.runs[observation.runId]?.pause?.phase === "resume_requested");
  if (observations.length || hasPendingResumeUpgrade || readObservations(missionDir).some(item => !ledger.observations[item.id])) ingest(missionDir, ledger, state, records, freshIds);

  // Accepted receipts survive Pause/Reject. Projection binding obeys current approval.
  state = loadState(missionDir);
  let active = state.activeWorker;
  records = inspectDispatchRecords(missionDir);
  let record = records.find(item => item.intent.runId === active?.runId);
  const run = active && (ledger.runs[active.runId] ??= { featureId: active.featureId, intentId: record?.intent.clientRequestId });
  if (record) {
    const merged = dispatchRecordOutcome(missionDir, record);
    if (merged.outcome === "ACCEPTED") {
      if (record.phase !== "accepted" && merged.identity.taskId && merged.identity.childThreadId) {
        observeDispatchReceipt(missionDir, record.intent, merged.identity);
        record = inspectDispatchRecords(missionDir).find(item => item.intent.clientRequestId === record.intent.clientRequestId);
      }
      const stale = run.rejectedObservationId || run.dispatchDecision?.outcome !== "ACCEPTED";
      clearDispatchRejection(run);
      if (stale) run.dispatchDecision = merged;
      delete run.dispatchError;
    } else if (merged.outcome === "NOT_ACCEPTED") {
      run.dispatchDecision = merged;
      run.failure = { kind: "not_accepted", provider: { kind: merged.providerFailureClass, message: merged.reason } };
    } else if (merged.outcome === "CONFLICT") {
      clearDispatchRejection(run);
      run.dispatchDecision = merged;
      if (run.dispatchError?.code !== "DISPATCH_RECOVERY_AMBIGUOUS") run.dispatchError = { code: merged.errorCode, message: "Durable dispatch identities conflict", diagnostics: merged.diagnostics };
      fenceDispatchEvidence(missionDir, record.intent);
      record = inspectDispatchRecords(missionDir).find(item => item.intent.clientRequestId === record.intent.clientRequestId);
    } else if (merged.outcome === "UNKNOWN" && merged.hasDurableEvidence) {
      const stale = run.rejectedObservationId || run.dispatchDecision?.outcome !== "UNKNOWN";
      if (stale) { clearDispatchRejection(run); run.failure = { kind: "acceptance_unknown" }; run.dispatchDecision = merged; }
      fenceDispatchEvidence(missionDir, record.intent);
      record = inspectDispatchRecords(missionDir).find(item => item.intent.clientRequestId === record.intent.clientRequestId);
    }
    saveController(missionDir, ledger);
  }
  if (record?.phase === "accepted" && state.planAccepted && ["running", "paused"].includes(state.status) && !run?.dispatchError) {
    try {
      bindFeatureDispatch(missionDir, { ...record.receipt, featureId: record.intent.featureId, runId: record.intent.runId, expectedRevision: state.revision, runtimeTransport: "t3-delegate-task", target: record.intent.target });
    } catch (error) {
      if (!(error instanceof MissionKernelError)) throw error;
      return result(wait("dispatch", error.code, error.message));
    }
  }
  state = loadState(missionDir);
  let doc = loadFeaturesDoc(missionDir);
  let feature = doc.features.find(item => item.id === state.activeWorker?.featureId);
  const lateAction = reconcileLateExecution(missionDir, state, records, ledger);
  if (lateAction) return result(lateAction);
  state = loadState(missionDir); doc = loadFeaturesDoc(missionDir);
  feature = doc.features.find(item => item.id === state.activeWorker?.featureId);
  let gate = gateFor(state, feature);
  if (!gate && !ledger.controlError && state.ownerThreadId && run?.integrationObservationId && !run.integration && ledger.observations[run.integrationObservationId]?.outcome !== "reported") {
    const blocked = integrationResponse(observationById(missionDir, run.integrationObservationId).response, {featureId: feature.id, runId: feature.runId});
    if (blocked.blocked === true) {
      if (ledger.decisionRepeat) { delete ledger.decisionRepeat; saveController(missionDir, ledger); }
      const action = waitWithTimer(missionDir, state, ledger, wait("INTEGRATION_BLOCKED", "INTEGRATION_BLOCKED", blocked.reason,
        { featureId: feature.id, runId: feature.runId, dirtyFiles: blocked.dirtyFiles, instruction: "Preserve unknown changes. After the user resolves the obstruction, tick again to retry integration." }));
      if (action.type === "wait_user") { ledger.observations[run.integrationObservationId].outcome = "reported"; saveController(missionDir, ledger); }
      return result(action);
    }
  }
  if (state.planAccepted && ["running", "paused", "orchestrator_turn"].includes(state.status) && active && run && (gate?.gate === "pause" || (!gate && !run.dispatchError && (!run.statusError || run.pause?.compensation)))) {
    const action = controlAction(missionDir, state, record, run, ledger);
    if (action) return result(action, action.type === "wait_user");
  }
  if (gate) return result(gate);
  if (ledger.controlError) return result(wait("control", ledger.controlError.code, ledger.controlError.message));
  if (!state.ownerThreadId) return result({ type: "identify_owner", orchestratorCapabilities: {}, instruction: "Call orchestrator_capabilities and return the complete raw response as an owner observation. Persist its parentThreadId verbatim." });
  if (run?.terminalObservationId && run.failure?.kind === "result_unparseable" && feature) {
    try {
      const completion = latestCompletion(unwrapT3Response(observationById(missionDir, run.terminalObservationId).response));
      validateTaskResult(state, feature, active.runId, completion, run.pause);
      delete run.failure;
      if (ledger.decisionRepeat) delete ledger.decisionRepeat;
      saveController(missionDir, ledger);
    } catch { /* Still unparseable */ }
  }
  if (ledger.decisionRepeat) {
    const progress = decisionProgress(missionDir);
    const resolvedPauseGate = ledger.decisionRepeat.action?.gate === "pause" && !run?.controlError && run?.pause?.phase === "resumed";
    const resolvedIntegrationConflict = ledger.decisionRepeat.action?.kind === "integration_conflict" && run?.integrationObservationId && !run.integration && run?.result?.envelope && (() => {
      try { return integrationAction(missionDir, state, feature, run, ledger) === null; } catch { return false; }
    })();
    if (resolvedPauseGate || resolvedIntegrationConflict || ledger.decisionRepeat.revision !== progress.revision || ledger.decisionRepeat.observationHash !== progress.observationHash) {
      delete ledger.decisionRepeat; saveController(missionDir, ledger);
      if (ledger.timer?.phase === "disabled") return result(timerAction(missionDir, state, ledger, false, now));
    } else if (ledger.decisionRepeat.count >= (state.retryPolicy?.maxStalledDecisionRepeats ?? 3)) return result(stalledWait(missionDir, state, ledger));
  }
  const formatExhausted = run?.terminalObservationId && run.failure?.kind === "result_unparseable" &&
    (run.resultFormatRetries ?? 0) >= (state.retryPolicy?.maxResultFormatRetries ?? 2);
  if (state.activeWorker && !["completed", "awaiting_merge"].includes(state.status) && !formatExhausted) {
    const action = timerAction(missionDir, state, ledger, false, now);
    if (action) return result(action);
  }
  if (run?.dispatchError || run?.statusError) {
    const error = run.dispatchError || run.statusError;
    return result(wait("dispatch", error.code, error.message), ["interrupt_requested", "resume_requested"].includes(run.pause?.phase));
  }
  if (state.activeWorker) {
    active = state.activeWorker;
    if (!feature) return result(decision("state_conflict", { reason: "Active feature is missing", active }));
    if (!record) return result(wait("dispatch", "LEGACY_DISPATCH_UNKNOWN", "Active run has no durable Autopilot intent. Reconcile the original task before enabling Autopilot."));
    const currentRun = ledger.runs[active.runId] ??= { featureId: feature.id, intentId: record.intent.clientRequestId };
    const refused = record.phase !== "accepted" && dispatchRecordOutcome(missionDir, record).outcome === "NOT_ACCEPTED";
    if (record.phase !== "accepted" && !refused) return result(recoveryAction(state, feature, record, run));
    const status = currentRun.lastStatus;
    if (status?.pendingApproval) return result(wait("permission", "CHILD_APPROVAL_REQUIRED", "The child has a pending approval. Its existing approval holder must decide.", { pendingApproval: status.pendingApproval, childThreadId: active.childThreadId }));
    if (status?.hasPendingQuestion) return result(wait("input", "CHILD_QUESTION", "The child needs an answer before continuing.", { childThreadId: active.childThreadId }));
    if (!refused && !currentRun.terminalObservationId) {
      if (observations.some(item => item.type === "task_status" && item.runId === active.runId)) return result({ type: "sleep", reason: "Task is working or waiting for child runs; await notification or scheduled tick." });
      return result({ type: "poll", taskId: currentRun.pause?.phase === "resumed" && text(currentRun.pause?.resumeTaskId) ? currentRun.pause.resumeTaskId : active.taskId, featureId: feature.id, runId: active.runId });
    }
    const observed = currentRun.terminalObservationId && observationById(missionDir, currentRun.terminalObservationId);
    const completion = refused ? null : latestCompletion(unwrapT3Response(observed.response));
    const provider = refused ? consumeDispatchFailure(missionDir, state, feature, currentRun, ledger, record, now) : completion.status === "failed" ? providerFailure(completion) : null;
    if (provider) {
      if (!refused) {
        recordProviderFailure(missionDir, state, feature, currentRun, ledger, provider, completion, now);
        currentRun.result = { observationId: currentRun.terminalObservationId, envelope: failureEnvelope(provider) };
      }
    } else try {
      const parsed = validateTaskResult(state, feature, active.runId, completion, currentRun.pause);
      currentRun.result = { ...parsed, observationId: currentRun.terminalObservationId };
      currentRun.failure = parsed.envelope.status === "failure" ? { kind: "worker_failure", message: parsed.envelope.summary } : null;
      ledger.consecutiveProviderErrors = 0;
      saveController(missionDir, ledger);
    } catch (error) {
      if (!(error instanceof MissionKernelError)) throw error;
      currentRun.failure = { kind: "result_unparseable", code: error.code }; saveController(missionDir, ledger);
      const context = { featureId: feature.id, runId: active.runId, code: error.code, reason: error.message, observationId: currentRun.terminalObservationId, raw: completion.summary };
      if (error.code === "INVALID_MISSION_RESULT") {
        if ((currentRun.resultFormatRetries ?? 0) >= (state.retryPolicy?.maxResultFormatRetries ?? 2))
          return result(waitWithTimer(missionDir, state, ledger, wait("RESULT_UNPARSEABLE", "RESULT_UNPARSEABLE", "The same child exhausted its result-format correction budget.", context)));
        const identity = { ...record.receipt, ...(currentRun.pause?.phase === "resumed" ? { ...(text(currentRun.pause?.resumeTaskId) && currentRun.lastStatus?.taskId === currentRun.pause.resumeTaskId ? { taskId: currentRun.pause.resumeTaskId } : {}), childRunId: currentRun.lastStatus?.childRunId } : {}) };
        if (currentTerminalProof(currentRun.lastStatus, identity)) {
          currentRun.resultFormatRetries = (currentRun.resultFormatRetries ?? 0) + 1;
          currentRun.pause = { epoch: `result-format-${currentRun.resultFormatRetries}`, phase: "resume_requested",
            baselineRunId: currentRun.lastStatus.latestTerminalRunId ?? currentRun.lastStatus.childRunId ?? null };
          saveController(missionDir, ledger);
          return result({ type: "resume_worker", threadId: record.receipt.childThreadId, featureId: feature.id, runId: active.runId,
            controlId: `${active.runId}:${currentRun.pause.epoch}:resume`, kind: "result_unparseable", context,
            message: `Your mission-result is invalid: ${error.code}: ${error.message}. Continue the same child and Mission run; do not implement new work or create a new dispatch. Return exactly one complete mission-result JSON fence with version, featureId, runId, status (success/failure/partial), summary (at least 50 characters), commit and branch (SHA/name or null), tests (command and passed/failed/not_run), discoveredIssues and whatWasLeftUndone. ${isValidatorFeature(feature) ? `Include testedSha=${state.milestones.find(item => item.id === feature.milestoneId)?.mergeSha}, failedAssertions listing exactly the failed IDs, and assertionResults for every milestone assertion, with only passed or failed values. Judge only evidence independently available in this stage; the controller checks other stages.` : ""}\n\n${buildDelegateTask(state, feature, record.intent).task}` });
        }
      }
      return result(decision("result_unparseable", context));
    }
    if (formatExhausted) { const timer = timerAction(missionDir, state, ledger, false, now); if (timer) return result(timer); }
    const envelope = currentRun.result.envelope;
    if (envelope.status === "success" && ["implementation", "repair"].includes(inferFeatureKind(feature))) {
      try {
        const action = integrationAction(missionDir, state, feature, currentRun, ledger);
        if (action) return result(action);
      } catch (error) {
        if (!(error instanceof MissionKernelError)) throw error;
        return result(decision("integration_conflict", { featureId: feature.id, runId: active.runId, code: error.code, reason: error.message }));
      }
    }
    // Re-read user gates immediately before End. Suppress the legacy early-completion predicate.
    state = loadState(missionDir);
    gate = gateFor(state, feature);
    if (gate) return result(gate);
    endFeatureRun(missionDir, { featureId: feature.id, runId: active.runId, successState: envelope.status, validatorsPassed: envelope.status === "success", returnToOrchestrator: true,
      assertionResults: isValidatorFeature(feature) && !provider ? envelope.assertionResults : undefined,
      handoff: { whatWasImplemented: envelope.summary, discoveredIssues: envelope.discoveredIssues, whatWasLeftUndone: envelope.whatWasLeftUndone, tests: envelope.tests, commit: envelope.commit, branch: envelope.branch, testedSha: envelope.testedSha, failedAssertions: envelope.failedAssertions, providerFailure: provider, resultObservationId: currentRun.result.observationId } });
    currentRun.consumed = true;
    saveController(missionDir, ledger);
    yield () => undefined;
    state = loadState(missionDir);
    if (!provider && isValidatorFeature(feature) && envelope.status !== "success") return result(decision("validation_failed", { featureId: feature.id, milestoneId: feature.milestoneId, failedAssertions: envelope.failedAssertions, result: envelope, instruction: "Use UpdateMissionFeatures to insert a repair with sourceFeatureId referencing this validator and resolvesHandoffItemIds. After repair integration both stages rerun automatically." }));
    if (envelope.status === "partial") return result(handoffDecision(state));
  }
  state = loadState(missionDir);
  doc = loadFeaturesDoc(missionDir);
  if (state.lastHandoffNeedsAttention || state.pendingHandoffItems?.length) return result(handoffDecision(state));
  const pendingPermission = (state.permissions || []).find(item => item.status !== "approved" && !doc.features.some(feature => feature.id === item.featureId && feature.status === "pending"));
  if (pendingPermission) return result(wait("permission", pendingPermission.id, pendingPermission.message || pendingPermission.reason || "A declared permission needs user approval.", { permission: pendingPermission }));
  const unresolved = inspectDispatchRecords(missionDir).find(item => item.intent.missionId === state.missionId && !consumedSession(state, item.intent.runId));
  if (unresolved) return result(wait("dispatch", "ORPHAN_DISPATCH_INTENT", "An unconsumed dispatch intent has no active run. Reconcile it before advancing.", { intentId: unresolved.intent.clientRequestId }));
  // Avoid R8's unconditional save on an already-triggered milestone.
  if ((state.milestones || []).some(milestone => !state.milestoneValidationTriggered?.[milestone.id] && doc.features.some(item => item.milestoneId === milestone.id && ["implementation", "repair"].includes(inferFeatureKind(item))) && doc.features.filter(item => item.milestoneId === milestone.id && ["implementation", "repair"].includes(inferFeatureKind(item))).every(item => ["completed", "cancelled"].includes(item.status)))) {
    checkMilestoneCompletionAndInjectValidation(missionDir);
    state = loadState(missionDir); doc = loadFeaturesDoc(missionDir);
  }
  if (readyToFinish(state, doc.features, inspectDispatchRecords(missionDir), ledger)) {
    const status = state.integration?.auto === true ? "completed" : "awaiting_merge";
    if (state.status !== status) {
      state.status = status; state.lastStartedAt = null; state.revision += 1;
      saveState(missionDir, state);
      appendProgressLog(missionDir, { type: status === "completed" ? "mission_completed" : "mission_awaiting_merge", message: `Autopilot ${status}` });
    }
    const action = timerAction(missionDir, state, ledger, true);
    return result(action ?? { type: "done", status });
  }
  if (["completed", "awaiting_merge"].includes(state.status)) return result(decision("incomplete_terminal_state", { reason: "The Mission does not satisfy the Autopilot completion predicate." }));
  const hasRepair = milestoneId => doc.features.some(item => item.milestoneId === milestoneId && !isValidatorFeature(item) && item.status === "pending");
  const failedValidator = doc.features.find(item => isValidatorFeature(item) && !item.lastHandoff?.providerFailure && !hasRepair(item.milestoneId) && (item.status === "failed" || (item.lastHandoff?.successState === "failure" && item.status === "pending")));
  if (failedValidator) return result(decision("validation_failed", { featureId: failedValidator.id, failedAssertions: failedValidator.lastHandoff?.failedAssertions, handoff: failedValidator.lastHandoff }));
  const index = doc.features.findIndex(item => item.status === "pending" && (!isValidatorFeature(item) || !hasRepair(item.milestoneId)));
  if (index < 0) return result(decision("incomplete_mission", { reason: "Required features, both validators, assertions or integration evidence are missing." }));
  feature = doc.features[index];
  const timer = timerAction(missionDir, state, ledger, false, now);
  if (timer) return result(timer);
  if (!state.milestones.some(item => item.id === feature.milestoneId)) return result(decision("incomplete_mission", { featureId: feature.id, reason: "Feature references an undeclared milestone." }));
  gate = gateFor(state, feature);
  if (gate) return result(gate);
  if (feature.attempts >= feature.maxAttempts) return result(wait("attempts", "MAX_ATTEMPTS_EXCEEDED", "Grant more attempts or revise the failed feature.", { featureId: feature.id }));
  const budget = ledger.features?.[feature.id];
  if ((ledger.consecutiveProviderErrors ?? 0) >= (state.retryPolicy?.maxConsecutiveProviderErrors ?? 5)) return result(wait("provider", "PROVIDER_ERROR_BUDGET_EXHAUSTED", "Consecutive provider error budget is exhausted."));
  if (budget?.blocked === "PROVIDER_AUTH_REQUIRED") {
    if (!budget.authBlock) {
      const failed = [...state.sessions].reverse().find(session => session.featureId === feature.id && session.handoff?.providerFailure?.kind === "provider_auth");
      budget.authBlock = { code: budget.blocked, target: failed ? { providerInstanceId: failed.providerInstanceId, model: failed.model, options: failed.options ?? {} } : null,
        approvalEpoch: state.planApprovalEpoch ?? 0, runId: failed?.runId ?? null, legacy: true };
      saveController(missionDir, ledger);
    }
    if ((state.planApprovalEpoch ?? 0) > budget.authBlock.approvalEpoch) {
      const selected = resolveFeatureSlot(feature, loadModelSettings(missionDir)).slotConfig;
      const target = { providerInstanceId: selected.providerInstanceId, model: selected.model, options: selected.options ?? {} };
      if (text(target.providerInstanceId) && text(target.model)) {
        (budget.invalidatedAuthBlocks ??= []).push({ ...budget.authBlock, invalidatedAt: new Date(now).toISOString(),
          reason: isDeepStrictEqual(target, budget.authBlock.target) ? "explicit_auth_recovery" : "superseded_by_approval",
          supersededByApprovalEpoch: state.planApprovalEpoch, approvedTarget: target });
        delete budget.blocked; delete budget.authBlock;
        saveController(missionDir, ledger);
      }
    }
  }
  if (budget?.blocked) return result(wait("provider", budget.blocked, "Provider authentication or permission needs a user decision."));
  const role = isValidatorFeature(feature) ? "validator" : "worker";
  const fallbackApproved = budget?.target && (state.fallbackTargets?.[role] ?? []).some(target => isDeepStrictEqual(target, budget.target));
  if (budget?.target && !fallbackApproved && (state.planApprovalEpoch ?? 0) > (budget.approvalEpoch ?? 0)) {
    (budget.invalidatedFallbacks ??= []).push({ target: structuredClone(budget.target), invalidatedAt: new Date(now).toISOString(),
      reason: "superseded_by_approval", approvalEpoch: budget.approvalEpoch ?? 0, supersededByApprovalEpoch: state.planApprovalEpoch });
    delete budget.target;
    delete budget.approvalEpoch;
    saveController(missionDir, ledger);
  }
  if (budget?.nextRetryAt && now < Date.parse(budget.nextRetryAt)) return result({ type: "sleep", until: budget.nextRetryAt, reason: "provider_backoff", featureId: feature.id });
  if (doc.features.some(item => ["running", "paused"].includes(item.status))) return result(decision("state_conflict", { reason: "A running feature has no active worker; do not dispatch." }));
  if (budget?.target) {
    if (!fallbackApproved) return result(wait("provider", "FALLBACK_APPROVAL_REVOKED", "The cached fallback is absent from the current approved role targets.", { featureId: feature.id, role }));
    const proposed = { ...feature, target: budget.target };
    const selected = resolveFeatureSlot(proposed, loadModelSettings(missionDir)).slotConfig;
    if (!["providerInstanceId", "model", "options"].every(key => isDeepStrictEqual(selected[key], budget.target[key]))) return result(wait("provider", "FALLBACK_CAPABILITY_MISMATCH", "Approved fallback options cannot be represented by this runner."));
  }
  const selection = selectFeatureForWorker(missionDir, feature, index, loadModelSettings(missionDir), {}, budget?.target);
  // The runner selects synchronously. Journal before yielding to any newer Pause/Reject.
  state = loadState(missionDir);
  active = state.activeWorker;
  if (!active || active.featureId !== feature.id) {
    const rejected = selection;
    state = loadState(missionDir);
    const gate = gateFor(state, feature);
    if (gate) return result(gate);
    if (rejected.code === "MISSION_NOT_DISPATCHABLE") return result(wait("dispatch", rejected.code, rejected.reason));
    return result(decision("state_conflict", { reason: "Feature selection did not create the expected active run." }));
  }
  const intent = prepareDispatch(missionDir, { state, feature: loadFeaturesDoc(missionDir).features.find(item => item.id === feature.id), worker: active, target: active });
  ledger.runs[intent.runId] = { featureId: feature.id, intentId: intent.clientRequestId,
    failure: { kind: "acceptance_unknown" }, dispatchDecision: { outcome: "UNKNOWN" } };
  saveController(missionDir, ledger);
  yield () => undefined;
  state = loadState(missionDir);
  gate = gateFor(state, feature);
  if (gate) return result(gate);
  active = state.activeWorker;
  if (active?.featureId !== feature.id) return result(decision("state_conflict", { reason: "Active run changed during selection." }));
  const invocationId = claimDispatchIntent(missionDir, intent);
  if (!invocationId) return result(recoveryAction(state, feature, { intent }, ledger.runs[intent.runId]));
  yield () => undefined; // Prepared call registration must survive a restart.
  state = loadState(missionDir);
  gate = gateFor(state, feature);
  if (gate || state.activeWorker?.runId !== intent.runId) {
    const outcome = retainDispatchEvidence(missionDir, intent, { accepted: false, code: "MISSION_NOT_DISPATCHABLE" }, invocationId);
    if (outcome.outcome === "NOT_ACCEPTED") observeDispatchRejection(missionDir, intent, { accepted: false, code: "MISSION_NOT_DISPATCHABLE" });
    return result(gate ?? decision("state_conflict", { reason: "Active run changed before owner dispatch" }));
  }
  markDispatchInvocationInflight(missionDir, intent, invocationId);
  return result({ type: "dispatch", invocationId, intentId: intent.clientRequestId, featureId: feature.id, runId: intent.runId, attempt: intent.attempt, delegateTask: buildDelegateTask(state, feature, intent) });
}

export async function missionTick(dir, input = {}) {
  if (input.commandId !== undefined) missionTransaction(dir, () => {
    const file = path.join(getMissionPaths(dir).baseDir, '.txn', 'commands', transactionHash(String(input.commandId)) + '.json');
    const bytes = readTransactionFile(file);
    if (bytes !== null && JSON.parse(bytes).commandHash !== digest(input)) fail('TX_COMMAND_ID_CONFLICT', 'commandId was committed with a different payload');
  }, { create: false });
  if (input.dispatchResolution !== undefined) resolveDispatchEvidence(dir, { ...input.dispatchResolution, commandId: `dispatch-resolution:${digest(input.dispatchResolution)}` });
  // The raw archive is a separate durable fact. A later reducer refusal cannot
  // erase the only copy of an externally accepted response.
  missionTransaction(dir, () => {
    const state = loadState(dir);
    if (!Array.isArray(input.observations ?? [])) fail('INVALID_OBSERVATIONS', 'observations must be an array');
    for (const observation of input.observations ?? []) {
      if (!observation || ![...globalTypes, 'dispatch', 'children', 'task_status', 'integration', 'interrupt', 'resume'].includes(observation.type) || (!globalTypes.has(observation.type) && (!text(observation.runId) || !text(observation.featureId))) || !Object.hasOwn(observation, 'response')) fail('INVALID_OBSERVATIONS', 'Each observation requires its original response and identity');
    }
    const records = inspectDispatchRecords(dir);
    const known = [...readObservations(dir), ...(input.observations ?? []).map(observation => ({observation}))];
    const resolveStatusOwner = createTaskStatusOwnerResolver(records, known, state.missionId);
    for (const observation of input.observations ?? [])
      if (observation.type === 'task_status') resolveStatusOwner(observation);
    for (const observation of input.observations ?? []) archiveObservation(dir, observation);
  }, { create: false });
  let commandFile;
  if (input.commandId !== undefined) {
    const prior = missionTransaction(dir, () => {
      const base = getMissionPaths(dir).baseDir;
      if (typeof input.commandId !== 'string' || !input.commandId.trim()) fail('TX_COMMAND_ID_REQUIRED', 'commandId must be a non-empty string');
      commandFile = path.join(base, '.txn', 'commands', transactionHash(input.commandId) + '.json');
      const commandHash = digest(input);
      const bytes = readTransactionFile(commandFile);
      if (bytes !== null) {
        const saved = JSON.parse(bytes);
        if (saved.version !== 1 || saved.commandHash !== commandHash) fail('TX_COMMAND_ID_CONFLICT', 'commandId was committed with a different payload');
        return saved;
      }
      writeTransactionFile(commandFile, JSON.stringify({ version: 1, commandHash, phase: 'requested' }) + '\n');
      return null;
    });
    if (prior) {
      const state = loadState(dir);
      const saved = prior.result;
      if (saved && prior.resultHash !== digest(saved)) fail("TX_COMMAND_RESULT_CORRUPT", "MissionTick command result checksum differs");
      if (saved?.action.type === 'dispatch') return { ...saved, replayed: true, action: { type: 'recover_dispatch', intentId: saved.action.intentId, clientRequestId: saved.action.intentId, featureId: saved.action.featureId, runId: saved.action.runId, instruction: 'Reconcile the original accepted task; this replay grants no dispatch authority.' } };
      return { missionId: state.missionId, revision: state.revision, replayed: true, action: wait('control', 'ACTION_OUTCOME_UNKNOWN', 'Recover the original command and any external operation. This replay grants no authority to repeat it.') };
    }
  }
  const result = await runMissionSteps(dir, missionTickSteps(dir, input));
  if (commandFile) missionTransaction(dir, () => {
    const record = JSON.parse(readTransactionFile(commandFile));
    writeTransactionFile(commandFile, JSON.stringify({ ...record, phase: 'completed', resultHash: digest(result), result }) + '\n');
  });
  return result;
}

/** Record the observed current disabled state after an interrupted bounded-timer enable. */
export function reconcileBoundedTimer(missionDir, input = {}) {
  const commandId = input.commandId ?? `timer-reconcile:${input.requestId}`;
  return commandTransaction(missionDir, "ReconcileBoundedTimer", input, () => {
    const state = loadState(missionDir), ledger = readController(missionDir, state.missionId);
    const timer = ledger.timer, guard = timer?.guard, oldWake = ledger.timerGuardPolicy?.wakeInstructions;
    const invalid = message => fail("INVALID_TIMER_RECONCILIATION", message);
    if (!timer || timer.phase !== "requested" || !guard || timer.requestId !== input.requestId || !text(timer.scheduledTaskId) ||
        !text(oldWake) || !text(input.newWakeInstructions) || input.newWakeInstructions.length > 4000 ||
        /[\u0000-\u0008\u000b-\u001f]/u.test(input.newWakeInstructions)) invalid("The original bounded enable and wake instructions are required");
    let enabled, disabled;
    try {
      const first = unwrapObservationResponse(input.enabledResponse), last = unwrapObservationResponse(input.disabledResponse);
      enabled = first.task ?? first.scheduledTask ?? first;
      disabled = last.task ?? last.scheduledTask ?? last;
    } catch { invalid("Scheduler receipts are malformed or conflicting"); }
    const expectedId = timer.scheduledTaskId;
    const expectedDue = guard.dueAt;
    const matches = task => task?.scheduledTaskId === expectedId && task.boundThreadId === state.ownerThreadId &&
      task.schedule?.type === "once" && Date.parse(task.schedule.runAt) === expectedDue;
    const oldSuffix = `\n\n${oldWake}`;
    if (!matches(enabled) || !matches(disabled) || enabled.enabled !== true || disabled.enabled !== false ||
        Date.parse(enabled.nextRunAt) !== expectedDue || disabled.nextRunAt !== null ||
        typeof enabled.prompt !== "string" || !enabled.prompt.endsWith(oldSuffix) ||
        disabled.prompt !== enabled.prompt.slice(0, -oldSuffix.length) + `\n\n${input.newWakeInstructions}`)
      invalid("Receipts do not prove the same one-shot task was enabled then disabled with the reviewed wake instructions");
    timer.reconciliation = { requestId: input.requestId, enabledResponse: structuredClone(input.enabledResponse),
      disabledResponse: structuredClone(input.disabledResponse), previousWakeInstructions: oldWake,
      newWakeInstructions: input.newWakeInstructions, reconciledAt: new Date().toISOString() };
    timer.phase = "disabled";
    ledger.timerGuardPolicy.wakeInstructions = input.newWakeInstructions;
    saveController(missionDir, ledger);
    appendProgressLog(missionDir, { type: "timer_reconciled", message: "Reconciled the bounded timer to its observed disabled state.", scheduledTaskId: expectedId });
    return { ok: true, timerPhase: "disabled", scheduledTaskId: expectedId };
  }, { commandId });
}

/** Explicit user choice after every conflicting execution has proved terminal. */
export function resolveDispatchEvidence(missionDir, input = {}) {
  return commandTransaction(missionDir, 'ResolveDispatchEvidence', input, () => {
    const state = loadState(missionDir), ledger = readController(missionDir, state.missionId);
    const record = dispatchIntentRecords(inspectDispatchRecords(missionDir)).find(row => row.intent.clientRequestId === input.intentId);
    if (input.userConfirmed !== true || !text(input.reason) || !Array.isArray(input.terminalObservationIds) || !input.terminalObservationIds.length || new Set(input.terminalObservationIds).size !== input.terminalObservationIds.length)
      fail('DISPATCH_RESOLUTION_APPROVAL_REQUIRED', 'Explicit user confirmation, reason and terminal observation IDs are required');
    if (!record || !ledger.dispatchReconciliations?.[input.intentId] || ledger.dispatchReconciliations[input.intentId].resolutionId || (!record.historical && !consumedSession(state, record.intent.runId)))
      fail('DISPATCH_RESOLUTION_NOT_PENDING', 'Only an original late intent with a pending reconciliation can be resolved');
    const archived = readObservations(missionDir).filter(({ observation: o }) => o.runId === record.intent.runId && o.featureId === record.intent.featureId);
    const known = [];
    for (const { observation: o } of archived) {
      if (o.intentId !== input.intentId) continue;
      if (o.type === 'dispatch') known.push(...dispatchReceiptSources(o.response));
      if (o.type === 'children') {
        const page = unwrapObservationResponse(o.response, {}, { allowList: true });
        const items = Array.isArray(page) ? page : page.tasks ?? page.threads ?? [];
        known.push(...items.filter(item => item.parentThreadId === record.intent.recovery?.parentThreadId && item.clientRequestId === input.intentId));
      }
    }
    if (record.receipt) known.push(record.receipt);
    const terminals = input.terminalObservationIds.map(id => {
      const item = archived.find(row => row.id === id);
      if (item?.observation.type !== 'task_status') fail('INVALID_DISPATCH_RESOLUTION', 'Every terminal ID must reference an archived original-run task_status');
      const status = unwrapObservationResponse(item.observation.response, { taskId: item.observation.taskId });
      if (!currentTerminalProof(status, status))
        fail('DISPATCH_RESOLUTION_UNSETTLED', 'Every conflicting execution must be terminal with no pending children');
      return { id, status };
    });
    // Include callback and exception identities, not just owner observations.
    for (const invocation of record.invocations ?? []) {
      for (const raw of invocation.receipts) known.push(...dispatchReceiptSources(raw));
      if (invocation.exception?.executionEvidence) known.push(invocation.exception.executionEvidence);
    }
    const statuses = archived.filter(row => row.observation.type === 'task_status').map(row => {
      try { return { ...row, status: unwrapObservationResponse(row.observation.response, { taskId: row.observation.taskId }) }; }
      catch { return { ...row, status: null }; }
    });
    for (const item of known.filter(row => row.taskId || row.childThreadId || row.childRunId)) {
      const matches = status => status && ['taskId', 'childThreadId'].every(key => !item[key] || status[key] === item[key]);
      const latest = statuses.filter(row => matches(row.status) || (!row.status && row.observation.taskId === item.taskId)).at(-1);
      if (!latest?.status || !terminals.some(row => row.id === latest.id) ||
          !currentTerminalProof(latest.status, item))
        fail('DISPATCH_RESOLUTION_UNSETTLED', 'Current full task/thread/childRun status must prove stopped; user selection is not stop proof');
    }
    for (const { id, status } of terminals) {
      if (!known.some(item => item.taskId === status.taskId && (!item.childThreadId || item.childThreadId === status.childThreadId)))
        fail('DISPATCH_RESOLUTION_UNSETTLED', 'Stale or unrelated terminal evidence cannot resolve a current execution');
    }
    const selected = terminals.find(row => row.status.taskId === input.selectedTaskId && row.status.childThreadId === input.selectedChildThreadId);
    if (!selected) fail('INVALID_DISPATCH_RESOLUTION', 'Select one of the confirmed original execution identities');
    const resolutionId = `user:${input.intentId}:${digest(input)}`;
    let result, validationError;
    if (latestCompletion(selected.status).status === 'completed') {
      try { result = validateTaskResult(state, loadFeaturesDoc(missionDir).features.find(row => row.id === record.intent.featureId), record.intent.runId, latestCompletion(selected.status)); }
      catch (error) { if (!(error instanceof MissionKernelError)) throw error; validationError = { code: error.code, message: error.message }; }
    }
    (ledger.dispatchResolutions ??= {})[resolutionId] = { resolutionId, kind: 'user_reconciled_conflict', intentId: input.intentId, runId: record.intent.runId, featureId: record.intent.featureId,
      reason: input.reason, userConfirmed: true, terminalObservationIds: input.terminalObservationIds, selectedTaskId: input.selectedTaskId, selectedChildThreadId: input.selectedChildThreadId,
      evidenceIds: archived.map(row => row.id), response: selected.status, ...(result ? { result } : {}), ...(validationError ? { validationError } : {}) };
    appendProgressLog(missionDir, { type: "late_execution_resolved", featureId: record.intent.featureId, details: ledger.dispatchResolutions[resolutionId], message: "All original executions stopped. User selection records an audit result only." });
    ledger.dispatchReconciliations[input.intentId].resolutionId = resolutionId;
    saveController(missionDir, ledger);
    return { resolutionId, intentId: input.intentId };
  });
}
