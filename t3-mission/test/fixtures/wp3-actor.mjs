import fs from "node:fs";

import * as k from "../../kernel/index.mjs";
import { callMissionTool } from "../../bridge/mcp-server.mjs";
import {
  readController,
  saveController,
  archiveObservation,
  readObservations,
} from "../../kernel/autopilot-store.mjs";
import { applyAutopilotCommand } from "../../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../../kernel/dispatch-journal.mjs";
import {
  setTransactionTestHook,
  hasActiveMissionTransaction,
  missionTransaction,
} from "../../kernel/mission-transaction.mjs";
const [operation, dir, raw = "{}"] = process.argv.slice(2);
const input = JSON.parse(raw);
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const accepted = {
  accepted: true,
  taskId: "wp3-task",
  childThreadId: "wp3-thread",
  childRunId: "wp3-child",
  runtimeTransport: "t3-delegate-task",
};
let result;
const events = [];
if (input.fault || input.trace)
  setTransactionTestHook((event) => {
    if (!["rename", "fsync-file", "fsync-dir", "unlink"].includes(event.operation)) return;
    const item = { ordinal: events.length, ...event };
    events.push(item);
    if (input.traceFile) fs.writeFileSync(input.traceFile, JSON.stringify(events, null, 2) + "\n");
    if (input.fault && item.ordinal === input.fault.ordinal) {
      fs.writeSync(2, JSON.stringify({ injected: input.fault.kind, event: item }) + "\n");
      if (input.fault.kind === "SIGKILL") process.kill(process.pid, "SIGKILL");
      throw Object.assign(
        new Error(
          `Injected ${input.fault.kind} at ${event.role}/${event.operation}/${event.boundary}`,
        ),
        { code: input.fault.kind },
      );
    }
    if (
      input.barrier &&
      event.role === input.barrier.role &&
      event.operation === input.barrier.operation &&
      event.boundary === input.barrier.boundary
    ) {
      fs.writeFileSync(input.barrier.ready, String(process.pid));
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(input.barrier.release)) Atomics.wait(cell, 0, 0, 10);
    }
  });
try {
  if (operation === "init") {
    result = k.proposeMission(dir, {
      missionId: "wp3-owned-mission",
      ownerThreadId: "wp3-owner",
      repoPath: dir,
      autopilot: true,
      integration: { branch: "mission/wp3", auto: true },
      milestones: [{ id: "m1" }],
      assertions: [{ id: "VAL-WP3", milestoneId: "m1" }],
      features: [{ id: "f1", milestoneId: "m1" }],
      modelSettings: {
        skipScrutiny: true,
        skipUserTesting: true,
        worker: {
          providerInstanceId: "codex",
          model: "gpt-6.1-sol",
          options: { reasoningEffort: "max" },
        },
      },
    });
    k.approveMissionPlan(dir);
    missionTransaction(dir, () => {
      const ledger = readController(dir, result.state.missionId);
      ledger.timer = {
        phase: "confirmed",
        requestId: `mission-timer:${result.state.missionId}`,
        scheduledTaskId: "wp3-timer",
      };
      saveController(dir, ledger);
    });
  } else if (operation === "read") {
    result = k.withMissionTransaction(dir, () => ({
      ...k.readMissionSnapshot(dir),
      records: inspectDispatchRecords(dir),
      observations: readObservations(dir),
      ledger: readController(dir, k.loadState(dir).missionId),
    }));
  } else if (operation === "update") {
    result = await callMissionTool(
      "UpdateMissionFeatures",
      { missionDir: dir, ...input.payload },
      { kernel: k },
    );
  } else if (operation === "bind") {
    result = await callMissionTool(
      "BindFeatureDispatch",
      { missionDir: dir, ...input.payload },
      { kernel: k },
    );
  } else if (operation === "end") {
    result = await callMissionTool(
      "EndFeatureRun",
      { missionDir: dir, ...input.payload },
      { kernel: k },
    );
  } else if (operation === "start") {
    result = await k.startMissionRun(dir);
  } else if (operation === "gate") {
    result =
      input.kind === "reject"
        ? k.rejectMissionPlan(dir, "WP3 rejection")
        : applyAutopilotCommand(dir, "pause", { commandId: input.commandId });
  } else if (operation === "tick") {
    result = await callMissionTool(
      "MissionTick",
      { missionDir: dir, ...input.payload },
      { kernel: k },
    );
  } else if (operation === "append") {
    result = k.appendProgressLog(dir, { type: "wp3-event", message: input.id });
  } else if (operation === "archive") {
    result = archiveObservation(dir, { type: "wp3-fact", id: input.id, response: {} });
  } else if (operation === "budget") {
    result = missionTransaction(dir, () => {
      const ledger = readController(dir, k.loadState(dir).missionId);
      ledger.features = { f1: { providerErrors: 2, nextRetryAt: "2020-01-01T00:00:00.000Z" } };
      ledger.consecutiveProviderErrors = 2;
      saveController(dir, ledger);
      return ledger;
    });
  } else if (operation === "ledger") {
    result = missionTransaction(dir, () => {
      const ledger = readController(dir, k.loadState(dir).missionId);
      ledger.runs[input.id] = { consumed: true };
      saveController(dir, ledger);
      return ledger;
    });
  } else if (operation === "hold") {
    result = k.withMissionTransaction(dir, () => {
      fs.writeFileSync(input.ready, String(process.pid));
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(input.release)) Atomics.wait(cell, 0, 0, 10);
      return { held: true };
    });
  } else if (operation === "transport") {
    result = await k.startMissionRun(
      dir,
      {},
      {
        runFeature: async () => {
          if (hasActiveMissionTransaction())
            throw new Error("External transport started under Mission lock");
          fs.writeFileSync(input.ready, String(process.pid));
          while (!fs.existsSync(input.release)) await sleep(10);
          return accepted;
        },
        pauseWorker: async (worker) => {
          if (hasActiveMissionTransaction())
            throw new Error("Pause transport started under Mission lock");
          fs.appendFileSync(input.pauseCalls, JSON.stringify(worker) + "\n");
          return { paused: true };
        },
      },
    );
  } else throw new Error("Unknown owned fixture operation " + operation);
  console.log(JSON.stringify({ ok: true, result, events }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: { code: error.code, message: error.message, stack: error.stack },
      events,
    }),
  );
  process.exitCode = 1;
}
