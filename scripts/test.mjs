import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const concurrency = Number(process.env.T3_TEST_CONCURRENCY ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error("T3_TEST_CONCURRENCY must be 1 through 4.");
fs.mkdirSync("reports", { recursive: true });
const files = fs
  .readdirSync("t3-mission/test")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `t3-mission/test/${file}`);
const args = [
  "--import",
  fileURLToPath(new URL("./test-environment.mjs", import.meta.url)),
  "--test",
  "--test-timeout=5400000",
  `--test-concurrency=${concurrency}`,
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=junit",
  "--test-reporter-destination=reports/tests.xml",
  ...process.argv.slice(2),
  ...files,
];
const start = performance.now();
const suppliedEvidence = process.env.R9_EVIDENCE_DIR;
const evidenceRoot =
  suppliedEvidence || fs.mkdtempSync(path.join(os.tmpdir(), "t3-mission-test-run-"));
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  detached: true,
  env: { ...process.env, T3_TEST_EVIDENCE_ROOT: evidenceRoot },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* The test process already exited. */
    }
  });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  const result = {
    command: "npm test",
    node: process.version,
    files: files.length,
    concurrency,
    durationMs: performance.now() - start,
    exitCode: code,
    signal,
    evidenceRoot: code === 0 && !suppliedEvidence ? null : evidenceRoot,
  };
  fs.writeFileSync("reports/test-run.json", JSON.stringify(result, null, 2) + "\n");
  if (code === 0 && !suppliedEvidence) fs.rmSync(evidenceRoot, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exitCode = code ?? 1;
});
