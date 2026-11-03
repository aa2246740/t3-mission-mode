import fs from "node:fs";
import { spawnSync } from "node:child_process";
const [label, command, ...args] = process.argv.slice(2);
if (!label || !command)
  throw new Error("Usage: node scripts/timed-command.mjs <label> <command> [arguments...]");
const start = performance.now();
const result = spawnSync(command, args, { stdio: "inherit", timeout: 600000 });
const record = {
  label,
  command,
  args,
  durationMs: performance.now() - start,
  exitCode: result.status,
  signal: result.signal,
};
fs.mkdirSync("reports", { recursive: true });
fs.appendFileSync("reports/build-timings.jsonl", JSON.stringify(record) + "\n");
console.log(JSON.stringify(record));
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
