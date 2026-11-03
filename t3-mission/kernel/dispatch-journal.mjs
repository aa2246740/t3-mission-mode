import { hasAsciiControlCharacters } from "./text-validation.mjs";
import {
  missionTransaction,
  readTransactionFile,
  writeTransactionFile,
  listTransactionFiles,
  runMissionSteps,
  transactionHash,
} from "./mission-transaction.mjs";
import {
  isRemoteWorker,
  inspectOwnedLocalWorker,
  stripLocalWorkerMetadata,
} from "./worker-process.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getMissionPaths, loadState, loadFeaturesDoc } from "./store.mjs";
import { recoveryMatches, recoverTask } from "./autopilot-policy.mjs";
import { buildDelegateTask } from "./mission-brief.mjs";
import { readController, saveController, readObservations } from "./autopilot-store.mjs";
import {
  MissionKernelError,
  createRunId,
  decideDispatchOutcome,
  classifyControlReceipt,
  mergeInvocationEvidence,
  clearDispatchRejection,
  unwrapObservationResponse,
  dispatchReceiptSources,
} from "./schema.mjs";

const identityKeys = ["taskId", "childThreadId", "childRunId", "worktreePath", "clientRequestId"];
const text = (value) =>
  typeof value === "string" && value.trim().length > 0 && !hasAsciiControlCharacters(value);
