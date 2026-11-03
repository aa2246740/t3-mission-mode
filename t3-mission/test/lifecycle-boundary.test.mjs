import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import os from "node:os";
import * as k from "../kernel/index.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { createMissionHudServer } from "../hud/server.mjs";
import { assertRejectedPause } from "./pause-contract-fixture.mjs";
const O = os.tmpdir();
function record(id, fn) {
  test(id, { timeout: 10000 }, async (t) => {
    const row = { id, test: t };
    await fn(row, t);
  });
}
function fixture(row, approved = true) {
  const dir = fs.mkdtempSync(path.join(O, "r7-case-"));
  row.dir = dir;
  row.test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=R7 Reviewer",
    "-c",
    "user.email=r7@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
    "--no-gpg-sign",
  ]);
  k.proposeMission(dir, {
    repoPath: dir,
    title: "Independent R7 boundary",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", title: "F1" }],
    modelSettings: {
      worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", effort: 5 },
      skipScrutiny: true,
      skipUserTesting: true,
    },
  });
  if (approved) k.approveMissionPlan(dir);
  return dir;
}
async function setup(row, mode) {
  const dir = fixture(row);
  if (mode === "initial") return dir;
  await k.startMissionRun(dir);
  const s = k.loadState(dir);
  s.status = "paused";
  s.lastStartedAt = null;
  s.pausedAt = "2026-10-22T20:00:00.000Z";
  for (const x of [s.activeWorker, s.sessions.at(-1)]) {
    x.status = "paused";
    if (mode === "legacy") {
      delete x.dispatchPending;
      delete x.runtimeTransport;
      delete x.delegatedBy;
    }
  }
  k.saveState(dir, s);
  return dir;
}
const files = ["state.json", "features.json", "model-settings.json", "progress_log.jsonl"];
const bytes = (dir) =>
  Object.fromEntries(files.map((n) => [n, fs.readFileSync(path.join(dir, ".mission", n), "utf8")]));
const journal = (dir) =>
  fs
    .readdirSync(path.join(dir, ".mission"))
    .filter((n) => /^dispatch-.*\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, ".mission", n), "utf8")));
