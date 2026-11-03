import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Node loads this module separately in each test file's isolated process.
// Child fixture actors inherit that file's directory instead of allocating one.
if (process.argv[1]?.endsWith(".test.mjs")) {
  const supplied = process.env.R9_EVIDENCE_DIR;
  const parent = process.env.T3_TEST_EVIDENCE_ROOT || supplied || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, path.basename(process.argv[1], ".mjs") + "-"));
  process.env.R9_EVIDENCE_DIR = directory;
  process.env.TMPDIR = directory;
  process.on("exit", (code) => {
    if (code === 0 && !supplied) fs.rmSync(directory, { recursive: true, force: true });
    else if (code !== 0) process.stderr.write(`Test evidence retained at ${directory}\n`);
  });
}
