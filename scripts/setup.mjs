import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.argv[2],
  process.env.T3_NODE_HEADERS,
  path.resolve(path.dirname(process.execPath), "../include/node"),
  "/opt/homebrew/include/node",
  "/usr/local/include/node",
  "/usr/include/node",
].filter(Boolean);
const headers = candidates.find((dir) => fs.existsSync(path.join(dir, "node_api.h")));
if (!headers)
  throw new Error(
    "No local node_api.h found. Run npm run setup -- /absolute/path/to/node/headers. Setup downloads no headers.",
  );
const build = spawnSync(process.execPath, ["t3-mission/native/build.mjs", headers], {
  cwd: root,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const hooks = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: "inherit",
});
if (hooks.error) throw hooks.error;
if (hooks.status !== 0) process.exit(hooks.status ?? 1);
console.log(
  "Native lock built; repository-local quality hook enabled. No agent installation or provider dispatch performed.",
);
