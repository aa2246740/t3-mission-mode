import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as k from "../kernel/index.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";

const rows = [];
const accepted = {
  accepted: true,
  resumed: true,
  taskId: "r9b-task",
  childThreadId: "r9b-thread",
  childRunId: "r9b-child-run",
  runtimeTransport: "t3-delegate-task",
};
const pending = { dispatchPending: true, runtimeTransport: "orchestrator-pending" };
const settings = {
  skipScrutiny: true,
  skipUserTesting: true,
  worker: {
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    options: { reasoningEffort: "max", serviceTier: "priority" },
  },
};
const names = ["state.json", "features.json", "model-settings.json", "progress_log.jsonl"];
const bytes = (d) =>
  Object.fromEntries(
    names.map((n) => {
      const p = path.join(d, ".mission", n);
      return [n, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null];
    }),
  );
const journals = (d) =>
  fs
    .readdirSync(path.join(d, ".mission"))
    .filter((n) => /^dispatch-.*\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(d, ".mission", n), "utf8")));
function check(name, fn) {
  test(name, async (t) => {
    const row = { name };
    try {
      await fn(t, row);
      row.pass = true;
    } catch (error) {
      row.pass = false;
      row.error = error.stack;
      throw error;
    } finally {
      rows.push(row);
    }
  });
}
after(() => {
  if (process.env.R9_EVIDENCE_DIR)
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, "r9b-contracts.json"),
      JSON.stringify(rows, null, 2) + "\n",
    );
});
function repo(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "r9b-handler-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", d]);
  fs.writeFileSync(path.join(d, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(d, "README.md"), "baseline\n");
  execFileSync("git", ["-C", d, "add", "."]);
  execFileSync("git", [
    "-C",
    d,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  ]);
  return d;
}
async function fixture(t, mode = "pending") {
  const d = repo(t);
  k.proposeMission(d, {
    repoPath: d,
    features: [{ id: "f1", milestoneId: "m1" }],
    modelSettings: settings,
  });
  k.approveMissionPlan(d);
  if (mode !== "initial") await k.startMissionRun(d);
  return d;
}
function legacy(t) {
  const d = repo(t);
  fs.mkdirSync(path.join(d, ".mission"));
  const worker = {
    runId: "legacy-run",
    featureId: "f1",
    featureTitle: "First",
    workerNumber: 1,
    milestoneId: "m1",
    status: "running",
    taskId: "old-task",
    childThreadId: "old-thread",
    worktreePath: d,
  };
  k.saveState(d, {
    missionId: "legacy-mission",
    repoPath: d,
    status: "running",
    planAccepted: true,
    revision: 2,
    elapsedMs: 1000,
    lastStartedAt: new Date(Date.now() - 2000).toISOString(),
    milestones: [{ id: "m1" }],
    activeWorker: worker,
    sessions: [{ ...worker }],
  });
  return d;
}
// Exercise the real loopback HTTP boundary and close the listener after each case.
async function loopbackHud(t, d, adapter) {
  const hud = await createHandlerHud({ missionDir: d, dispatchAdapter: adapter });
  t.after(() => hud.close());
  return hud.post;
}