const projections = (dir) => {
  const s = k.loadState(dir);
  return [s.activeWorker, s.sessions.at(-1), k.loadFeaturesDoc(dir).features[0]];
};
const valid = {
  accepted: true,
  resumed: true,
  taskId: "valid-r7-task",
  childThreadId: "valid-r7-thread",
  runtimeTransport: "t3-delegate-task",
};
const shapes = {
  root: (x) => x,
  response: (x) => ({ response: x }),
  delegation: (x) => ({ delegation: x }),
  "response.delegation": (x) => ({ response: { delegation: x } }),
  "delegation.response": (x) => ({ delegation: { response: x } }),
};
async function start(entry, dir, hook, mode) {
  if (entry === "kernel")
    return k.startMissionRun(
      dir,
      {},
      mode === "legacy" ? { resumeWorker: hook } : { runFeature: hook },
    );
  return callMissionTool(
    "StartMissionRun",
    { missionDir: dir },
    {
      kernel: k,
      dispatchAdapter: mode === "legacy" ? { resumeWorker: hook } : { runFeature: hook },
    },
  );
}
for (const mode of ["initial", "legacy"])
  for (const entry of ["kernel", "MCP", "HTTP"])
    for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath"])
      record("Identity conflict " + mode + " " + entry + " " + key, async (row) => {
        const dir = await setup(row, mode);
        let calls = 0;
        const inner = { ...valid, [key]: "inner-" + key },
          result = { ...valid, [key]: "outer-" + key, response: inner };
        row.raw = result;
        const hook = async () => {
          calls++;
          return result;
        };
        let hud;
        try {
          if (entry === "HTTP") {
            hud = await createMissionHudServer({
              missionDir: dir,
              port: 0,
              runtimeAdapter: mode === "legacy" ? { resumeWorker: hook } : { runFeature: hook },
            });
            const r = await fetch(
              hud.url + "/api/mission/" + (mode === "legacy" ? "resume" : "approve"),
              { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
            );
            row.httpStatus = r.status;
            row.result = await r.json();
          } else
            try {
              row.result = await start(entry, dir, hook, mode);
            } catch (e) {
              row.failure = { code: e.code, message: e.message };
            }
          row.calls = calls;
          row.journal = journal(dir);
          row.after = k.loadState(dir);
          row.projections = projections(dir);
          assert.equal(row.journal[0]?.phase, "inflight");
          for (const p of row.projections)
            assert.equal(Boolean(p?.taskId || p?.childThreadId || p?.childRunId), false);
          assert.deepEqual(row.journal[0].observedReceipt, result);
          assert.equal(calls, 1);
        } finally {
          await hud?.close();
        }
      });
for (const entry of ["kernel", "MCP"])
  for (const mode of ["initial", "pending", "legacy"])
    for (const owner of ["reject", "reproposal"])
      record("Owner gate " + entry + " " + mode + " " + owner, async (row) => {
        const dir = await setup(row, mode);
        const hook = async () => {
          if (owner === "reject") k.rejectMissionPlan(dir, "Keep the user approval gate closed");
          else {
            k.proposeMission(dir, {
              repoPath: dir,
              title: "Owner revised plan",
              milestones: [{ id: "m1" }],
              features: k.loadFeaturesDoc(dir).features,
              modelSettings: k.loadModelSettings(dir),
            });
          }
          row.ownerState = k.loadState(dir);
          row.ownerBytes = bytes(dir);
          return valid;
        };
        try {
          row.result = await start(entry, dir, hook, mode);
        } catch (e) {
          row.failure = { code: e.code, message: e.message };
        }
        row.after = k.loadState(dir);
        row.journal = journal(dir);
        row.afterBytes = bytes(dir);
        assert.equal(row.after.planAccepted, false);
        assert.equal(row.after.status, owner === "reject" ? "planning" : "awaiting_input");
        assert.equal(row.after.activeWorker.status, row.ownerState.activeWorker.status);
        assert.deepEqual(row.afterBytes, row.ownerBytes);
      });
for (const entry of ["kernel", "MCP"])
  record("Remote legacy metadata cleanup " + entry, async (row) => {
    const dir = fixture(row);
    await k.startMissionRun(dir, {}, { runFeature: async () => ({ ...valid, resumed: false }) });
    const state = k.loadState(dir),
      doc = k.loadFeaturesDoc(dir);
    state.status = "paused";
    state.lastStartedAt = null;
    state.pausedAt = "2026-10-22T20:00:00.000Z";
    for (const p of [state.activeWorker, state.sessions[0], doc.features[0]])
      Object.assign(p, {
        status: p === doc.features[0] ? "running" : "paused",
        workerPid: process.pid,
        daemonStateFile: path.join(dir, "unrelated-marker"),
        daemonStatus: "paused",
      });
    k.saveState(dir, state);
    k.saveFeaturesDoc(dir, doc);
    row.result = await start(
      entry,
      dir,
      async () => ({
        resumed: true,
        accepted: true,
        taskId: valid.taskId,
        childThreadId: valid.childThreadId,
        runtimeTransport: "t3-delegate-task",
      }),
      "legacy",
    );
    row.projections = projections(dir);
    for (const p of row.projections)
      for (const key of ["workerPid", "daemonStateFile", "daemonStatus"])
        assert.equal(Object.hasOwn(p, key), false);
  });
for (const [shape, wrap] of Object.entries(shapes))
  for (const negative of ["accepted", "interrupted", "ok", "paused"])
    record("HTTP custom Pause rejection " + shape + " " + negative, async (row) => {
      const dir = fixture(row);
      await k.startMissionRun(dir, {}, { runFeature: async () => ({ ...valid, resumed: false }) });
      const before = bytes(dir);
      const raw = wrap({ [negative]: false, code: "PROVIDER_BUSY" });
      row.raw = raw;
      let calls = 0;
      const hud = await createMissionHudServer({
        missionDir: dir,
        port: 0,
        runtimeAdapter: {
          pauseWorker: async () => {
            calls++;
            return raw;
          },
        },
      });
      try {
        const r = await fetch(hud.url + "/api/mission/pause", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        row.httpStatus = r.status;
        row.body = await r.json();
        row.after = k.loadState(dir);
        row.beforeBytes = before;
        row.afterBytes = bytes(dir);
        assert.equal(r.status, 409);
        assert.equal(row.body.code, "PROVIDER_BUSY");
        assertRejectedPause(dir, before);
        const retry = await fetch(hud.url + "/api/mission/pause", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(retry.status, 409);
        assert.equal(calls, 1);
        assert.deepEqual(bytes(dir), row.afterBytes);
      } finally {
        await hud.close();
      }
    });

for (const [shape, wrap] of Object.entries(shapes))
  for (const negative of ["accepted", "interrupted", "ok", "paused"])
    record("HTTP custom Pause Mission rejection " + shape + " " + negative, async (row) => {
      const dir = fixture(row);
      await k.startMissionRun(dir, {}, { runFeature: async () => ({ ...valid, resumed: false }) });
      const before = bytes(dir),
        raw = wrap({ [negative]: false, code: "PROVIDER_BUSY" });
      let calls = 0;
      const hud = await createMissionHudServer({
        missionDir: dir,
        port: 0,
        runtimeAdapter: {
          pauseWorker: async () => ({ paused: true }),
          pauseMission: async () => {
            calls++;
            return raw;
          },
        },
      });
      try {
        const response = await fetch(hud.url + "/api/mission/pause", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body = await response.json();
        assert.equal(calls, 1);
        assert.equal(response.status, 409);
        assert.equal(body.code, "PROVIDER_BUSY");
        assertRejectedPause(dir, before);
        const saved = bytes(dir);
        const retry = await fetch(hud.url + "/api/mission/pause", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(retry.status, 409);
        assert.equal(calls, 1);
        assert.deepEqual(bytes(dir), saved);
      } finally {
        await hud.close();
      }
    });

for (const entry of ["kernel", "MCP"])
  for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath"])
    record("Attached resume conflict " + entry + " " + key, async (row) => {
      const dir = fixture(row);
      await k.startMissionRun(dir, {}, { runFeature: async () => ({ ...valid, resumed: false }) });
      const state = k.loadState(dir);
      state.status = "paused";
      state.activeWorker.status = "paused";
      state.sessions.at(-1).status = "paused";
      k.saveState(dir, state);
      const before = bytes(dir);
      let calls = 0;
      const result = {
        ...valid,
        [key]: "outer-" + key,
        response: { ...valid, [key]: "inner-" + key },
      };
      await assert.rejects(
        start(
          entry,
          dir,
          async () => {
            calls++;
            return result;
          },
          "legacy",
        ),
        { code: "DISPATCH_RECEIPT_CONFLICT" },
      );
      assert.equal(calls, 1);
      assert.deepEqual(bytes(dir), before);
    });

for (const entry of ["kernel", "MCP"])
  for (const mode of ["initial", "pending", "legacy"])
    for (const gate of ["handoff", "awaiting_input", "feature", "session"])
      record("Owner current gate " + entry + " " + mode + " " + gate, async (row) => {
        const dir = await setup(row, mode);
        let ownerBytes;
        const hook = async () => {
          const state = k.loadState(dir);
          if (gate === "handoff") state.lastHandoffNeedsAttention = true;
          if (gate === "awaiting_input") state.status = "awaiting_input";
          if (gate === "session") state.sessions.at(-1).featureId = "foreign-feature";
          state.revision += 1;
          k.saveState(dir, state);
          if (gate === "feature") {
            const doc = k.loadFeaturesDoc(dir);
            doc.features[0].runId = "foreign-run";
            k.saveFeaturesDoc(dir, doc);
          }
          ownerBytes = bytes(dir);
          return valid;
        };
        await start(entry, dir, hook, mode);
        assert.deepEqual(bytes(dir), ownerBytes);
        assert.equal(journal(dir)[0].phase, "accepted");
      });

for (const entry of ["kernel", "MCP"])
  for (const mode of ["initial", "pending", "legacy"])
    for (const owner of ["reject", "reproposal"])
      record(
        "Explicit reapproval recovers accepted receipt " + entry + " " + mode + " " + owner,
        async (row) => {
          const dir = await setup(row, mode);
          let calls = 0;
          const hook = async () => {
            calls++;
            if (owner === "reject") k.rejectMissionPlan(dir, "Review again");
            else
              k.proposeMission(dir, {
                repoPath: dir,
                title: "Revised",
                features: k.loadFeaturesDoc(dir).features,
                modelSettings: k.loadModelSettings(dir),
              });
            return valid;
          };
          await start(entry, dir, hook, mode);
          row.afterGate = k.loadState(dir);
          row.journal = journal(dir);
          k.approveMissionPlan(dir);
          row.afterApproval = k.loadState(dir);
          await start(entry, dir, hook, mode);
          row.afterRecovery = k.loadState(dir);
          row.calls = calls;
          assert.equal(calls, 1);
          assert.equal(row.journal[0].phase, "accepted");
          assert.equal(row.afterRecovery.status, "running");
          assert.equal(row.afterRecovery.activeWorker.taskId, valid.taskId);
          assert.equal(row.afterRecovery.activeWorker.runId, row.afterGate.activeWorker.runId);
        },
      );
