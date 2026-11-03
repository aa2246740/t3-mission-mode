import * as k from "../../kernel/index.mjs";
import { setTransactionTestHook } from "../../kernel/mission-transaction.mjs";
const [dir, raw, mode] = process.argv.slice(2);
let archived = false;
setTransactionTestHook((e) => {
  if (
    e.role.startsWith("projection:autopilot/observations/") &&
    e.operation === "fsync-dir" &&
    e.boundary === "after"
  )
    archived = true;
  if (
    archived &&
    e.role === "checkpoint" &&
    e.operation === "fsync-dir" &&
    e.boundary === "after"
  ) {
    if (mode === "SIGKILL") process.kill(process.pid, "SIGKILL");
    else process.exit(77);
  }
});
await k.missionTick(dir, { observations: JSON.parse(raw), now: 1793000001000 });
throw new Error("Archive crash boundary was not reached");
