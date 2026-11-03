import { commandTransaction } from './mission-transaction.mjs';
import { MissionKernelError } from "./schema.mjs";
import { loadState, saveState, appendProgressLog } from "./store.mjs";
import { approveMissionPlan } from "./tools.mjs";

/** HUD commands change user gates only. The owner remains the sole T3 executor. */
function applyAutopilotCommandImpl(missionDir, command) {
  const state = loadState(missionDir);
  if (state.autopilot !== true) throw new MissionKernelError("AUTOPILOT_REQUIRED", "Logical Autopilot commands require an Autopilot plan");
  if (command === "approve") return approveMissionPlan(missionDir).state;
  if (!["pause", "resume"].includes(command)) throw new MissionKernelError("INVALID_AUTOPILOT_COMMAND", "Expected approve, pause, or resume");
  if (["completed", "awaiting_merge"].includes(state.status)) return state;
  if (command === "resume" && state.planAccepted !== true) throw new MissionKernelError("PLAN_ACCEPTANCE_REQUIRED", "Resume cannot approve a rejected plan");
  const status = command === "pause" ? "paused" : "running";
  if (command === "resume" && state.status !== "paused" && state.activeWorker?.status !== "paused") return state;
  if (state.status === status && (!state.activeWorker || state.activeWorker.status === status)) return state;
  const now = new Date().toISOString();
  state.status = status;
  if (command === "pause") { state.pausedAt = now; state.pauseEpoch = (state.pauseEpoch ?? 0) + 1; }
  if (state.activeWorker) {
    const update = row => ({ ...row, status, ...(command === "pause" ? { pausedAt: now } : {}) });
    state.activeWorker = update(state.activeWorker);
    state.sessions = (state.sessions || []).map(row => row.runId === state.activeWorker.runId ? update(row) : row);
  }
  state.revision += 1;
  saveState(missionDir, state);
  appendProgressLog(missionDir, { type: command === "pause" ? "mission_paused" : "mission_resumed", message: `Autopilot ${command}: controller will apply ${state.pauseMode ?? "interrupt"} policy`, featureId: state.activeWorker?.featureId ?? null });
  return state;
}
export function applyAutopilotCommand(dir, command, options = {}) { return commandTransaction(dir, 'applyAutopilotCommand', { command, ...options }, () => applyAutopilotCommandImpl(dir, command)); }