const fail = (code, message) => {
  throw new MissionKernelError(code, message);
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function location(missionDir, scope) {
  if (
    !text(scope.missionId) ||
    !text(scope.featureId) ||
    !Number.isSafeInteger(scope.attempt) ||
    scope.attempt < 1
  )
    fail(
      "INVALID_DISPATCH_INTENT",
      "Dispatch requires missionId, featureId and a positive attempt",
    );
  return path.join(
    getMissionPaths(missionDir).baseDir,
    `dispatch-${hash([scope.missionId, scope.featureId, scope.attempt])}.json`,
  );
}
function read(file) {
  if (
    (file.endsWith(".tmp")
      ? fs.existsSync(file)
        ? fs.readFileSync(file, "utf8")
        : null
      : readTransactionFile(file)) === null
  )
    return null;
  let record;
  try {
    record = JSON.parse(
      file.endsWith(".tmp") ? fs.readFileSync(file, "utf8") : readTransactionFile(file),
    );
  } catch (error) {
    fail("INVALID_DISPATCH_JOURNAL", `Cannot read dispatch record: ${error.message}`);
  }
  if (
    record?.version !== 1 ||
    !["prepared", "inflight", "retryable", "accepted"].includes(record.phase) ||
    ![
      record.intent?.missionId,
      record.intent?.featureId,
      record.intent?.runId,
      record.intent?.clientRequestId,
      record.intent?.target?.providerInstanceId,
      record.intent?.target?.model,
    ].every(text) ||
    !Number.isSafeInteger(record.intent?.attempt) ||
    record.intent.attempt < 1 ||
    !Number.isSafeInteger(record.intent?.worker?.workerNumber) ||
    record.intent.worker.workerNumber < 1 ||
    (record.invocations !== undefined &&
      (!Array.isArray(record.invocations) ||
        new Set(record.invocations.map((row) => row.invocationId)).size !==
          record.invocations.length ||
        record.invocations.some(
          (row) =>
            !text(row.invocationId) ||
            !["prepared", "inflight", "returned"].includes(row.phase) ||
            !Array.isArray(row.receipts),
        ))) ||
    (record.invocationPhase !== undefined &&
      !["inflight", "returned"].includes(record.invocationPhase)) ||
    (record.phase === "accepted" &&
      !(
        record.receipt &&
        (text(record.receipt.taskId) ||
          text(record.receipt.childThreadId) ||
          text(record.receipt.childRunId) ||
          record.receipt.workerPid ||
          record.receipt.daemonStateFile)
      ))
  )
    fail(
      "INVALID_DISPATCH_JOURNAL",
      "Dispatch record is malformed; automatic redispatch is forbidden",
    );
  const migrated = invocationRecords(record);
  if (migrated.length && !isDeepStrictEqual(record.invocations, migrated)) {
    record.invocations = migrated;
    record.phase = "inflight";
  }
  return record;
}
function write(file, record) {
  writeTransactionFile(file, JSON.stringify(record, null, 2) + "\n");
}
function persistAccepted(file, record) {
  try {
    write(file, record);
  } catch (error) {
    const failure = new MissionKernelError(
      "DISPATCH_RECEIPT_DURABILITY_FAILED",
      `Accepted dispatch could not be journaled; do not redispatch: ${error.message}`,
    );
    failure.runtimeResult = {
      ...record.receipt,
      missionRunId: record.intent.runId,
      featureId: record.intent.featureId,
    };
    throw failure;
  }
}
function recoverAccepted(file, current) {
  const prefix = `${path.basename(file)}.accepted-`;
  const remnants = fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .sort();
  if (!remnants.length) return current;
  let recovered = current;
  for (const name of remnants) {
    const candidate = read(path.join(path.dirname(file), name));
    if (
      !recovered ||
      !candidate ||
      candidate.phase !== "accepted" ||
      !isDeepStrictEqual(candidate.intent, recovered.intent)
    )
      fail(
        "DISPATCH_RECEIPT_CONFLICT",
        "Retained accepted receipt does not match this durable intent",
      );
    const receipt = parseReceipt(candidate.receipt, candidate.intent);
    if (!receipt || !isDeepStrictEqual(receipt, candidate.receipt))
      fail(
        "INVALID_DISPATCH_JOURNAL",
        "Retained accepted receipt is not a normalized receipt for this intent",
      );
    if (recovered.phase === "accepted") {
      for (const [key, value] of Object.entries(candidate.receipt))
        if (
          recovered.receipt[key] !== undefined &&
          !isDeepStrictEqual(value, recovered.receipt[key])
        )
          fail("DISPATCH_RECEIPT_CONFLICT", `Retained accepted receipt ${key} differs`);
      recovered = { ...recovered, receipt: { ...candidate.receipt, ...recovered.receipt } };
    } else recovered = candidate;
  }
  persistAccepted(file, recovered);
  // Keep legacy accepted remnants as immutable evidence until an explicit offline cleanup.
  return recovered;
}
function recoverRaw(file, record) {
  if (!record || record.phase === "accepted") return record;
  const dir = path.join(path.dirname(file), ".txn", "receipts");
  for (const name of listTransactionFiles(dir)) {
    if (!/^[a-f0-9]+\.json$/.test(name)) continue;
    const raw = JSON.parse(readTransactionFile(path.join(dir, name)));
    if (raw.intentId !== record.intent.clientRequestId) continue;
    if (
      name !==
      hash(
        raw.invocationId
          ? [raw.intentId, raw.result, raw.invocationId]
          : [raw.intentId, raw.result],
      ) +
        ".json"
    )
      fail("DISPATCH_RECEIPT_CONFLICT", "Raw dispatch receipt checksum differs");
    if (raw.version !== 1 || !isDeepStrictEqual(raw.intent, record.intent))
      fail("DISPATCH_RECEIPT_CONFLICT", "Archived raw receipt belongs to a conflicting intent");
    if (!["return", "runtimeResult"].includes(raw.source)) continue;
    if (
      decideDispatchOutcome(raw.result, {
        expectedIdentity: record.intent,
        operation: raw.operation ?? "dispatch",
      }).outcome !== "ACCEPTED"
    )
      continue;
    const receipt = parseReceipt(raw.result, record.intent, raw.operation);
    if (
      receipt &&
      !isRemoteWorker(receipt) &&
      ["workerPid", "daemonStateFile", "daemonStatus"].some((key) => Object.hasOwn(receipt, key)) &&
      !inspectOwnedLocalWorker({ ...record.intent.worker, ...receipt }, path.dirname(file))
    )
      fail("DISPATCH_OUTCOME_UNKNOWN", "Archived local runtime receipt has no verified ownership");
    if (receipt) {
      if (
        record.phase === "accepted" &&
        identityKeys.some(
          (key) => receipt[key] && record.receipt[key] && receipt[key] !== record.receipt[key],
        )
      )
        fail(
          "DISPATCH_RECEIPT_CONFLICT",
          "Archived accepted receipts identify different executions",
        );
      const accepted = {
        ...record,
        phase: "accepted",
        receipt,
        result: {
          ...(raw.result?.resumed === true ? { resumed: true } : {}),
          ...(raw.result?.handoff
            ? {
                handoff: raw.result.handoff,
                successState: raw.result.successState,
                validatorsPassed: raw.result.validatorsPassed,
              }
            : {}),
        },
      };
      persistAccepted(file, accepted);
      record = accepted;
    }
  }
  const effectId = `runtime-dispatch:${record.intent.missionId}:${record.intent.runId}:${record.intent.clientRequestId}`;
  const effectDir = path.join(path.dirname(file), ".txn", "effects");
  for (const name of listTransactionFiles(effectDir)) {
    if (record.phase === "accepted" || !/^[a-f0-9]+\.json$/.test(name)) continue;
    const effect = JSON.parse(readTransactionFile(path.join(effectDir, name)));
    if (effect.effectId !== effectId && !effect.effectId?.startsWith(effectId + ":not-accepted:"))
      continue;
    if (effect.version !== 1 || name !== transactionHash(effect.effectId) + ".json")
      fail("DISPATCH_RECEIPT_CONFLICT", "Runtime effect identity differs");
    if (effect.phase === "returned") {
      if (
        effect.responseHash !==
        transactionHash(
          JSON.stringify({ responseDefined: effect.responseDefined, response: effect.response }),
        )
      )
        fail("DISPATCH_RECEIPT_CONFLICT", "Runtime effect return checksum differs");
      const outcome = decideDispatchOutcome(effect.response, { expectedIdentity: record.intent });
      const receipt =
        outcome.outcome === "ACCEPTED" ? parseReceipt(effect.response, record.intent) : null;
      if (receipt?.taskId && receipt?.childThreadId) {
        record = { ...record, phase: "accepted", receipt, result: {} };
        persistAccepted(file, record);
      }
    }
  }
  return record;
}
function mutate(file, callback) {
  return missionTransaction(
    path.dirname(file),
    () => {
      if (fs.existsSync(file + ".lock"))
        fail(
          "DISPATCH_OUTCOME_UNKNOWN",
          "A legacy journal claim remains; reconcile the old writer before migration",
        );
      return callback(recoverAccepted(file, read(file)));
    },
    { exactBase: true },
  );
}
function scopeOf(state, feature, worker) {
  return {
    missionId: state.missionId,
    featureId: feature.id ?? worker.featureId,
    attempt: worker.attempt ?? feature.attempts ?? 1,
  };
}
function inspectDispatchIntentImpl(missionDir, state, feature, attempt) {
  const file = location(missionDir, { missionId: state.missionId, featureId: feature.id, attempt });
  return mutate(file, (record) => record?.intent ?? null);
}
/** Controller handoff: claim before returning an external action, never invoke transport. */
function claimDispatchIntentImpl(missionDir, intent) {
  assertNoUnresolvedDispatch(missionDir, intent.featureId);
  const file = location(missionDir, intent);
  return mutate(file, (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Dispatch intent changed before claiming");
    if (record.phase !== "prepared") return false;
    const outcome = dispatchRecordOutcome(missionDir, record);
    if (outcome.hasDurableEvidence && outcome.outcome !== "NOT_ACCEPTED") {
      if (outcome.outcome === "ACCEPTED") {
        let receipt;
        try {
          receipt = verifiedRecoveryReceipt(outcome.identity, intent, missionDir);
        } catch (error) {
          if (!(error instanceof MissionKernelError)) throw error;
          write(file, {
            ...record,
            phase: "inflight",
            lastOutcome: { kind: "unknown", error: error.message },
          });
          return false;
        }
        persistAccepted(file, { ...record, phase: "accepted", receipt, result: {} });
      } else write(file, { ...record, phase: "inflight" });
      return false;
    }
    const invocation = registerInvocation(missionDir, record, "controller");
    write(file, { ...record, phase: "inflight", invocationPhase: "inflight" });
    return invocation.invocationId;
  });
}
function inspectDispatchRecordsImpl(missionDir) {
  const base = getMissionPaths(missionDir).baseDir;
  return listTransactionFiles(base)
    .filter((name) => /^dispatch-[a-f0-9]+\.json$/.test(name))
    .sort()
    .map((name) =>
      mutate(path.join(base, name), (record) => recoverRaw(path.join(base, name), record)),
    );
}
/** Save raw-owner receipt evidence before Bind, including while approval is revoked. */
function observeDispatchReceiptImpl(missionDir, intent, result) {
  return mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Observation belongs to another intent");
    const outcome = dispatchRecordOutcome(missionDir, record, [result]);
    if (outcome.outcome === "CONFLICT")
      throw new MissionKernelError(
        outcome.errorCode,
        "Observed identity conflicts with durable evidence",
        { dispatchDecision: outcome },
      );
    const receipt = parseReceipt(
      outcome.outcome === "ACCEPTED" ? outcome.identity : result,
      intent,
    );
    if (!receipt?.taskId || !receipt?.childThreadId)
      fail(
        "DISPATCH_OUTCOME_UNKNOWN",
        "A complete accepted task/thread receipt is required; do not redispatch",
      );
    if (record.phase === "accepted") {
      for (const key of identityKeys)
        if (receipt[key] && record.receipt[key] && receipt[key] !== record.receipt[key])
          fail("DISPATCH_RECEIPT_CONFLICT", `Observed ${key} differs from accepted receipt`);
      if (
        Object.entries(receipt).every(([key, value]) =>
          isDeepStrictEqual(record.receipt[key], value),
        )
      )
        return record.receipt;
    }
    persistAccepted(location(missionDir, intent), {
      ...record,
      phase: "accepted",
      receipt: { ...record.receipt, ...receipt },
      result: record.result || {},
    });
    return receipt;
  });
}
/** Only explicit nonacceptance with no positive evidence can release this intent. */
function observeDispatchRejectionImpl(missionDir, intent, result) {
  return mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent) || record.phase === "accepted")
      fail("DISPATCH_INTENT_CONFLICT", "Cannot reject a different or accepted intent");
    const verdict = dispatchRecordOutcome(missionDir, record, [result]);
    if (verdict.outcome !== "NOT_ACCEPTED")
      fail(
        "DISPATCH_OUTCOME_UNKNOWN",
        "Rejection must prove nonacceptance without any identity or positive evidence",
      );
    if (record.phase !== "retryable")
      write(location(missionDir, intent), {
        ...record,
        phase: "retryable",
        lastOutcome: {
          kind: verdict.controlReceipt.classification,
          result,
          dispatchDecision: verdict,
        },
      });
  });
}
/** Prepare an original run before transport. An accepted/inflight intent never retargets. */
function prepareDispatchImpl(missionDir, { state, feature, worker, target }) {
  const scope = scopeOf(state, feature, worker),
    file = location(missionDir, scope);
  const normalizedTarget = canonical({
    providerInstanceId: target.providerInstanceId,
    model: target.model,
    options: target.options || {},
  });
  if (
    !text(normalizedTarget.providerInstanceId) ||
    !text(normalizedTarget.model) ||
    !Number.isSafeInteger(worker.workerNumber) ||
    worker.workerNumber < 1
  )
    fail("INVALID_DISPATCH_INTENT", "Dispatch requires the recorded target and worker number");
  return mutate(file, (existing) => {
    if (existing) {
      const intent = existing.intent;
      if (
        intent.missionId !== scope.missionId ||
        intent.featureId !== scope.featureId ||
        intent.attempt !== scope.attempt ||
        intent.worker.workerNumber !== worker.workerNumber ||
        (state.activeWorker && state.activeWorker.runId !== intent.runId)
      )
        fail(
          "DISPATCH_INTENT_CONFLICT",
          "Existing dispatch belongs to another Mission run or worker",
        );
      if (!isDeepStrictEqual(intent.target, normalizedTarget)) {
        if (
          existing.phase !== "retryable" ||
          dispatchRecordOutcome(missionDir, existing).outcome !== "NOT_ACCEPTED"
        )
          fail(
            "DISPATCH_TARGET_CONFLICT",
            "An accepted or in-flight dispatch cannot change target",
          );
        assertNoUnresolvedDispatch(missionDir, intent.featureId);
        assertInvocationBudget(missionDir, existing);
        existing.history = [...(existing.history || []), intent];
        existing.invocationHistory = [
          ...(existing.invocationHistory ?? []),
          {
            intent,
            invocations: invocationRecords(existing),
            unattributedEvidence: existing.unattributedEvidence ?? [],
          },
        ];
        const clientRequestId = `t3m:${hash([scope, intent.runId, normalizedTarget]).slice(0, 48)}`;
        existing.intent = {
          ...intent,
          target: normalizedTarget,
          worker: { ...intent.worker, ...normalizedTarget, clientRequestId },
          clientRequestId,
          ...(intent.recovery ? { recovery: { ...intent.recovery, clientRequestId } } : {}),
        };
        delete existing.observedReceipt;
        delete existing.lastOutcome;
        delete existing.evidence;
        delete existing.invocations;
        delete existing.unattributedEvidence;
        delete existing.invocationPhase;
        existing.phase = "prepared";
        write(file, existing);
      }
      return structuredClone(existing.intent);
    }
    const runId = worker.runId || createRunId();
    const clientRequestId =
      worker.clientRequestId || `t3m:${hash([scope, runId, normalizedTarget]).slice(0, 48)}`;
    const intent = {
      ...scope,
      runId,
      clientRequestId,
      target: normalizedTarget,
      feature: structuredClone(feature),
      worker: { ...structuredClone(worker), ...normalizedTarget, runId, clientRequestId },
      createdAt: new Date().toISOString(),
    };
    intent.recovery = {
      ownerThreadId: state.ownerThreadId ?? null,
      parentThreadId: state.ownerThreadId ?? null,
      clientRequestId,
      title: buildDelegateTask(state, feature, intent).title,
    };
    const legacyUnknown =
      state.activeWorker?.runId === runId && state.activeWorker.dispatchNotInvoked !== true;
    write(file, {
      version: 1,
      phase: legacyUnknown ? "inflight" : "prepared",
      intent,
      ...(legacyUnknown
        ? {
            invocations: [
              {
                invocationId: `legacy:${clientRequestId}`,
                source: "legacy",
                phase: "inflight",
                receipts: [],
                exception: { code: "LEGACY_DISPATCH_PROVENANCE_UNKNOWN" },
              },
            ],
          }
        : {}),
    });
    return intent;
  });
}
// Pre-A8 journals never recorded whether a value came from return or throw.
// Keep that data for diagnosis, but require new attributed evidence to settle it.
function invocationRecords(record) {
  if (record.invocations)
    return structuredClone(record.invocations).map((row) => {
      if (row.source !== "legacy" || (row.phase === "inflight" && !row.receipts.length)) return row;
      return {
        ...row,
        phase: "inflight",
        receipts: [],
        exception: { ...row.exception, legacyInvocation: row },
      };
    });
  if (
    record.phase === "prepared" &&
    !record.invocationPhase &&
    !record.lastOutcome &&
    !record.observedReceipt &&
    !record.evidence?.length
  )
    return [];
  return [
    {
      invocationId: `legacy:${record.intent.clientRequestId}`,
      source: "legacy",
      phase: "inflight",
      receipts: [],
      exception: {
        code: "LEGACY_DISPATCH_PROVENANCE_UNKNOWN",
        executionEvidence: record.receipt ?? record.observedReceipt,
      },
    },
  ];
}