function records(d) {
  const s = k.loadState(d);
  return [s.activeWorker, s.sessions.at(-1), k.loadFeaturesDoc(d).features[0]];
}
function deferred() {
  let resolve;
  return {
    promise: new Promise((r) => {
      resolve = r;
    }),
    resolve,
  };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("loopback HTTP timeout")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

check("R9b I-07: legacy dirty-tree HUD resume returns 200 with diagnostic", async (t, row) => {
  const d = legacy(t);
  let calls = 0;
  const post = await loopbackHud(t, d, {
    resumeWorker: async () => {
      calls++;
      return { resumed: true };
    },
  });
  k.reconcileMissionOnLoad(d);
  assert.equal(k.loadState(d).status, "paused");
  fs.appendFileSync(path.join(d, "README.md"), "dirty\n");
  const response = await post("resume");
  Object.assign(row, { response, calls });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.match(response.body.diagnostic, /has uncommitted changes \(README\.md\)/);
  assert.equal(response.body.state.activeWorker.resumePending, true);
});
check("R9b P22: legacy HUD resume calls failing adapter and returns 500", async (t, row) => {
  const d = legacy(t);
  let calls = 0;
  const post = await loopbackHud(t, d, {
    resumeWorker: async () => {
      calls++;
      throw new Error("Runtime resume unavailable");
    },
  });
  const s = k.loadState(d);
  s.status = "paused";
  s.activeWorker.status = "paused";
  k.saveState(d, s);
  const before = bytes(d),
    response = await post("resume");
  Object.assign(row, { response, calls });
  assert.equal(response.status, 500);
  assert.equal(calls, 1);
  assert.match(response.body.error, /Runtime resume unavailable/);
  assert.deepEqual(bytes(d), before);
});
check("R9b V01: HUD approval then orchestrator_turn upgrades same pending run", async (t, row) => {
  const d = await fixture(t, "initial");
  const post = await loopbackHud(t, d, { runFeature: async () => pending });
  assert.equal((await post("approve")).status, 200);
  const original = k.loadState(d);
  original.status = "orchestrator_turn";
  k.saveState(d, original);
  k.approveMissionPlan(d);
  const calls = [];
  const result = await callMissionTool(
    "StartMissionRun",
    { missionDir: d },
    {
      kernel: k,
      dispatchAdapter: {
        runFeature: async (f) => {
          calls.push(f.id);
          return accepted;
        },
      },
    },
  );
  Object.assign(row, { calls, result });
  assert.deepEqual(calls, ["f1"]);
  assert.equal(result.activeWorker.runId, original.activeWorker.runId);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.activeWorker.taskId, accepted.taskId);
});
for (const outcome of ["success", "throw", "reject"])
  check(
    "R9b V10/V11: in-flight HUD Pause keeps owner and accepted slot, pause " + outcome,
    async (t, row) => {
      const d = await fixture(t, "initial");
      const post = await loopbackHud(t, d, {
        runFeature: async () => pending,
        pauseWorker: async () => ({ paused: true }),
      });
      assert.equal((await post("approve")).status, 200);
      assert.equal(
        (
          await post("model-slots", {
            worker: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", effort: 3 },
          })
        ).status,
        200,
      );
      const entered = deferred(),
        release = deferred();
      let slot,
        dispatches = 0;
      const pauses = [];
      const adapter = {
        runFeature: async (_f, target) => {
          dispatches++;
          slot = target;
          entered.resolve();
          await release.promise;
          return accepted;
        },
        pauseWorker: async (worker) => {
          pauses.push(worker);
          if (outcome === "throw") throw new Error("child pause unavailable");
          return outcome === "reject"
            ? { paused: false, code: "CHILD_PAUSE_REFUSED", error: "child pause refused" }
            : { paused: true };
        },
      };
      const running = callMissionTool(
        "StartMissionRun",
        { missionDir: d },
        { kernel: k, dispatchAdapter: adapter },
      );
      try {
        await bounded(entered.promise);
        assert.equal((await post("pause")).status, 200);
        const owner = k.loadState(d);
        owner.ownerDecision = "keep latest owner";
        owner.revision++;
        k.saveState(d, owner);
        release.resolve();
        await running;
        const final = k.loadState(d);
        Object.assign(row, { dispatches, pauses, owner, final, slot, journal: journals(d) });
        assert.equal(pauses.length, 1);
        assert.equal(pauses[0].taskId, accepted.taskId);
        assert.equal(final.status, "paused");
        assert.equal(final.pausedAt, owner.pausedAt);
        assert.equal(final.lastStartedAt, owner.lastStartedAt);
        assert.equal(final.ownerDecision, owner.ownerDecision);
        for (const rec of records(d)) {
          for (const key of ["taskId", "childThreadId", "childRunId"])
            assert.equal(rec[key], accepted[key]);
          for (const key of ["providerInstanceId", "model", "options"])
            assert.deepEqual(rec[key], slot[key]);
        }
        assert.equal(final.activeWorker.status, outcome === "success" ? "paused" : "running");
        assert.equal(final.sessions.at(-1).status, outcome === "success" ? "paused" : "running");
        assert.equal(journals(d)[0].phase, "accepted");
        if (outcome !== "success") assert.match(final.activeWorker.pauseError, /child pause/);
        // Replaying the owner path can resume this identity; it never creates a second child.
        await k.startMissionRun(
          d,
          {},
          { ...adapter, resumeWorker: async () => ({ resumed: true }) },
        );
        assert.equal(dispatches, 1);
        assert.equal(pauses.length, 1);
      } finally {
        release.resolve();
        await running.catch(() => {});
      }
    },
  );
check("R9b MW-R8-01: completed replacement HUD approve never enters executor", async (t, row) => {
  const d = await fixture(t);
  k.proposeMission(d, {
    repoPath: d,
    features: [{ id: "f1", milestoneId: "m1", status: "completed" }],
    modelSettings: settings,
  });
  k.approveMissionPlan(d);
  const before = bytes(d),
    beforeJournal = journals(d);
  let calls = 0;
  const hook = async () => {
    calls++;
    return accepted;
  };
  const post = await loopbackHud(t, d, { runFeature: hook, startMissionRun: hook });
  const response = await post("approve");
  Object.assign(row, { calls, response });
  assert.equal(response.status, 409);
  assert.equal(calls, 0);
  assert.deepEqual(bytes(d), before);
  assert.deepEqual(journals(d), beforeJournal);
});
check("R9b MW-R8-01: awaiting_input retryable HUD resume never reenters hook", async (t, row) => {
  const d = await fixture(t, "initial");
  let calls = 0;
  const hook = async () => {
    calls++;
    const s = k.loadState(d);
    s.status = "awaiting_input";
    s.revision++;
    k.saveState(d, s);
    return pending;
  };
  await k.startMissionRun(d, {}, { runFeature: hook });
  const before = bytes(d),
    beforeJournal = journals(d);
  const post = await loopbackHud(t, d, {
    runFeature: hook,
    resumeWorker: hook,
    startMissionRun: hook,
  });
  const response = await post("resume");
  Object.assign(row, { calls, response });
  assert.equal(response.status, 409);
  assert.equal(calls, 1);
  assert.deepEqual(bytes(d), before);
  assert.deepEqual(journals(d), beforeJournal);
});

