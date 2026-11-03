// Migrated from validator-r8/r8-preflight-minimal.test.mjs. Assertions retain the reviewer's semantics.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as k from "../kernel/index.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
const O = os.tmpdir(),
  E = process.env.R9_EVIDENCE_DIR || O,
  rows = [];
const receipt = {
  accepted: true,
  taskId: "minimal-accepted-task",
  childThreadId: "minimal-accepted-thread",
  runtimeTransport: "t3-delegate-task",
};
const names = ["state.json", "features.json", "model-settings.json", "progress_log.jsonl"];
const bytes = (d) =>
  Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(d, ".mission", n), "utf8")]));
const journal = (d) =>
  fs
    .readdirSync(path.join(d, ".mission"))
    .filter((n) => /^dispatch-.*\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(d, ".mission", n), "utf8")));
function record(id, fn) {
  test(id, async () => {
    const r = { id };
    try {
      await fn(r);
      r.pass = true;
    } catch (e) {
      r.pass = false;
      r.error = e.stack;
      throw e;
    } finally {
      rows.push(r);
    }
  });
}
after(() =>
  fs.writeFileSync(path.join(E, "r8-preflight-minimal.json"), JSON.stringify(rows, null, 2) + "\n"),
);
function fixture(r) {
  const d = fs.mkdtempSync(path.join(O, "preflight-minimal-"));
  r.dir = d;
  cp.execFileSync("git", ["init", "-q", d]);
  fs.writeFileSync(path.join(d, ".gitignore"), ".mission/\n");
  cp.execFileSync("git", ["-C", d, "add", ".gitignore"]);
  cp.execFileSync("git", [
    "-C",
    d,
    "-c",
    "user.name=R8 Validator",
    "-c",
    "user.email=r8@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  ]);
  k.proposeMission(d, {
    repoPath: d,
    title: "Minimal current-run preflight",
    features: [{ id: "f1", milestoneId: "m1" }],
    milestones: [{ id: "m1" }],
    modelSettings: {
      skipScrutiny: true,
      skipUserTesting: true,
      worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "max" },
    },
  });
  k.approveMissionPlan(d);
  return d;
}
const start = (entry, d, hook) =>
  entry === "kernel"
    ? k.startMissionRun(d, {}, { runFeature: hook })
    : callMissionTool(
        "StartMissionRun",
        { missionDir: d },
        { kernel: k, dispatchAdapter: { runFeature: hook } },
      );
for (const entry of ["kernel", "MCP"]) {
  record("Completed replacement must not enter executor " + entry, async (r) => {
    const d = fixture(r);
    await k.startMissionRun(d);
    k.proposeMission(d, {
      repoPath: d,
      title: "Completed replacement",
      features: [{ id: "f1", milestoneId: "m1", status: "completed" }],
      modelSettings: k.loadModelSettings(d),
    });
    k.approveMissionPlan(d);
    r.before = bytes(d);
    let calls = 0;
    r.result = await start(entry, d, async () => {
      calls++;
      return receipt;
    });
    r.calls = calls;
    r.after = bytes(d);
    r.journal = journal(d);
    assert.equal(calls, 0);
    assert.deepEqual(r.after, r.before);
  });
  record("Valid running replacement may enter executor " + entry, async (r) => {
    const d = fixture(r);
    await k.startMissionRun(d);
    k.proposeMission(d, {
      repoPath: d,
      title: "Valid replacement",
      features: k.loadFeaturesDoc(d).features,
      modelSettings: k.loadModelSettings(d),
    });
    k.approveMissionPlan(d);
    let calls = 0;
    r.result = await start(entry, d, async () => {
      calls++;
      return receipt;
    });
    r.calls = calls;
    assert.equal(calls, 1);
    assert.equal(k.loadState(d).activeWorker.taskId, receipt.taskId);
  });
  record("Approved all-completed plan without worker needs no executor " + entry, async (r) => {
    const d = fixture(r);
    k.proposeMission(d, {
      repoPath: d,
      title: "All done",
      features: [{ id: "f1", milestoneId: "m1", status: "completed" }],
      modelSettings: k.loadModelSettings(d),
    });
    k.approveMissionPlan(d);
    let calls = 0;
    r.result = await start(entry, d, async () => {
      calls++;
      return receipt;
    });
    r.calls = calls;
    assert.equal(calls, 0);
    assert.equal(k.loadState(d).activeWorker, null);
  });
  record("Unapproved plan prevents executor " + entry, async (r) => {
    const d = fixture(r);
    await k.startMissionRun(d);
    k.rejectMissionPlan(d, "Review required");
    let calls = 0;
    await assert.rejects(
      start(entry, d, async () => {
        calls++;
        return receipt;
      }),
      { code: "PLAN_ACCEPTANCE_REQUIRED" },
    );
    r.calls = calls;
    assert.equal(calls, 0);
  });
  record("Awaiting input after retryable callback prevents reentry " + entry, async (r) => {
    const d = fixture(r);
    let calls = 0;
    const hook = async () => {
      calls++;
      if (calls === 1) {
        const s = k.loadState(d);
        s.status = "awaiting_input";
        s.revision++;
        k.saveState(d, s);
        return { dispatchPending: true };
      }
      return receipt;
    };
    await start(entry, d, hook);
    r.before = bytes(d);
    await start(entry, d, hook);
    r.calls = calls;
    r.after = bytes(d);
    r.journal = journal(d);
    assert.equal(calls, 1);
    assert.deepEqual(r.after, r.before);
  });
}
