#!/usr/bin/env node
import {
  inspectLocalWorkerLifetime,
  writeLocalWorkerMarker,
  removeLocalWorkerMarker,
  isLocalWorkerMarkerOwned,
} from "../kernel/local-worker-lifecycle.mjs";
import { signalOwnedLocalWorker, isRemoteWorker } from "../kernel/worker-process.mjs";
import {
  decideDispatchOutcome,
  classifyControlReceipt,
  inspectRunDispatchBinding,
} from "../kernel/schema.mjs";
import { workerDispatchBlockReason } from "../kernel/runner.mjs";
import { getMissionPaths, tryLoadState, loadFeaturesDoc } from "../kernel/store.mjs";
import {
  missionTransaction,
  readTransactionFile,
  runClaimedEffect,
  transactionHash,
} from "../kernel/mission-transaction.mjs";
import { dispatchRuntimeInvocation } from "../kernel/dispatch-journal.mjs";
import { preSendFailure } from "./t3-adapter.mjs";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callMissionTool,
  MISSION_TOOLS,
  resolveCanonicalToolName,
  startStdioMcpServer,
} from "./mcp-server.mjs";
import { callT3McpTool, runFeature } from "./t3-adapter.mjs";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid) {
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

function runtimeDispatchBlockReasonImpl(missionDir, payload) {
  const current = tryLoadState(missionDir);
  // Incomplete standalone state has no lifecycle gate. External work still requires a registered invocation.
  if (
    !current ||
    (current.initialized === undefined && current.planAccepted === undefined && !current.missionId)
  )
    return null;
  const state = current,
    doc = loadFeaturesDoc(missionDir);
  const binding = inspectRunDispatchBinding(current, doc.features);
  if (binding.hasIdentity || binding.requiresBinding) return "DISPATCH_BINDING_REQUIRED";
  if (payload.dispatchPreflight) {
    const paths = getMissionPaths(missionDir);
    for (const key of ["statePath", "featuresPath", "modelSettingsPath", "progressLogPath"]) {
      const bytes = readTransactionFile(paths[key]);
      if (
        payload.dispatchPreflight.base?.[key] !== (bytes === null ? null : transactionHash(bytes))
      )
        return "MISSION_STATE_CHANGED";
    }
  }
  const worker = {
    runId: payload.runId || payload.feature?.runId,
    featureId: payload.feature?.id || payload.featureId,
  };
  if (payload.missionId !== state.missionId) return "MISSION_REPLACED";
  return workerDispatchBlockReason(state, worker, doc);
}

function runtimeDispatchBlockReason(dir, payload) {
  return missionTransaction(dir, () => runtimeDispatchBlockReasonImpl(dir, payload), {
    create: false,
  });
}

async function runtimeEffect(missionDir, kind, worker, invoke, dispatchPayload) {
  if (kind === "dispatch")
    return dispatchRuntimeInvocation(missionDir, dispatchPayload, invoke, () => {
      const reason = runtimeDispatchBlockReasonImpl(missionDir, dispatchPayload);
      if (reason)
        throw preSendFailure(
          Object.assign(new Error(reason), { code: "MISSION_NOT_DISPATCHABLE" }),
        );
    });
  const state = tryLoadState(missionDir);
  if (!state?.missionId) return invoke(undefined);
  const runId = worker.runId ?? state.activeWorker?.runId;
  if (!runId)
    throw Object.assign(new Error("Runtime control requires a durable Mission run"), {
      code: "MISSING_RUN_IDENTITY",
    });
  const suffix = worker.controlRequestId ?? state.pauseEpoch ?? state.pausedAt ?? "legacy";
  const effectId = `runtime-${kind}:${state.missionId}:${runId}:${suffix}`;
  return runClaimedEffect(
    missionDir,
    effectId,
    () => invoke("t3-runtime:" + transactionHash(effectId)),
    {
      validate: () => {
        const current = tryLoadState(missionDir);
        if (
          current?.missionId !== state.missionId ||
          current.revision !== state.revision ||
          current.activeWorker?.runId !== runId
        )
          throw preSendFailure(
            Object.assign(new Error("Runtime owner changed before effect claim"), {
              code: "MISSION_STATE_CHANGED",
            }),
          );
        if (
          kind === "resume" &&
          (current.planAccepted !== true ||
            !["running", "paused", "orchestrator_turn"].includes(current.status) ||
            (worker.pausedAt !== undefined && worker.pausedAt !== current.activeWorker.pausedAt))
        )
          throw Object.assign(new Error("Current gate refuses the old Resume"), {
            code: "MISSION_NOT_DISPATCHABLE",
          });
      },
    },
  );
}

/**
 * Parse command-line arguments for `t3-mission/bridge/cli.mjs`.
 *
 * Supported invocation:
 *   `node t3-mission/bridge/cli.mjs <command> --mission-dir <dir> [--json <payload>]`
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {{
 *   command: string,
 *   missionDir: string,
 *   payload: Record<string, unknown>,
 *   help: boolean
 * }}
 */
export function parseCliArgs(argv = process.argv.slice(2), options = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let command = "";
  let missionDir = "";
  let rawJson = "";
  let help = false;
  const extraFlags = {};

  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--mission-dir" || token === "--dir" || token === "-d") {
      missionDir = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--mission-dir=")) {
      missionDir = token.slice("--mission-dir=".length).trim();
      continue;
    }
    if (token.startsWith("--dir=")) {
      missionDir = token.slice("--dir=".length).trim();
      continue;
    }

    if (token === "--stdin") {
      rawJson = "-";
      continue;
    }
    if (token === "--json" || token === "-j") {
      rawJson = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--json=")) {
      rawJson = token.slice("--json=".length).trim();
      continue;
    }

    if (token === "--repo-path") {
      extraFlags.repoPath = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--repo-path=")) {
      extraFlags.repoPath = token.slice("--repo-path=".length).trim();
      continue;
    }

    if (token === "--worktree-path") {
      extraFlags.worktreePath = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--worktree-path=")) {
      extraFlags.worktreePath = token.slice("--worktree-path=".length).trim();
      continue;
    }

    if (token === "--feature-id") {
      extraFlags.featureId = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--feature-id=")) {
      extraFlags.featureId = token.slice("--feature-id=".length).trim();
      continue;
    }

    if (token === "--run-id") {
      extraFlags.runId = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--run-id=")) {
      extraFlags.runId = token.slice("--run-id=".length).trim();
      continue;
    }

    if (token === "--state-file") {
      extraFlags.stateFile = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--state-file=")) {
      extraFlags.stateFile = token.slice("--state-file=".length).trim();
      continue;
    }

    if (token === "--local-worker-daemon" || token === "--allow-local-daemon") {
      extraFlags.allowLocalDaemon = true;
      continue;
    }
    if (token.startsWith("--local-worker-daemon=")) {
      const val = token.slice("--local-worker-daemon=".length).trim().toLowerCase();
      extraFlags.allowLocalDaemon = val !== "false" && val !== "0";
      continue;
    }

    if (token === "--timeout-ms" || token === "--timeout") {
      const parsed = Number(args[++i]);
      if (Number.isFinite(parsed)) {
        extraFlags.timeoutMs = parsed;
      }
      continue;
    }
    if (token.startsWith("--timeout-ms=")) {
      const parsed = Number(token.slice("--timeout-ms=".length).trim());
      if (Number.isFinite(parsed)) {
        extraFlags.timeoutMs = parsed;
      }
      continue;
    }

    if (token === "--poll-ms" || token === "--poll") {
      const parsed = Number(args[++i]);
      if (Number.isFinite(parsed)) {
        extraFlags.pollMs = parsed;
      }
      continue;
    }
    if (token.startsWith("--poll-ms=")) {
      const parsed = Number(token.slice("--poll-ms=".length).trim());
      if (Number.isFinite(parsed)) {
        extraFlags.pollMs = parsed;
      }
      continue;
    }

    if (!token.startsWith("-") && !command) {
      command = token.trim();
      continue;
    }
  }

  let parsedJson = {};
  if (rawJson === "-") {
    rawJson = (
      typeof options.stdinText === "string" ? options.stdinText : fs.readFileSync(0, "utf8")
    ).trim();
  }
  if (rawJson) {
    try {
      const candidate = JSON.parse(rawJson);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("--json payload must be a JSON object");
      }
      parsedJson = candidate;
    } catch (error) {
      throw new Error(
        `Invalid --json payload: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const resolvedMissionDir =
    missionDir ||
    (typeof parsedJson.missionDir === "string" ? parsedJson.missionDir : "") ||
    process.cwd();

  const payload = {
    ...parsedJson,
    ...extraFlags,
    missionDir: resolvedMissionDir,
  };

  return {
    command,
    missionDir: resolvedMissionDir,
    payload,
    help,
  };
}

/**
 * Execute a CLI command against the Mission Bridge / Kernel (`VAL-BRIDGE-003`).
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {Record<string, unknown>} [context={}]
 * @returns {Promise<{ exitCode: number, result?: any, error?: string }>}
 */
export async function runCli(argv = process.argv.slice(2), context = {}) {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  let runtimeEvidence;

  try {
    const { command, missionDir, payload, help } = parseCliArgs(argv);

    if (help || !command) {
      const usage = {
        usage: "node t3-mission/bridge/cli.mjs <command> --mission-dir <dir> [--json <payload>]",
        commands: MISSION_TOOLS.map((t) => t.name),
      };
      stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
      return { exitCode: help ? 0 : 1, result: usage };
    }

    const normalizedCmd = command.toLowerCase();
    if (normalizedCmd === "mcp" || normalizedCmd === "serve" || normalizedCmd === "stdio") {
      startStdioMcpServer(context);
      return { exitCode: 0, result: { mode: "stdio" } };
    }

    if (
      normalizedCmd === "tools/list" ||
      normalizedCmd === "list-tools" ||
      normalizedCmd === "tools"
    ) {
      const listResult = { tools: MISSION_TOOLS };
      stdout.write(`${JSON.stringify(listResult, null, 2)}\n`);
      return { exitCode: 0, result: listResult };
    }

    if (normalizedCmd === "localworkerdaemon" || normalizedCmd === "local-worker-daemon") {
      const repoPath = String(payload.repoPath || missionDir);
      const runId = String(payload.runId || "run-1");
      const featureId = String(payload.featureId || "f1");
      const stateFile = payload.stateFile ? String(payload.stateFile) : "";

      const daemonState = {
        pid: process.pid,
        missionDir,
        repoPath,
        runId,
        featureId,
        status: "running",
        pauseCount: 0,
        resumeCount: 0,
        lastTrigger: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const writeDaemonState = () => {
        if (stateFile && !writeLocalWorkerMarker(stateFile, daemonState)) cleanupAndExit();
      };
      writeLocalWorkerMarker(stateFile, daemonState, { initial: true });

      process.on("SIGUSR1", () => {
        daemonState.status = "paused";
        daemonState.pauseCount += 1;
        daemonState.updatedAt = new Date().toISOString();
        writeDaemonState();
      });

      process.on("SIGUSR2", () => {
        daemonState.status = "running";
        daemonState.resumeCount += 1;
        daemonState.updatedAt = new Date().toISOString();
        writeDaemonState();
      });

      const cleanupAndExit = () => {
        removeLocalWorkerMarker(stateFile, daemonState);
        process.exit(0);
      };

      process.on("SIGTERM", cleanupAndExit);
      process.on("SIGINT", cleanupAndExit);

      const statePath = getMissionPaths(missionDir).statePath;
      let missingSince = null;
      let seenState = false;
      setInterval(() => {
        if (
          !missionDir ||
          !fs.existsSync(missionDir) ||
          (repoPath && !fs.existsSync(repoPath)) ||
          (stateFile && !isLocalWorkerMarkerOwned(stateFile, daemonState))
        ) {
          cleanupAndExit();
          return;
        }

        const lifetime = inspectLocalWorkerLifetime(statePath, runId, process.pid, {
          missingSince,
          seenState,
        });
        missingSince = lifetime.missingSince;
        seenState = lifetime.seenState;
        if (lifetime.reason) cleanupAndExit();
      }, 50);

      await new Promise(() => {});
      return { exitCode: 0 };
    }

    if (normalizedCmd === "dispatchworkerruntime" || normalizedCmd === "dispatch-worker-runtime") {
      const reason = runtimeDispatchBlockReason(missionDir, payload);
      if (reason) {
        const result = {
          ok: false,
          accepted: false,
          dispatched: false,
          code: "MISSION_NOT_DISPATCHABLE",
          reason,
        };
        stdout.write(`${JSON.stringify(result)}\n`);
        return { exitCode: 0, result };
      }
      const feature =
        payload.feature && typeof payload.feature === "object"
          ? /** @type {Record<string, any>} */ (payload.feature)
          : {};
      const slotConfig =
        payload.slotConfig && typeof payload.slotConfig === "object"
          ? /** @type {Record<string, any>} */ (payload.slotConfig)
          : {};
      const missionId = String(payload.missionId || "mission");
      const featureId = String(feature.id || payload.featureId || "f1");
      const runId = String(payload.runId || feature.runId || "run-1");
      const repoPath = String(payload.repoPath || payload.worktreePath || missionDir);

      if (process.env.T3_ACP_MCP_NODE && String(process.env.T3_ACP_MCP_NODE).trim()) {
        runtimeEvidence = { operation: "dispatch", expected: {} };
        const delegated = await runtimeEffect(
          missionDir,
          "dispatch",
          { runId, clientRequestId: feature.clientRequestId },
          () =>
            runFeature(feature, slotConfig, {
              missionId,
              activeWorker: {
                runId,
                featureId,
                workerNumber: payload.workerNumber || 1,
                attempt: payload.attempt || 1,
                clientRequestId: feature.clientRequestId,
              },
            }),
          payload,
        );
        const verdict = decideDispatchOutcome(delegated, { expectedIdentity: { runId } });
        const result = {
          ...verdict.raw,
          runtimeTransport: "t3-acp-mcp",
        };
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return { exitCode: 0, result };
      }

      const allowLocalDaemon = Boolean(
        process.env.T3_MISSION_LOCAL_WORKER_DAEMON === "1" || payload.allowLocalDaemon === true,
      );

      if (!allowLocalDaemon) {
        const result = {
          ok: true,
          dispatched: false,
          dispatchPending: true,
          code: "NO_T3_TRANSPORT",
          accepted: false,
          preSend: true,
          runtimeTransport: "orchestrator-pending",
          worktreePath: repoPath,
        };
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return { exitCode: 0, result };
      }

      if (!missionDir || (!fs.existsSync(missionDir) && !fs.existsSync(path.dirname(missionDir)))) {
        throw new Error(`Mission directory does not exist: ${missionDir}`);
      }

      const safePart = (val) => String(val).replace(/[^A-Za-z0-9_.-]/g, "_");
      const daemonStateFile = path.join(
        os.tmpdir(),
        `t3-mission-local-worker-${safePart(missionId)}-${safePart(featureId)}-${safePart(runId)}-${process.pid}-${Date.now()}.json`,
      );

      const cliPath = fileURLToPath(import.meta.url);
      const result = await runtimeEffect(
        missionDir,
        "dispatch",
        { runId },
        async () => {
          const child = cp.spawn(
            process.execPath,
            [
              cliPath,
              "LocalWorkerDaemon",
              "--mission-dir",
              missionDir,
              "--repo-path",
              repoPath,
              "--run-id",
              runId,
              "--feature-id",
              featureId,
              "--state-file",
              daemonStateFile,
            ],
            {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
            },
          );
          await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", (error) => reject(preSendFailure(error)));
          });
          child.unref();

          const waitStart = Date.now();
          while (Date.now() - waitStart < 1500) {
            if (fs.existsSync(daemonStateFile) && isPidAlive(child.pid)) {
              break;
            }
            await sleep(10);
          }

          return {
            ok: true,
            dispatched: true,
            taskId: `node:delegated-task:${missionId}:${featureId}:${runId}`,
            childThreadId: `thread:delegated-task:${missionId}:${featureId}:${runId}`,
            childRunId: `run:thread:${missionId}:${featureId}:${runId}:ordinal:1`,
            worktreePath: repoPath,
            workerPid: child.pid,
            daemonStateFile,
            daemonStatus: "running",
            runtimeTransport: "bridge-cli-subprocess",
          };
        },
        payload,
      );
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }

    if (normalizedCmd === "pauseworkerruntime" || normalizedCmd === "pause-worker-runtime") {
      const activeWorker =
        payload.activeWorker && typeof payload.activeWorker === "object"
          ? /** @type {Record<string, any>} */ (payload.activeWorker)
          : {};
      const requiresLocalDaemon =
        !isRemoteWorker(activeWorker) &&
        Boolean(
          typeof activeWorker.workerPid === "number" ||
          typeof activeWorker.daemonStateFile === "string" ||
          activeWorker.runtimeTransport === "bridge-cli-subprocess",
        );

      if (
        process.env.T3_ACP_MCP_NODE &&
        String(process.env.T3_ACP_MCP_NODE).trim() &&
        activeWorker.childThreadId
      ) {
        runtimeEvidence = { operation: "pause", expected: activeWorker };
        const response = await runtimeEffect(missionDir, "pause", activeWorker, (clientRequestId) =>
          callT3McpTool(
            "t3_thread_interrupt",
            {
              threadId: activeWorker.childThreadId,
              clientRequestId,
            },
            process.env,
            { expected: activeWorker, retainRaw: true },
          ),
        );
        const verdict = classifyControlReceipt(response, "pause", activeWorker);
        stdout.write(`${JSON.stringify(verdict.raw) ?? "null"}\n`);
        return { exitCode: 0, result: verdict.raw };
      } else if (requiresLocalDaemon) {
        if (
          typeof activeWorker.workerPid !== "number" ||
          !isPidAlive(activeWorker.workerPid) ||
          (activeWorker.daemonStateFile && !fs.existsSync(activeWorker.daemonStateFile))
        ) {
          const errorMsg = "Active worker daemon process is not alive";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              paused: false,
              canPause: false,
              code: "WORKER_NOT_ALIVE",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }

        try {
          if (!signalOwnedLocalWorker(activeWorker, missionDir, "SIGUSR1"))
            throw Object.assign(
              new Error("Active worker process ownership could not be verified"),
              { code: "WORKER_OWNERSHIP_UNVERIFIED" },
            );
        } catch (error) {
          const ownershipUnknown = error?.code === "WORKER_OWNERSHIP_UNVERIFIED";
          const errorMsg = ownershipUnknown
            ? error.message
            : "Active worker daemon process is not alive";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              paused: false,
              canPause: false,
              code: ownershipUnknown ? "WORKER_OWNERSHIP_UNVERIFIED" : "WORKER_NOT_ALIVE",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }

        if (activeWorker.daemonStateFile) {
          let transitioned = false;
          const waitStart = Date.now();
          while (Date.now() - waitStart < 500) {
            try {
              if (fs.existsSync(activeWorker.daemonStateFile)) {
                const parsed = JSON.parse(fs.readFileSync(activeWorker.daemonStateFile, "utf8"));
                if (parsed && parsed.status === "paused") {
                  transitioned = true;
                  break;
                }
              }
            } catch {
              /* Optional cleanup or data is unavailable; retain the current state. */
            }
            await sleep(10);
          }
          if (!transitioned || !isPidAlive(activeWorker.workerPid)) {
            const errorMsg = "Failed to verify paused state on local worker daemon";
            stderr.write(
              `${JSON.stringify({
                ok: false,
                paused: false,
                canPause: false,
                code: "WORKER_PAUSE_FAILED",
                error: errorMsg,
              })}\n`,
            );
            return { exitCode: 1, error: errorMsg };
          }
        } else if (!isPidAlive(activeWorker.workerPid)) {
          const errorMsg = "Failed to verify paused state on local worker daemon";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              paused: false,
              canPause: false,
              code: "WORKER_PAUSE_FAILED",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }
      } else {
        const bound = Boolean(
          activeWorker.taskId || activeWorker.childThreadId || isRemoteWorker(activeWorker),
        );
        const result = bound
          ? {
              ok: false,
              paused: false,
              canPause: false,
              code: "NO_T3_TRANSPORT",
              error: "No T3 transport is available to pause this remote worker",
            }
          : { ok: true, paused: true, pausedByPid: process.pid };
        stdout.write("" + JSON.stringify(result) + "\n");
        return { exitCode: 0, result };
      }

      const result = {
        ok: true,
        paused: true,
        taskId: activeWorker.taskId || null,
        childThreadId: activeWorker.childThreadId || null,
        workerPid: activeWorker.workerPid || null,
        daemonStatus: "paused",
        pausedByPid: process.pid,
      };
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }

    if (normalizedCmd === "pausemissionruntime" || normalizedCmd === "pause-mission-runtime") {
      const result = {
        ok: true,
        paused: true,
        status: "paused",
        pausedByPid: process.pid,
      };
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }

    if (normalizedCmd === "resumeworkerruntime" || normalizedCmd === "resume-worker-runtime") {
      const activeWorker =
        payload.activeWorker && typeof payload.activeWorker === "object"
          ? /** @type {Record<string, any>} */ (payload.activeWorker)
          : {};
      const trigger = payload.trigger || "[resume the mission]";
      const diagnostic = payload.diagnostic || "";

      if (activeWorker.worktreePath && !fs.existsSync(activeWorker.worktreePath)) {
        const errorMsg = "Active worker worktree path does not exist";
        stderr.write(
          `${JSON.stringify({
            ok: false,
            resumed: false,
            canResume: false,
            error: errorMsg,
          })}\n`,
        );
        return { exitCode: 1, error: errorMsg };
      }

      const requiresLocalDaemon =
        !isRemoteWorker(activeWorker) &&
        Boolean(
          typeof activeWorker.workerPid === "number" ||
          typeof activeWorker.daemonStateFile === "string" ||
          activeWorker.runtimeTransport === "bridge-cli-subprocess",
        );

      if (
        process.env.T3_ACP_MCP_NODE &&
        String(process.env.T3_ACP_MCP_NODE).trim() &&
        activeWorker.childThreadId
      ) {
        runtimeEvidence = { operation: "resume", expected: activeWorker };
        const response = await runtimeEffect(
          missionDir,
          "resume",
          activeWorker,
          (clientRequestId) =>
            callT3McpTool(
              "t3_thread_send",
              {
                threadId: activeWorker.childThreadId,
                clientRequestId,
                message: diagnostic ? `${trigger}\n\n${diagnostic}` : trigger,
              },
              process.env,
              { expected: activeWorker, retainRaw: true },
            ),
        );
        const verdict = classifyControlReceipt(response, "resume", activeWorker);
        stdout.write(`${JSON.stringify(verdict.raw) ?? "null"}\n`);
        return { exitCode: 0, result: verdict.raw };
      } else if (requiresLocalDaemon) {
        if (
          typeof activeWorker.workerPid !== "number" ||
          !isPidAlive(activeWorker.workerPid) ||
          (activeWorker.daemonStateFile && !fs.existsSync(activeWorker.daemonStateFile))
        ) {
          const errorMsg = "Active worker daemon process is not alive";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              resumed: false,
              canResume: false,
              code: "WORKER_NOT_ALIVE",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }

        try {
          if (!signalOwnedLocalWorker(activeWorker, missionDir, "SIGUSR2"))
            throw Object.assign(
              new Error("Active worker process ownership could not be verified"),
              { code: "WORKER_OWNERSHIP_UNVERIFIED" },
            );
        } catch (error) {
          const ownershipUnknown = error?.code === "WORKER_OWNERSHIP_UNVERIFIED";
          const errorMsg = ownershipUnknown
            ? error.message
            : "Active worker daemon process is not alive";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              resumed: false,
              canResume: false,
              code: ownershipUnknown ? "WORKER_OWNERSHIP_UNVERIFIED" : "WORKER_NOT_ALIVE",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }

        if (activeWorker.daemonStateFile) {
          let transitioned = false;
          const waitStart = Date.now();
          while (Date.now() - waitStart < 500) {
            try {
              if (fs.existsSync(activeWorker.daemonStateFile)) {
                const parsed = JSON.parse(fs.readFileSync(activeWorker.daemonStateFile, "utf8"));
                if (parsed && parsed.status === "running") {
                  transitioned = true;
                  break;
                }
              }
            } catch {
              /* Optional cleanup or data is unavailable; retain the current state. */
            }
            await sleep(10);
          }
          if (!transitioned || !isPidAlive(activeWorker.workerPid)) {
            const errorMsg = "Failed to verify running state on local worker daemon";
            stderr.write(
              `${JSON.stringify({
                ok: false,
                resumed: false,
                canResume: false,
                code: "WORKER_RESUME_FAILED",
                error: errorMsg,
              })}\n`,
            );
            return { exitCode: 1, error: errorMsg };
          }
        } else if (!isPidAlive(activeWorker.workerPid)) {
          const errorMsg = "Failed to verify running state on local worker daemon";
          stderr.write(
            `${JSON.stringify({
              ok: false,
              resumed: false,
              canResume: false,
              code: "WORKER_RESUME_FAILED",
              error: errorMsg,
            })}\n`,
          );
          return { exitCode: 1, error: errorMsg };
        }
      } else {
        const result = {
          ok: false,
          resumed: false,
          canResume: false,
          code: "NO_T3_TRANSPORT",
          error: "No T3 transport or local daemon is available",
        };
        stdout.write(`${JSON.stringify(result)}\n`);
        return { exitCode: 0, result };
      }

      const result = {
        ok: true,
        resumed: true,
        taskId: activeWorker.taskId || null,
        childThreadId: activeWorker.childThreadId || null,
        workerPid: activeWorker.workerPid || null,
        daemonStatus: "running",
        trigger,
        wokenByPid: process.pid,
      };
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0, result };
    }

    const canonicalTool = resolveCanonicalToolName(command);
    if (!canonicalTool) {
      const message = `Unknown command "${command}". Available commands: ${MISSION_TOOLS.map((t) => t.name).join(", ")}`;
      stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      return { exitCode: 1, error: message };
    }

    const result = await callMissionTool(canonicalTool, payload, {
      ...context,
      missionDir,
    });

    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (canonicalTool === "WaitForApproval" && result && result.timedOut === true) {
      return { exitCode: 1, result };
    }
    return { exitCode: 0, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? /** @type {any} */ (error).code
        : "CLI_ERROR";
    const reasonCode =
      error && typeof error === "object" && "reasonCode" in error
        ? /** @type {any} */ (error).reasonCode
        : code === "PLAN_ACCEPTANCE_REQUIRED"
          ? "PLAN_NOT_ACCEPTED"
          : code === "HANDOFF_ATTENTION_REQUIRED"
            ? "HANDOFF_GATE_BLOCKED"
            : undefined;
    const controlReceipt =
      runtimeEvidence &&
      (runtimeEvidence.operation === "dispatch"
        ? decideDispatchOutcome(error?.runtimeResult, {
            expectedIdentity: runtimeEvidence.expected,
          }).controlReceipt
        : classifyControlReceipt(
            error.runtimeResult ?? error,
            runtimeEvidence.operation,
            runtimeEvidence.expected,
          ));
    const errorPayload = {
      ok: false,
      ...(controlReceipt ? { controlReceipt } : {}),
      ...(Object.hasOwn(error, "runtimeResult") ? { runtimeResult: error.runtimeResult } : {}),
      code,
      ...(reasonCode ? { reasonCode } : {}),
      error: message,
    };
    stderr.write(`${JSON.stringify(errorPayload)}\n`);
    return {
      exitCode: 1,
      error: message,
      code,
      ...(controlReceipt ? { controlReceipt } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
}

function resolveRealOrAbs(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isExecutedAsMain(metaUrl, argv1 = process.argv[1]) {
  return Boolean(argv1 && resolveRealOrAbs(argv1) === resolveRealOrAbs(fileURLToPath(metaUrl)));
}

const isMainModule = isExecutedAsMain(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2)).then(({ exitCode }) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}

export default {
  parseCliArgs,
  runCli,
  isExecutedAsMain,
};