export const DISPATCH_LIMITS = Object.freeze({ invocations: 1024, history: 1024, evidence: 65536 });
function invocationBudget(missionDir, record) {
  const state = loadState(missionDir);
  const feature = loadFeaturesDoc(missionDir).features.find(
    (row) => row.id === record.intent.featureId,
  );
  return Math.min(feature?.maxAttempts ?? 5, state.retryPolicy?.maxConsecutiveProviderErrors ?? 5);
}
function assertInvocationBudget(missionDir, record, reservedInvocation) {
  const reject = (code, message) => {
    throw Object.assign(
      new MissionKernelError(code, message),
      reservedInvocation ? { runtimeResult: { accepted: false, preSend: true, code } } : {},
    );
  };
  const histories = record.invocationHistory ?? [];
  const calls = [
    ...(record.invocations ?? []),
    ...histories.flatMap((row) => row.invocations ?? []),
  ];
  const budget = invocationBudget(missionDir, record);
  if (calls.filter((row) => row !== reservedInvocation).length >= budget)
    reject(
      "DISPATCH_RETRY_BUDGET_EXHAUSTED",
      "Invocation retry budget exhausted. MissionTick must consume the trusted refusal before another attempt; approval does not reset this budget.",
    );
  const limit = Math.max(DISPATCH_LIMITS.invocations, budget * 2 + 1);
  if (
    histories.length >= limit ||
    calls.length >= limit ||
    [
      record.evidence,
      record.unattributedEvidence,
      ...calls.map((row) => row.receipts),
      ...histories.map((row) => row.unattributedEvidence),
    ].some((rows) => rows?.length >= Math.max(DISPATCH_LIMITS.evidence, limit * 64))
  )
    reject(
      "DISPATCH_EVIDENCE_LIMIT",
      "Execution facts exceed the corruption guard. Dispatch stays fenced; original receipts and terminal observations remain writable.",
    );
}

