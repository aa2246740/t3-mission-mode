import fs from "node:fs";
import { spawnSync } from "node:child_process";
const results = [];
for (let run = 1; run <= 2; run++) {
  const start = performance.now();
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "t3-mission/test/ops.test.mjs",
      "t3-mission/test/security-http.test.mjs",
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  const result = {
    run,
    durationMs: performance.now() - start,
    exitCode: child.status,
    signal: child.signal,
    output: child.stdout + child.stderr,
    error: child.error?.message,
  };
  results.push(result);
  if (child.error || child.status !== 0) process.exitCode = 1;
}
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync(
  "reports/test-stability.json",
  JSON.stringify(
    { runs: results, inconsistentOutcomes: new Set(results.map((row) => row.exitCode)).size > 1 },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(results.map(({ run, exitCode, durationMs }) => ({ run, exitCode, durationMs }))),
);