for (const absent of [
  "feature",
  "session",
  "feature-run",
  "session-status",
  "session-attempt",
  "worker-status",
])
  check("R9b legacy HUD resume tolerates absent " + absent, async (t, row) => {
    const d = legacy(t),
      s = k.loadState(d);
    s.status = "paused";
    s.activeWorker.status = "paused";
    if (absent === "session") s.sessions = [];
    if (absent === "session-status") delete s.sessions[0].status;
    if (absent === "session-attempt") s.activeWorker.attempt = 1;
    if (absent === "worker-status") delete s.activeWorker.status;
    k.saveState(d, s);
    if (absent !== "feature") k.saveFeaturesDoc(d, { features: [{ id: "f1", status: "running" }] });
    let calls = 0;
    const post = await loopbackHud(t, d, {
      resumeWorker: async () => {
        calls++;
        throw new Error("legacy adapter reached");
      },
    });
    const before = bytes(d),
      response = await post("resume");
    Object.assign(row, { calls, response });
    assert.equal(response.status, 500);
    assert.equal(calls, 1);
    assert.deepEqual(bytes(d), before);
  });
for (const action of ["approve", "resume"])
  for (const gate of ["reject", "reproposal", "awaiting_input", "handoff", "new-pause"])
    check("R9b HUD late receipt " + action + " preserves " + gate, async (t, row) => {
      const d = await fixture(t),
        entered = deferred(),
        release = deferred();
      if (action === "resume") {
        const s = k.loadState(d);
        s.status = "paused";
        s.pausedAt = "old-pause";
        for (const rec of [s.activeWorker, s.sessions[0]]) {
          rec.status = "paused";
          delete rec.dispatchPending;
          delete rec.runtimeTransport;
        }
        k.saveState(d, s);
      }
      let dispatches = 0;
      const pauses = [];
      const hook = async () => {
        dispatches++;
        entered.resolve();
        await release.promise;
        return accepted;
      };
      const post = await loopbackHud(t, d, {
        runFeature: hook,
        resumeWorker: hook,
        pauseWorker: async (worker) => {
          if (worker.taskId) pauses.push(worker);
          return { paused: true };
        },
      });
      const running = post(action);
      try {
        await bounded(entered.promise);
        if (gate === "reject")
          assert.equal((await post("reject", { feedback: "review again" })).status, 200);
        else if (gate === "reproposal")
          k.proposeMission(d, {
            repoPath: d,
            features: k.loadFeaturesDoc(d).features,
            modelSettings: settings,
          });
        else if (gate === "new-pause") assert.equal((await post("pause")).status, 200);
        else {
          const s = k.loadState(d);
          s.revision++;
          if (gate === "handoff") s.lastHandoffNeedsAttention = true;
          else s.status = "awaiting_input";
          k.saveState(d, s);
        }
        const owner = bytes(d),
          ownerState = k.loadState(d);
        release.resolve();
        const response = await running;
        Object.assign(row, { dispatches, pauses, response, journal: journals(d) });
        assert.equal(response.status, 409);
        assert.equal(dispatches, 1);
        assert.equal(journals(d)[0].phase, "accepted");
        if (gate !== "new-pause") {
          assert.deepEqual(bytes(d), owner);
          assert.equal(pauses.length, 0);
        } else {
          assert.equal(pauses.length, 1);
          assert.equal(pauses[0].taskId, accepted.taskId);
          const final = k.loadState(d);
          assert.equal(final.status, "paused");
          assert.equal(final.pausedAt, ownerState.pausedAt);
          for (const rec of records(d))
            for (const key of ["taskId", "childThreadId", "childRunId"])
              assert.equal(rec[key], accepted[key]);
          assert.equal(bytes(d)["model-settings.json"], owner["model-settings.json"]);
          assert.equal(bytes(d)["progress_log.jsonl"], owner["progress_log.jsonl"]);
        }
      } finally {
        release.resolve();
        await running.catch(() => {});
      }
    });

check("R9b HUD approve cannot clear a user Pause before dispatch", async (t, row) => {
  const d = await fixture(t),
    s = k.loadState(d);
  s.status = "paused";
  s.pausedAt = "user-pause";
  s.activeWorker.status = "paused";
  k.saveState(d, s);
  let calls = 0;
  const hook = async () => {
    calls++;
    return accepted;
  };
  const post = await loopbackHud(t, d, { runFeature: hook, startMissionRun: hook });
  const before = bytes(d),
    response = await post("approve");
  Object.assign(row, { calls, response });
  assert.equal(response.status, 409);
  assert.equal(calls, 0);
  assert.deepEqual(bytes(d), before);
});