function registerInvocation(missionDir, record, source) {
  assertInvocationBudget(missionDir, record);
  record.invocations = invocationRecords(record);
  const invocation = {
    invocationId: `inv:${crypto.randomUUID()}`,
    source,
    phase: "prepared",
    phases: ["prepared"],
    receipts: [],
  };
  record.invocations.push(invocation);
  return invocation;
}
// Used by owner adapters before issuing an additional, independently authorized call.
// Calling this records uncertainty; it never authorizes another attempt or key.
export function beginDispatchInvocation(missionDir, intent, source = "owner") {
  const invocationId = mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Invocation belongs to another intent");
    assertNoUnresolvedDispatch(missionDir, intent.featureId);
    const invocation = registerInvocation(missionDir, record, source);
    write(location(missionDir, intent), {
      ...record,
      phase: record.phase === "accepted" ? "accepted" : "inflight",
      invocationPhase: "inflight",
    });
    return invocation.invocationId;
  });
  markDispatchInvocationInflight(missionDir, intent, invocationId);
  return invocationId;
}
export function markDispatchInvocationInflight(missionDir, intent, invocationId) {
  return mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Invocation belongs to another intent");
    const invocation = record.invocations?.find((row) => row.invocationId === invocationId);
    if (!invocation || invocation.phase !== "prepared")
      fail("INVALID_DISPATCH_INVOCATION", "Only a prepared call may enter transport");
    assertInvocationBudget(missionDir, record, invocation);
    invocation.phase = "inflight";
    invocation.phases.push("inflight");
    write(location(missionDir, intent), record);
  });
}
function collectDispatchEvidence(
  missionDir,
  record,
  extra = [],
  operation = record.controlOperation ?? "dispatch",
) {
  const state = loadState(missionDir),
    features = loadFeaturesDoc(missionDir).features;
  const projections = [state.activeWorker, ...(state.sessions ?? []), ...features].filter(
    (row) =>
      row?.runId === record.intent.runId &&
      (!row.clientRequestId || row.clientRequestId === record.intent.clientRequestId) &&
      (row.featureId === record.intent.featureId || row.id === record.intent.featureId),
  );
  const bound = projections
    .filter(
      (row) =>
        row.taskId ||
        row.childThreadId ||
        row.childRunId ||
        inspectOwnedLocalWorker(row, missionDir),
    )
    .map((row) =>
      Object.fromEntries(
        [
          "taskId",
          "childThreadId",
          "childRunId",
          "worktreePath",
          "clientRequestId",
          "workerPid",
          "daemonStateFile",
          "runtimeTransport",
        ]
          .filter((key) => row[key] !== undefined)
          .map((key) => [key, row[key]]),
      ),
    );
  const invocations = invocationRecords(record);
  const unowned = [
    ...bound,
    ...(record.phase === "accepted" ? [record.receipt] : []),
    ...(record.unattributedEvidence ?? []),
    ...extra,
  ];
  for (const { observation } of readObservations(missionDir)) {
    if (
      observation.runId !== record.intent.runId ||
      observation.featureId !== record.intent.featureId
    )
      continue;
    if (observation.intentId !== record.intent.clientRequestId) continue;
    if (observation.type === "dispatch") {
      const invocation = observation.invocationId
        ? invocations.find((row) => row.invocationId === observation.invocationId)
        : invocations.length === 1
          ? invocations[0]
          : null;
      if (invocation) {
        invocation.receipts.push(observation.response);
        invocation.phase = "returned";
      } else unowned.push(observation.response);
    } else if (observation.type === "children") {
      try {
        const page = unwrapObservationResponse(observation.response, {}, { allowList: true });
        for (const item of recoveryMatches([page], record.intent, state.ownerThreadId).matches) {
          let identity;
          try {
            identity = recoverTask([[item]], record.intent, state.ownerThreadId);
          } catch {
            identity = item;
          }
          unowned.push({ ...identity, pending: true });
        }
      } catch {
        /* The controller records invalid recovery pages without releasing calls. */
      }
    }
  }
  const effectPrefix = `runtime-dispatch:${record.intent.missionId}:${record.intent.runId}:${record.intent.clientRequestId}`;
  const effectDir = path.join(getMissionPaths(missionDir).baseDir, ".txn", "effects");
  for (const name of listTransactionFiles(effectDir)) {
    const effect = JSON.parse(readTransactionFile(path.join(effectDir, name)));
    if (
      effect.effectId !== effectPrefix &&
      !effect.effectId?.startsWith(effectPrefix + ":not-accepted:")
    )
      continue;
    if (effect.version !== 1 || name !== transactionHash(effect.effectId) + ".json")
      fail("DISPATCH_RECEIPT_CONFLICT", "Runtime effect identity differs");
    if (
      effect.phase === "returned" &&
      effect.responseHash !==
        transactionHash(
          JSON.stringify({ responseDefined: effect.responseDefined, response: effect.response }),
        )
    )
      fail("DISPATCH_RECEIPT_CONFLICT", "Runtime effect checksum differs");
    invocations.push({
      invocationId: `effect:${effect.effectId}`,
      phase: effect.phase === "returned" ? "returned" : "inflight",
      receipts: effect.phase === "returned" ? [effect.response] : [],
    });
  }
  const options = { expectedIdentity: record.intent, operation };
  return { invocations, unowned, options };
}
export function dispatchRecordOutcome(
  missionDir,
  record,
  extra = [],
  operation = record.controlOperation ?? "dispatch",
) {
  const { invocations, unowned, options } = collectDispatchEvidence(
    missionDir,
    record,
    extra,
    operation,
  );
  return mergeInvocationEvidence(invocations, unowned, options);
}

// Historical intents share the evidence reducer, but never regain dispatch authority.
export function dispatchIntentRecords(records) {
  return records.flatMap((record) => [
    record,
    ...(record.invocationHistory ?? []).map((history) => ({
      version: 1,
      phase: "retryable",
      ...history,
      historical: true,
    })),
  ]);
}

export function createTaskStatusOwnerResolver(records, archived, missionId) {
  const intents = dispatchIntentRecords(records).filter(
    (record) => record.intent.missionId === missionId,
  );
  let identities;
  return (observation) => {
    const candidates = intents.filter(
      (record) =>
        record.intent.runId === observation.runId &&
        record.intent.featureId === observation.featureId,
    );
    const threads = [
      ...new Set(
        dispatchReceiptSources(observation.response)
          .map((row) => row.childThreadId)
          .filter(text),
      ),
    ];
    if (!observation.intentId && !identities) {
      identities = new Map(
        intents.map((record) => [
          record.intent.clientRequestId,
          [
            record.receipt,
            ...(record.invocations ?? []).flatMap((row) => [
              ...row.receipts,
              row.exception?.executionEvidence,
            ]),
          ],
        ]),
      );
      for (const { observation: o } of archived) {
        const record = intents.find(
          (row) =>
            (o.intentId ? row.intent.clientRequestId === o.intentId : o.type === "resume") &&
            row.intent.runId === o.runId &&
            row.intent.featureId === o.featureId,
        );
        if (!record) continue;
        const known = identities.get(record.intent.clientRequestId);
        if (o.type === "dispatch") known.push(o.response);
        if (
          o.type === "resume" &&
          classifyControlReceipt(o.response, "resume", record.receipt ?? record.intent.worker)
            .classification === "confirmed"
        ) {
          known.push({
            ...o.response,
            childThreadId: o.response?.childThreadId ?? o.response?.threadId,
          });
        }
        if (o.type === "children") {
          let page;
          try {
            page = unwrapObservationResponse(o.response, {}, { allowList: true });
          } catch (error) {
            if (!(error instanceof MissionKernelError)) throw error;
            continue;
          }
          try {
            for (const item of recoveryMatches(
              [page],
              record.intent,
              record.intent.recovery?.parentThreadId,
            ).matches) {
              try {
                known.push(
                  recoverTask([[item]], record.intent, record.intent.recovery?.parentThreadId),
                );
              } catch (error) {
                if (!(error instanceof MissionKernelError)) throw error;
              }
            }
          } catch (error) {
            if (!(error instanceof MissionKernelError)) throw error;
          }
        }
      }
      identities = new Map(
        [...identities].map(([id, raws]) => [
          id,
          raws.flatMap((raw) => dispatchReceiptSources(raw)),
        ]),
      );
    }
    const matches = observation.intentId
      ? candidates.filter((record) => record.intent.clientRequestId === observation.intentId)
      : candidates.filter((record) =>
          identities
            .get(record.intent.clientRequestId)
            .some(
              (identity) =>
                ((text(observation.taskId) && identity.taskId === observation.taskId) ||
                  (threads.length === 1 && identity.childThreadId === threads[0])) &&
                (!text(observation.taskId) ||
                  !identity.taskId ||
                  identity.taskId === observation.taskId) &&
                threads.every(
                  (thread) => !identity.childThreadId || identity.childThreadId === thread,
                ),
            ),
        );
    if (matches.length !== 1)
      throw new MissionKernelError(
        matches.length ? "TASK_STATUS_OWNERSHIP_AMBIGUOUS" : "TASK_STATUS_OWNERSHIP_UNRESOLVED",
        `task_status must identify exactly one intent; found ${matches.length} for task ${observation.taskId ?? "(missing)"}`,
        {
          runId: observation.runId,
          featureId: observation.featureId,
          taskId: observation.taskId,
          childThreadIds: threads,
          intentIds: matches.map((record) => record.intent.clientRequestId),
        },
      );
    return matches[0];
  };
}

