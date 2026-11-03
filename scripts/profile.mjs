import fs from "node:fs";
import { spawnSync } from "node:child_process";
fs.mkdirSync("reports/profiles", { recursive: true });
const result = spawnSync(
  process.execPath,
  ["--cpu-prof", "--cpu-prof-dir=reports/profiles", "scripts/qa.mjs", "--profile"],
  { stdio: "inherit", timeout: 60000 },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
