import {
  missionTransaction,
  readTransactionFile,
  writeTransactionFile,
  listTransactionFiles,
} from "./mission-transaction.mjs";

import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getMissionPaths } from "./store.mjs";
import {
  MissionKernelError,
  unwrapObservationResponse,
  dispatchReceiptSources,
} from "./schema.mjs";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digest = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const autopilotDir = (missionDir) =>
  path.join(getMissionPaths(missionDir).baseDir, "autopilot");

function readControllerImpl(missionDir, missionId) {
  const file = path.join(autopilotDir(missionDir), "controller.json");
  if (readTransactionFile(file) === null)
    return { version: 1, missionId, observations: {}, runs: {} };
  const record = JSON.parse(readTransactionFile(file));
  if (
    record.version !== 1 ||
    record.missionId !== missionId ||
    !record.observations ||
    !record.runs
  )
    throw new MissionKernelError(
      "INVALID_CONTROLLER_STATE",
      "Autopilot ledger does not match this Mission",
    );
  return record;
}

/** Changed records are fsynced; identical records do not create a temporary file. */
export function writeDurable(file, value) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (readTransactionFile(file) === bytes) return;
  writeTransactionFile(file, bytes);
}
function saveControllerImpl(missionDir, ledger) {
  writeDurable(path.join(autopilotDir(missionDir), "controller.json"), ledger);
}

function routineProgress(observation, archived) {
  if (observation.type !== "task_status") return false;
  let status;
  try {
    status = unwrapObservationResponse(observation.response, { taskId: observation.taskId });
  } catch {
    return false;
  }
  if (
    !["queued", "running", "waiting"].includes(status.status) ||
    !["working", "waiting_for_children"].includes(status.workState) ||
    typeof status.hasPendingChildRuns !== "boolean" ||
    dispatchReceiptSources(observation.response).some(
      (row) => row.accepted === false || row.isError === true || row.error,
    )
  )
    return false;
  const keys = [
    "taskId",
    "childThreadId",
    "childRunId",
    "clientRequestId",
    "worktreePath",
    "workerPid",
    "daemonStateFile",
  ];
  const known = archived
    .filter((row) => row.observation.runId === observation.runId)
    .flatMap((row) => dispatchReceiptSources(row.observation.response));
  if (
    !status.taskId ||
    !known.some((row) => keys.every((key) => status[key] === undefined || row[key] === status[key]))
  )
    return false;
  if (
    status.pendingChildRuns !== undefined &&
    (!Array.isArray(status.pendingChildRuns) ||
      status.pendingChildRuns.some(
        (child) =>
          !known.some((row) =>
            row.pendingChildRuns?.some((item) => isDeepStrictEqual(item, child)),
          ),
      ))
  )
    return false;
  return true;
}

function archiveObservationImpl(missionDir, observation) {
  const contentHash = digest(observation);
  let id = contentHash;
  let file = path.join(autopilotDir(missionDir), "observations", `${id}.json`);
  if (readTransactionFile(file) !== null) return id;
  const archived = readObservations(missionDir);
  const progress = routineProgress(observation, archived);
  if (progress) {
    id = digest(["progress", observation.runId]);
    file = path.join(autopilotDir(missionDir), "observations", `${id}.json`);
  }
  const previous = progress && readTransactionFile(file);
  const prior = previous ? JSON.parse(previous) : null;
  if (prior?.contentHash === contentHash) return id;
  const sequence = Math.max(0, ...archived.map((item) => item.sequence)) + 1;
  writeDurable(file, {
    version: 1,
    sequence,
    observation,
    ...(progress ? { contentHash, progressCount: (prior?.progressCount ?? 0) + 1 } : {}),
  });
  return id;
}
function readObservationsImpl(missionDir) {
  const dir = path.join(autopilotDir(missionDir), "observations");
  const sequences = new Set();
  return listTransactionFiles(dir)
    .filter((name) => /^[a-f0-9]+\.json$/.test(name))
    .map((name) => {
      const record = JSON.parse(readTransactionFile(path.join(dir, name)));
      const validHash =
        record.progressCount === undefined
          ? digest(record.observation) === name.slice(0, -5)
          : Number.isSafeInteger(record.progressCount) &&
            record.progressCount > 0 &&
            digest(record.observation) === record.contentHash &&
            record.observation.type === "task_status" &&
            name.slice(0, -5) === digest(["progress", record.observation.runId]);
      if (
        record.version !== 1 ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence < 1 ||
        !validHash
      )
        throw new MissionKernelError(
          "INVALID_OBSERVATION_ARCHIVE",
          "Observation archive is malformed or its content hash differs",
        );
      if (sequences.has(record.sequence))
        throw new MissionKernelError(
          "INVALID_OBSERVATION_ARCHIVE",
          "Observation archive has duplicate sequence numbers; preserve the original records for recovery",
        );
      sequences.add(record.sequence);
      return {
        id: name.slice(0, -5),
        sequence: record.sequence,
        observation: record.observation,
        ...(record.progressCount === undefined ? {} : { progressCount: record.progressCount }),
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
}
const controllerReads = new WeakMap();
export function readController(dir, ...args) {
  return missionTransaction(
    dir,
    () => {
      const record = readControllerImpl(dir, ...args);
      controllerReads.set(
        record,
        readTransactionFile(path.join(autopilotDir(dir), "controller.json")),
      );
      return record;
    },
    { create: false },
  );
}
export function saveController(dir, record) {
  return missionTransaction(dir, () => {
    const file = path.join(autopilotDir(dir), "controller.json");
    const before = controllerReads.get(record);
    const current = readTransactionFile(file);
    if (
      before !== undefined &&
      current !== before &&
      current !== JSON.stringify(record, null, 2) + "\n"
    )
      throw new MissionKernelError(
        "TX_STALE_REVISION",
        "Autopilot ledger changed since it was read; reload and reduce in one transaction",
      );
    saveControllerImpl(dir, record);
    controllerReads.set(record, readTransactionFile(file));
  });
}
export function archiveObservation(dir, ...args) {
  return missionTransaction(dir, () => archiveObservationImpl(dir, ...args), { create: true });
}
export function readObservations(dir, ...args) {
  return missionTransaction(dir, (tx) => (tx ? readObservationsImpl(dir, ...args) : []), {
    create: false,
  });
}