export function refreshDispatchReconciliations(missionDir, state, records, ledger) {
  const before = JSON.stringify(ledger.dispatchReconciliations);
  const archived = readObservations(missionDir);
  const intents = dispatchIntentRecords(records);
  const statusOwners = new Map();
  const resolveStatusOwner = createTaskStatusOwnerResolver(records, archived, state.missionId);
  for (const { observation: o } of archived.filter(
    (row) => row.observation.type === "task_status",
  )) {
    try {
      statusOwners.set(o, resolveStatusOwner(o).intent.clientRequestId);
    } catch (error) {
      if (
        !["TASK_STATUS_OWNERSHIP_AMBIGUOUS", "TASK_STATUS_OWNERSHIP_UNRESOLVED"].includes(
          error.code,
        )
      )
        throw error;
    }
  }
  for (const record of intents) {
    const intent = record.intent,
      run = ledger.runs[intent.runId];
    let gate = ledger.dispatchReconciliations?.[intent.clientRequestId];
    const session = state.sessions?.find((row) => row.runId === intent.runId && row.endedAt);
    const rejected = archived.some(
      (row) =>
        row.id === session?.handoff?.resultObservationId &&
        row.observation.type === "dispatch" &&
        decideDispatchOutcome(row.observation.response, { expectedIdentity: intent }).outcome ===
          "NOT_ACCEPTED",
    );
    if (
      !record.historical &&
      !gate &&
      !(session && (run?.rejectedObservationId || run?.result?.rejectionEvidence || rejected))
    )
      continue;
    const evidence = collectDispatchEvidence(missionDir, record);
    const outcome = mergeInvocationEvidence(
      evidence.invocations,
      evidence.unowned,
      evidence.options,
    );
    const statusScope = (o) => statusOwners.get(o) === intent.clientRequestId;
    const statusFact = archived.some(
      ({ observation: o }) =>
        o.type === "task_status" &&
        o.runId === intent.runId &&
        o.featureId === intent.featureId &&
        statusScope(o) &&
        dispatchReceiptSources(o.response).some(
          (row) => row.taskId || row.childThreadId || row.childRunId,
        ),
    );
    if ((outcome.outcome === "NOT_ACCEPTED" || !outcome.hasDurableEvidence) && !statusFact && !gate)
      continue;
    gate ??= (ledger.dispatchReconciliations ??= {})[intent.clientRequestId] = {
      runId: intent.runId,
      featureId: intent.featureId,
      intentId: intent.clientRequestId,
      code: "DISPATCH_LATE_EXECUTION_EVIDENCE",
      rejectionObservationId: run?.rejectedObservationId,
      evidenceIds: [],
    };
    const facts = `journal:${hash(evidence)}`;
    if (!gate.evidenceIds.includes(facts)) {
      gate.evidenceIds.push(facts);
      delete gate.resolutionId;
    }
    const resolution = ledger.dispatchResolutions?.[gate.resolutionId];
    const terminalIds = resolution?.terminalObservationIds ?? [resolution?.terminalObservationId];
    const stoppedAt = Math.max(
      0,
      ...archived.filter((row) => terminalIds.includes(row.id)).map((row) => row.sequence),
    );
    for (const row of archived) {
      const o = row.observation;
      if (o.runId !== intent.runId || o.featureId !== intent.featureId) continue;
      const scoped = o.intentId === intent.clientRequestId;
      const status = o.type === "task_status" && statusScope(o);
      if (!(scoped && ["dispatch", "children"].includes(o.type)) && !status) continue;
      if (!gate.evidenceIds.includes(row.id)) gate.evidenceIds.push(row.id);
      if (resolution && row.sequence > stoppedAt) delete gate.resolutionId;
    }
  }
  if (before !== JSON.stringify(ledger.dispatchReconciliations)) saveController(missionDir, ledger);
}

export function assertNoUnresolvedDispatch(missionDir, featureId) {
  const state = loadState(missionDir),
    ledger = readController(missionDir, state.missionId);
  const records = inspectDispatchRecords(missionDir);
  refreshDispatchReconciliations(missionDir, state, records, ledger);
  const pending = Object.values(ledger.dispatchReconciliations ?? {}).filter(
    (row) => row.featureId === featureId && !row.resolutionId,
  );
  if (pending.length) {
    const error = new MissionKernelError(
      "DISPATCH_LATE_EXECUTION_EVIDENCE",
      "Original executions are still being reconciled; MissionTick must poll them to terminal before another invocation.",
      { intentIds: pending.map((row) => row.intentId) },
    );
    error.runtimeResult = { accepted: false, preSend: true, code: error.code };
    throw error;
  }
}
export function dispatchRejectionEvidence(missionDir, record) {
  const { invocations, unowned, options } = collectDispatchEvidence(missionDir, record);
  if (mergeInvocationEvidence(invocations, unowned, options).outcome !== "NOT_ACCEPTED")
    return null;
  return invocations.map((row) => ({
    invocationId: row.invocationId,
    receipts: row.receipts.map((raw) => ({ raw, sha256: hash([raw]) })),
    raw: row.receipts.at(-1),
  }));
}

