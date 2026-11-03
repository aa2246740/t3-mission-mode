import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "node:url";
import { getMissionPaths } from "./store.mjs";

function resolvedMissionBase(missionDir) {
  const base = getMissionPaths(missionDir).baseDir;
  return fs.existsSync(base)
    ? fs.realpathSync(base)
    : path.join(fs.realpathSync(path.dirname(base)), path.basename(base));
}

const cliPath = fileURLToPath(new URL("../bridge/cli.mjs", import.meta.url));
export const isRemoteWorker = (worker) =>
  ["t3-delegate-task", "t3-acp-mcp"].includes(worker?.runtimeTransport);

/** Remote projections must not retain ownership claims for a local process. */
export function stripLocalWorkerMetadata(record) {
  const next = { ...record };
  for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) delete next[key];
  return next;
}

/** A PID is usable only when its current CLI command and daemon record agree. */
export function inspectOwnedLocalWorker(worker, missionDir) {
  if (
    !worker ||
    isRemoteWorker(worker) ||
    !Number.isSafeInteger(worker.workerPid) ||
    worker.workerPid <= 0 ||
    worker.workerPid === process.pid ||
    typeof worker.daemonStateFile !== "string" ||
    !path.isAbsolute(worker.daemonStateFile) ||
    !missionDir
  )
    return null;
  try {
    if (!fs.lstatSync(worker.daemonStateFile).isFile()) return null;
    const bytes = fs.readFileSync(worker.daemonStateFile, "utf8");
    const daemon = JSON.parse(bytes);
    if (
      daemon.pid !== worker.workerPid ||
      typeof daemon.runId !== "string" ||
      !daemon.runId ||
      typeof daemon.featureId !== "string" ||
      !daemon.featureId ||
      typeof daemon.missionDir !== "string" ||
      !path.isAbsolute(daemon.missionDir) ||
      typeof daemon.repoPath !== "string" ||
      !path.isAbsolute(daemon.repoPath) ||
      (worker.runId && worker.runId !== daemon.runId) ||
      (worker.featureId && worker.featureId !== daemon.featureId) ||
      resolvedMissionBase(daemon.missionDir) !== resolvedMissionBase(missionDir)
    )
      return null;
    const args =
      process.platform === "linux"
        ? fs
            .readFileSync(`/proc/${worker.workerPid}/cmdline`, "utf8")
            .replace(/\0$/, "")
            .split("\0")
        : process.platform === "darwin"
          ? require(`../native/mission-lock-${process.platform}-${process.arch}.node`).processArgs(
              worker.workerPid,
            )
          : null;
    const expected = [
      cliPath,
      "LocalWorkerDaemon",
      "--mission-dir",
      daemon.missionDir,
      "--repo-path",
      daemon.repoPath,
      "--run-id",
      daemon.runId,
      "--feature-id",
      daemon.featureId,
      "--state-file",
      worker.daemonStateFile,
    ];
    if (
      !args ||
      ![process.execPath, path.basename(process.execPath), "node"].includes(args[0]) ||
      args.length !== expected.length + 1 ||
      !expected.every((value, i) => value === args[i + 1])
    )
      return null;
    const command = args.join(" ");
    return { pid: worker.workerPid, stateFile: worker.daemonStateFile, bytes, command, daemon };
  } catch {
    return null;
  }
}

export function signalOwnedLocalWorker(worker, missionDir, signal) {
  const owned = inspectOwnedLocalWorker(worker, missionDir);
  if (!owned) return false;
  try {
    process.kill(owned.pid, signal);
  } catch {
    return false;
  }
  if (signal === "SIGTERM") {
    try {
      if (fs.readFileSync(owned.stateFile, "utf8") === owned.bytes) fs.unlinkSync(owned.stateFile);
    } catch {
      /* The verified daemon can remove its own file as it exits. */
    }
  }
  return true;
}
