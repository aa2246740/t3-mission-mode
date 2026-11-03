import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import * as k from "../../kernel/index.mjs";
import { applyAutopilotCommand } from "../../kernel/autopilot-commands.mjs";
import { inspectDispatchRecords } from "../../kernel/dispatch-journal.mjs";
import { readController } from "../../kernel/autopilot-store.mjs";
import { init } from "./a10-fixture.mjs";
import { fresh } from "./a13-fixture.mjs";

const [op, dir, raw = "{}"] = process.argv.slice(2),
  input = JSON.parse(raw);
const receipt = {
  accepted: true,
  taskId: "a15-task",
  childThreadId: "a15-child",
  childRunId: "a15-turn",
};
function recordPause(d, threadId) {
  const file = path.join(d, "compensation-callback.json");
  const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).calls + 1 : 1;
  fs.writeFileSync(file, JSON.stringify({ calls, threadId }));
}
let value;
if (op === "seed") {
  const d = init("a15-" + input.source + "-" + input.mode);
  const state = k.loadState(d);
  state.pauseMode = input.mode;
  k.saveState(d, state);
  value = { dir: d };
} else if (op === "runner") {
  const d = dir;
  await k.startMissionRun(
    d,
    {},
    {
      runFeature: async () => {
        fresh(d, "pause", { command: "pause" });
        return receipt;
      },
      pauseWorker: async (worker) => {
        assert.equal(worker.childThreadId, "a15-child");
        recordPause(d, worker.childThreadId);
        if (input.resumeDuringCallback) fresh(d, "pause", { command: "resume" });
        if (input.outcome === "throws") throw new Error("Literal compensation transport failure");
        return input.outcome === "confirmed"
          ? { paused: true, threadId: "a15-child" }
          : input.outcome === "rejected"
            ? { accepted: false, paused: false, code: "CONTROL_REFUSED" }
            : input.outcome === "unknown"
              ? {}
              : { pending: true };
      },
    },
  );
  value = { dir: d };
} else if (op === "tick")
  value = (await k.missionTick(dir, { observations: input.observations ?? [] })).action;
else if (op === "command") value = applyAutopilotCommand(dir, input.command);
else if (op === "snapshot") {
  const state = k.loadState(dir);
  value = {
    state,
    ledger: readController(dir, state.missionId),
    records: inspectDispatchRecords(dir),
  };
} else if (op === "callback") {
  recordPause(dir, "a15-child");
  value =
    input.outcome === "confirmed"
      ? { paused: true, threadId: "a15-child" }
      : input.outcome === "rejected"
        ? { accepted: false, paused: false, code: "CONTROL_REFUSED" }
        : input.outcome === "unknown"
          ? {}
          : { pending: true };
} else throw new Error("Unknown A15 operation " + op);
console.log(JSON.stringify(value));