function recordInvocationReturn(
  missionDir,
  intent,
  invocationId,
  result,
  invocationError,
  operation = "dispatch",
  runtimeReturn = false,
) {
  const file = location(missionDir, intent);
  const source = invocationError
    ? Object.hasOwn(invocationError, "runtimeResult")
      ? "runtimeResult"
      : "exception"
    : "return";
  const rawFile = path.join(
    path.dirname(file),
    ".txn",
    "receipts",
    hash([intent.clientRequestId, result, invocationId]) + ".json",
  );
  writeTransactionFile(
    rawFile,
    JSON.stringify({
      version: 1,
      intentId: intent.clientRequestId,
      intent,
      operation,
      invocationId,
      source,
      result,
    }) + "\n",
  );
  mutate(file, (record) => {
    const invocations = invocationRecords(record),
      invocation = invocations.find((row) => row.invocationId === invocationId);
    if (!invocation) fail("INVALID_DISPATCH_INVOCATION", "Returned invocation was not registered");
    if (runtimeReturn && source !== "exception")
      invocation.receipts = invocation.receipts.filter((raw) => !isDeepStrictEqual(raw, {}));
    if (source !== "exception") {
      invocation.phase = "returned";
      invocation.phases = [...new Set([...(invocation.phases ?? []), "returned"])];
      invocation.receipts = [
        ...new Map([...invocation.receipts, result].map((raw) => [hash([raw]), raw])).values(),
      ];
    }
    if (
      source === "exception" &&
      invocation.runtimeClaimed &&
      !invocation.receipts.some((raw) => isDeepStrictEqual(raw, {}))
    )
      invocation.receipts.push({});
    if (invocationError) {
      const cause = invocationError.cause ?? invocationError;
      invocation.exception = {
        code: invocationError.code,
        message: invocationError.message,
        hookSource: invocationError.hookSource ?? "dispatchExecutor",
        executionEvidence: Object.fromEntries(
          ["taskId", "childThreadId", "childRunId", "workerPid", "daemonStateFile"]
            .filter((key) => cause?.[key] !== undefined)
            .map((key) => [key, cause[key]]),
        ),
        ...(cause?.syscall
          ? { spawnError: { code: cause.code, syscall: cause.syscall, path: cause.path } }
          : {}),
      };
    }
    write(file, {
      ...record,
      invocations,
      invocationPhase: invocations.some((row) => row.phase !== "returned")
        ? "inflight"
        : "returned",
    });
  });
}

/** Runtime entry consumes the outer invocation token before any external work. */
export async function dispatchRuntimeInvocation(missionDir, payload, invoke, validate) {
  const intent = missionTransaction(
    missionDir,
    () => {
      const record = inspectDispatchRecords(missionDir).find(
        (row) => row.intent.runId === payload.runId && row.intent.featureId === payload.feature?.id,
      );
      const invocationId = payload.invocationId ?? payload.feature?.invocationId;
      const invocation = record?.invocations?.find((row) => row.invocationId === invocationId);
      if (
        !record ||
        !invocation ||
        invocation.source === "legacy" ||
        !invocation.invocationId.startsWith("inv:") ||
        invocation.phase !== "inflight" ||
        invocation.runtimeClaimed ||
        payload.missionId !== record.intent.missionId ||
        payload.feature?.clientRequestId !== record.intent.clientRequestId ||
        !isDeepStrictEqual(
          canonical({
            providerInstanceId: payload.slotConfig?.providerInstanceId,
            model: payload.slotConfig?.model,
            options: payload.slotConfig?.options ?? {},
          }),
          record.intent.target,
        )
      )
        fail(
          "INVALID_DISPATCH_INVOCATION",
          "Runtime requires an unused outer invocation token for this exact intent and target",
        );
      validate();
      assertNoUnresolvedDispatch(missionDir, record.intent.featureId);
      assertInvocationBudget(missionDir, record, invocation);
      invocation.runtimeClaimed = true;
      invocation.receipts.push({}); // Unknown effect is durable before entering transport.
      write(location(missionDir, record.intent), record);
      return record.intent;
    },
    { create: false },
  );
  let response, error;
  try {
    response = await invoke();
  } catch (cause) {
    error = cause;
    response = Object.hasOwn(cause, "runtimeResult") ? cause.runtimeResult : undefined;
  }
  missionTransaction(missionDir, () =>
    recordInvocationReturn(
      missionDir,
      intent,
      payload.invocationId ?? payload.feature.invocationId,
      response,
      error,
      "dispatch",
      true,
    ),
  );
  if (error) throw error;
  return response;
}

/** Preserve attribution before a reducer, failure consumer or public replay runs. */
export function retainDispatchEvidence(missionDir, intent, raw, invocationId) {
  return mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Evidence belongs to another intent");
    const next = { ...record, invocations: invocationRecords(record) };
    const invocation = invocationId
      ? next.invocations.find((row) => row.invocationId === invocationId)
      : next.invocations.length === 1
        ? next.invocations[0]
        : null;
    if (invocation) {
      if (invocation.source === "legacy") invocation.source = "owner";
      invocation.receipts = [
        ...new Map([...invocation.receipts, raw].map((value) => [hash([value]), value])).values(),
      ];
      invocation.phase = "returned";
      invocation.phases = [
        ...new Set([...(invocation.phases ?? ["prepared", "inflight"]), "returned"]),
      ];
    } else
      next.unattributedEvidence = [
        ...new Map(
          [...(record.unattributedEvidence ?? []), raw].map((value) => [hash([value]), value]),
        ).values(),
      ];
    const outcome = dispatchRecordOutcome(missionDir, next);
    next.invocationPhase = next.invocations.some((row) => row.phase !== "returned")
      ? "inflight"
      : "returned";
    if (record.phase !== "accepted" && ["UNKNOWN", "CONFLICT"].includes(outcome.outcome))
      next.phase = "inflight";
    if (!isDeepStrictEqual(next, record)) write(location(missionDir, intent), next);
    return outcome;
  });
}

export function fenceDispatchEvidence(missionDir, intent) {
  return mutate(location(missionDir, intent), (record) => {
    if (!record || !isDeepStrictEqual(record.intent, intent))
      fail("DISPATCH_INTENT_CONFLICT", "Fence belongs to another intent");
    if (!["accepted", "inflight"].includes(record.phase))
      write(location(missionDir, intent), { ...record, phase: "inflight" });
  });
}

function clearControllerRejection(missionDir, intent, outcome) {
  const ledger = readController(missionDir, intent.missionId),
    run = ledger.runs[intent.runId];
  if (!run || run.intentId !== intent.clientRequestId) return;
  clearDispatchRejection(run);
  delete run.dispatchError;
  if (outcome) {
    run.dispatchDecision = outcome;
    if (outcome.outcome === "UNKNOWN") run.failure = { kind: "acceptance_unknown" };
    else if (outcome.outcome === "CONFLICT")
      run.dispatchError = {
        code: outcome.errorCode,
        message: "Durable dispatch identities conflict",
        diagnostics: outcome.diagnostics,
      };
  }
  saveController(missionDir, ledger);
}
function parseReceipt(result, intent, operation = "dispatch") {
  const verdict = decideDispatchOutcome(result, { expectedIdentity: intent, operation });
  if (verdict.outcome === "CONFLICT" || (verdict.outcome === "UNKNOWN" && verdict.errorCode))
    throw new MissionKernelError(
      verdict.errorCode,
      "Dispatch receipt is unconfirmed; reconcile the original intent",
      { dispatchDecision: verdict },
    );
  if (verdict.outcome !== "ACCEPTED") return null;
  const receipt = { ...verdict.identity, clientRequestId: intent.clientRequestId };
  if (isRemoteWorker(receipt))
    for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) delete receipt[key];
  return receipt;
}

function verifiedRecoveryReceipt(raw, intent, missionDir) {
  const receipt = parseReceipt(raw, intent);
  if (
    receipt &&
    !isRemoteWorker(receipt) &&
    ["workerPid", "daemonStateFile", "daemonStatus"].some((key) => Object.hasOwn(receipt, key)) &&
    !inspectOwnedLocalWorker({ ...intent.worker, ...receipt }, missionDir)
  )
    fail(
      "DISPATCH_OUTCOME_UNKNOWN",
      "Recovered runtime ownership is unverified; do not redispatch",
    );
  return receipt;
}

function acceptedResult(record) {
  if (
    decideDispatchOutcome(record.receipt, { expectedIdentity: record.intent }).outcome !==
    "ACCEPTED"
  )
    fail("INVALID_DISPATCH_JOURNAL", "Accepted replay lacks a valid receipt for this intent");
  return {
    ...record.receipt,
    ...record.result,
    ...record.receipt,
    accepted: true,
    dispatchPending: false,
  };
}
/** One child-creating executor per durable intent; accepted replay never invokes it. */
function* dispatchWithIntentSteps(missionDir, intent, invoke, { operation = "dispatch" } = {}) {
  const file = location(missionDir, intent);
  const cached = mutate(file, (record) => {
    record = recoverRaw(file, record);
    if (
      !record ||
      record.intent.runId !== intent.runId ||
      record.intent.clientRequestId !== intent.clientRequestId
    )
      fail("DISPATCH_INTENT_CONFLICT", "Dispatch intent changed before transport");
    const merged = dispatchRecordOutcome(missionDir, record, [], operation);
    if (merged.outcome === "CONFLICT") {
      if (record.phase !== "accepted") write(file, { ...record, phase: "inflight" });
      return {
        kind: "blocked",
        error: new MissionKernelError(merged.errorCode, "Durable dispatch evidence conflicts", {
          dispatchDecision: merged,
        }),
      };
    }
    if (merged.outcome === "ACCEPTED" && record.phase !== "accepted") {
      let receipt;
      try {
        receipt = verifiedRecoveryReceipt(merged.identity, intent, missionDir);
      } catch (error) {
        write(file, { ...record, phase: "inflight" });
        return { kind: "blocked", error };
      }
      record = { ...record, phase: "accepted", receipt, result: {} };
      persistAccepted(file, record);
    }
    if (record.phase === "accepted") {
      clearControllerRejection(missionDir, intent);
      return { kind: "accepted", result: acceptedResult(record) };
    }
    if (
      (record.phase === "prepared" && merged.outcome === "UNKNOWN" && merged.hasDurableEvidence) ||
      (record.phase === "retryable" && merged.outcome !== "NOT_ACCEPTED")
    ) {
      write(file, { ...record, phase: "inflight" });
      return {
        kind: "blocked",
        error: new MissionKernelError(
          "DISPATCH_OUTCOME_UNKNOWN",
          "Durable evidence forbids dispatch; recover the original intent",
        ),
      };
    }
    if (record.phase === "inflight")
      fail(
        "DISPATCH_OUTCOME_UNKNOWN",
        "Previous dispatch outcome is unknown; recover its receipt before retrying",
      );
    assertNoUnresolvedDispatch(missionDir, intent.featureId);
    const invocation = registerInvocation(missionDir, record, operation);
    write(file, {
      ...record,
      phase: "inflight",
      controlOperation: operation,
      invocationPhase: "inflight",
    });
    return { kind: "claimed", invocationId: invocation.invocationId };
  });
  if (cached.kind === "accepted") return cached.result;
  if (cached.kind === "blocked") {
    yield () => undefined;
    throw cached.error;
  }
  yield () => undefined; // Commit prepared registration before entering transport.
  try {
    assertNoUnresolvedDispatch(missionDir, intent.featureId);
    markDispatchInvocationInflight(missionDir, intent, cached.invocationId);
  } catch (error) {
    if (error.runtimeResult)
      recordInvocationReturn(
        missionDir,
        intent,
        cached.invocationId,
        error.runtimeResult,
        error,
        operation,
      );
    throw error;
  }
  let result, invocationError;
  try {
    result = yield () => invoke({ ...intent, invocationId: cached.invocationId });
  } catch (cause) {
    invocationError = cause && typeof cause === "object" ? cause : new Error(String(cause));
    result = Object.hasOwn(invocationError, "runtimeResult")
      ? invocationError.runtimeResult
      : undefined;
  }
  recordInvocationReturn(
    missionDir,
    intent,
    cached.invocationId,
    result,
    invocationError,
    operation,
  );
  yield () => undefined;
  const settled = mutate(file, (record) => {
    // A formal Bind inside the callback is already authoritative, including when
    // the callback subsequently returns pending or conflicting metadata.
    if (record.phase === "accepted") {
      if (invocationError)
        write(file, {
          ...record,
          lastOutcome: {
            ...record.lastOutcome,
            hookFailed: true,
            hookSource: invocationError.hookSource ?? "dispatchExecutor",
            error: invocationError.message,
          },
        });
      return invocationError ? { error: invocationError } : { result: acceptedResult(record) };
    }
    const outcome = dispatchRecordOutcome(missionDir, record, [], operation);
    if (invocationError && outcome.outcome !== "ACCEPTED") {
      const rejected = outcome.outcome === "NOT_ACCEPTED";
      write(file, {
        ...record,
        phase: rejected ? "retryable" : "inflight",
        observedReceipt: result,
        lastOutcome: {
          kind: rejected ? outcome.controlReceipt.classification : "unknown",
          error: invocationError.message,
          hookSource: invocationError.hookSource ?? "dispatchExecutor",
          hookFailed: true,
          dispatchDecision: outcome,
        },
      });
      if (["UNKNOWN", "CONFLICT"].includes(outcome.outcome))
        clearControllerRejection(missionDir, intent, outcome);
      return {
        error: rejected
          ? invocationError
          : new MissionKernelError(
              outcome.errorCode || "DISPATCH_OUTCOME_UNKNOWN",
              "Transport failed; reconcile its original acceptance outcome",
              {
                dispatchDecision: outcome,
                ...(invocationError.hudHookFailed ? { hudHookFailed: true } : {}),
                ...(invocationError.hookSource ? { hookSource: invocationError.hookSource } : {}),
              },
            ),
      };
    }
    let receipt;
    try {
      receipt =
        outcome.outcome === "ACCEPTED"
          ? parseReceipt(outcome.identity, intent)
          : parseReceipt(result, intent, operation);
      if (
        receipt &&
        !isRemoteWorker(receipt) &&
        ["workerPid", "daemonStateFile", "daemonStatus"].some((key) =>
          Object.hasOwn(receipt, key),
        ) &&
        !inspectOwnedLocalWorker({ ...intent.worker, ...receipt }, missionDir)
      ) {
        const localClaim = receipt.runtimeTransport === "bridge-cli-subprocess";
        for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) delete receipt[key];
        if (localClaim || (!receipt.taskId && !receipt.childThreadId && !receipt.childRunId))
          fail(
            "DISPATCH_OUTCOME_UNKNOWN",
            "Local runtime ownership is unverified; do not redispatch",
          );
      }
    } catch (error) {
      const observed = result;
      write(file, {
        ...record,
        observedReceipt: observed,
        lastOutcome: { kind: "unknown", dispatchDecision: outcome },
      });
      error.runtimeResult = observed;
      if (["UNKNOWN", "CONFLICT"].includes(outcome.outcome))
        clearControllerRejection(missionDir, intent, outcome);
      return { error };
    }
    if (!receipt) {
      const retryable = outcome.outcome === "NOT_ACCEPTED";
      write(file, {
        ...record,
        phase: retryable ? "retryable" : "inflight",
        observedReceipt: result,
        lastOutcome: {
          kind: retryable ? outcome.controlReceipt.classification : "unknown",
          dispatchDecision: outcome,
        },
      });
      if (["UNKNOWN", "CONFLICT"].includes(outcome.outcome))
        clearControllerRejection(missionDir, intent, outcome);
      return { result };
    }
    persistAccepted(file, {
      ...record,
      phase: "accepted",
      receipt,
      ...(invocationError
        ? {
            lastOutcome: {
              hookFailed: true,
              hookSource: invocationError.hookSource ?? "dispatchExecutor",
              error: invocationError.message,
              dispatchDecision: outcome,
            },
          }
        : {}),
      result: {
        ...(result?.resumed === true ? { resumed: true } : {}),
        ...(result?.canResume === true ? { canResume: true } : {}),
        ...(result?.handoff
          ? {
              handoff: result.handoff,
              successState: result.successState,
              validatorsPassed: result.validatorsPassed,
            }
          : {}),
      },
    });
    clearControllerRejection(missionDir, intent);
    if (invocationError) return { error: invocationError };
    const normalized = { ...result, ...receipt };
    for (const key of ["workerPid", "daemonStateFile", "daemonStatus"])
      if (!Object.hasOwn(receipt, key)) delete normalized[key];
    return { result: normalized };
  });
  // A transport failure must reach the caller after its durable outcome commits.
  if (settled.error) {
    if (invocationError?.hudHookFailed) settled.error.hudHookFailed = true;
    if (invocationError?.hookSource) settled.error.hookSource = invocationError.hookSource;
    yield () => undefined;
    throw settled.error;
  }
  return settled.result;
}
/** Called only after Bind's existing identity, target and revision checks pass. */
function recordAcceptedDispatchImpl(missionDir, state, feature, result) {
  const worker = state.activeWorker;
  const intent = prepareDispatch(missionDir, {
    state,
    feature,
    worker: { ...worker, clientRequestId: result.clientRequestId || worker.clientRequestId },
    target: worker,
  });
  const file = location(missionDir, intent),
    receipt = parseReceipt(result, intent);
  if (!receipt) fail("INVALID_DISPATCH_BINDING", "Binding requires an accepted receipt");
  retainDispatchEvidence(missionDir, intent, result);
  mutate(file, (record) => {
    const merged = dispatchRecordOutcome(missionDir, record, [result]);
    if (merged.outcome === "CONFLICT")
      throw new MissionKernelError(
        merged.errorCode,
        "Binding conflicts with durable dispatch evidence",
        { dispatchDecision: merged },
      );
    if (record.phase === "accepted") {
      for (const key of identityKeys)
        if (receipt[key] && record.receipt[key] && receipt[key] !== record.receipt[key])
          fail("DISPATCH_BINDING_CONFLICT", `Accepted journal ${key} differs`);
      if (
        Object.entries(receipt).every(([key, value]) =>
          isDeepStrictEqual(record.receipt[key], value),
        )
      )
        return;
      persistAccepted(file, { ...record, receipt: { ...record.receipt, ...receipt } });
      return;
    }
    persistAccepted(file, { ...record, phase: "accepted", receipt, result: {} });
  });
  clearControllerRejection(missionDir, intent);
  return intent;
}
/** Pure, all-record receipt merge. It never revives a completed or replaced run. */
export function mergeDispatchReceipt(state, featuresDoc, result, intent) {
  const receipt = parseReceipt(result, intent);
  if (
    !receipt ||
    state.activeWorker?.runId !== intent.runId ||
    state.activeWorker.featureId !== intent.featureId
  )
    return { state, featuresDoc, changed: false };
  const sessions = (state.sessions || []).filter((s) => s.runId === intent.runId);
  const featureIndex = featuresDoc.features.findIndex(
    (f) => f.id === intent.featureId && (!f.runId || f.runId === intent.runId),
  );
  if (
    sessions.length !== 1 ||
    sessions[0].featureId !== intent.featureId ||
    featureIndex < 0 ||
    !["running", "paused"].includes(featuresDoc.features[featureIndex].status) ||
    !["running", "paused"].includes(state.status)
  )
    fail("STALE_DISPATCH_BINDING", "Receipt does not match the active run projections");
  const records = [state.activeWorker, sessions[0], featuresDoc.features[featureIndex]];
  for (const record of records) {
    for (const key of identityKeys)
      if (record[key] && receipt[key] && record[key] !== receipt[key])
        fail("DISPATCH_BINDING_CONFLICT", `Existing ${key} belongs to another dispatch`);
  }
  for (const record of records.slice(0, 2)) {
    for (const key of ["providerInstanceId", "model", "options"])
      if (
        !isDeepStrictEqual(
          canonical(record[key] ?? (key === "options" ? {} : undefined)),
          intent.target[key],
        )
      )
        fail("DISPATCH_TARGET_CONFLICT", `Recorded ${key} differs from the dispatch intent`);
  }
  const attach = (record) => {
    let next = { ...record, ...receipt };
    delete next.dispatchPending;
    if (isRemoteWorker(next)) next = stripLocalWorkerMetadata(next);
    if (
      receipt.runtimeTransport === undefined &&
      ["hud-default-runtime", "bridge-cli-subprocess", "orchestrator-pending"].includes(
        next.runtimeTransport,
      )
    )
      delete next.runtimeTransport;
    if (next.delegatedBy === "hud-default-runtime") delete next.delegatedBy;
    return next;
  };
  const nextState = {
    ...state,
    activeWorker: attach(state.activeWorker),
    sessions: state.sessions.map((s) => (s.runId === intent.runId ? attach(s) : s)),
  };
  const nextFeatures = {
    ...featuresDoc,
    features: featuresDoc.features.map((feature, index) => {
      if (index !== featureIndex) return feature;
      const next = attach(feature);
      if (
        state.status === "running" &&
        state.activeWorker.status === "running" &&
        next.status === "paused"
      ) {
        next.status = "running";
        delete next.pausedAt;
      }
      return next;
    }),
  };
  return {
    state: nextState,
    featuresDoc: nextFeatures,
    changed: !isDeepStrictEqual(nextState, state) || !isDeepStrictEqual(nextFeatures, featuresDoc),
  };
}

export function inspectDispatchIntent(dir, ...args) {
  return missionTransaction(dir, (tx) => (tx ? inspectDispatchIntentImpl(dir, ...args) : null), {
    create: false,
  });
}

export function claimDispatchIntent(dir, ...args) {
  return missionTransaction(dir, () => claimDispatchIntentImpl(dir, ...args));
}

export function inspectDispatchRecords(dir, ...args) {
  return missionTransaction(dir, (tx) => (tx ? inspectDispatchRecordsImpl(dir, ...args) : []), {
    create: false,
  });
}

export function observeDispatchReceipt(dir, ...args) {
  return missionTransaction(dir, () => observeDispatchReceiptImpl(dir, ...args));
}

export function observeDispatchRejection(dir, ...args) {
  return missionTransaction(dir, () => observeDispatchRejectionImpl(dir, ...args));
}

export function prepareDispatch(dir, ...args) {
  return missionTransaction(dir, () => prepareDispatchImpl(dir, ...args));
}

export function recordAcceptedDispatch(dir, ...args) {
  return missionTransaction(dir, () => recordAcceptedDispatchImpl(dir, ...args));
}

export async function dispatchWithIntent(dir, ...args) {
  return runMissionSteps(dir, dispatchWithIntentSteps(dir, ...args));
}
