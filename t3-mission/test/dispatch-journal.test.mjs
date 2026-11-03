import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as kernel from "../kernel/index.mjs";
import { createMissionHudServer } from "../hud/server.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";

function fixture(t, approved = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
    "--no-gpg-sign",
  ]);
  kernel.proposeMission(dir, {
    repoPath: dir,
    title: "Receipt journal fixture",
    milestones: [{ id: "m1", title: "M1" }],
    features: [{ id: "f1", title: "F1", milestoneId: "m1" }],
    modelSettings: { skipScrutiny: true, skipUserTesting: true },
  });
  if (approved) kernel.approveMissionPlan(dir);
  return dir;
}
const receipt = {
  accepted: true,
  taskId: "accepted-task",
  childThreadId: "accepted-thread",
  runtimeTransport: "t3-delegate-task",
};
function records(dir) {
  const state = kernel.loadState(dir);
  return [
    state.activeWorker,
    ...state.sessions.filter((s) => s.runId === state.activeWorker?.runId),
    kernel.loadFeaturesDoc(dir).features[0],
  ];
}
function journal(dir) {
  return fs
    .readdirSync(path.join(dir, ".mission"))
    .filter((n) => /^dispatch-.*\.json$/.test(n))
    .map((n) => ({
      file: path.join(dir, ".mission", n),
      ...JSON.parse(fs.readFileSync(path.join(dir, ".mission", n))),
    }));
}
function bytes(dir) {
  const p = kernel.getMissionPaths(dir);
  return [p.statePath, p.featuresPath, p.modelSettingsPath, p.progressLogPath].map((f) =>
    fs.readFileSync(f, "utf8"),
  );
}
async function post(hud, action) {
  if (hud.post) return hud.post(action);
  const r = await fetch(hud.url + "/api/mission/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(4000),
  });
  return { status: r.status, body: await r.json() };
}
async function pending(dir, legacy = false) {
  kernel.approveMissionPlan(dir);
  await kernel.startMissionRun(dir);
  const state = kernel.loadState(dir);
  state.status = "paused";
  state.activeWorker.status = "paused";
  state.pausedAt = "2026-10-22T00:00:00Z";
  state.sessions[0].status = "paused";
  if (legacy)
    for (const row of [state.activeWorker, state.sessions[0]]) {
      delete row.dispatchPending;
      row.runtimeTransport = "legacy-unbound";
    }
  kernel.saveState(dir, state);
  return state.activeWorker.runId;
}
for (const transport of ["HTTP", "handler"])
  for (const kind of ["initial", "pending"])
    test(`Custom start hook journals ${kind} accepted receipt and invokes one hook${transport === "handler" ? " via handler" : ""}`, async (t) => {
      const dir = fixture(t);
      let originalRun = null;
      if (kind === "pending") {
        kernel.approveMissionPlan(dir);
        await kernel.startMissionRun(dir);
        originalRun = kernel.loadState(dir).activeWorker.runId;
      }
      let calls = 0,
        instructedRun;
      const hud = await (transport === "handler" ? createHandlerHud : createMissionHudServer)({
        missionDir: dir,
        port: 0,
        dispatchAdapter: {
          runFeature: async () => assert.fail("Explicit custom start hook owns this one dispatch"),
          startMissionRun: async (_dir, payload) => {
            calls++;
            instructedRun = payload.state.activeWorker.runId;
            kernel.appendProgressLog(dir, {
              type: "owner_history",
              message: "New owner history during transport",
            });
            return receipt;
          },
        },
      });
      try {
        assert.equal((await post(hud, "approve")).status, 409);
        assert.equal(journal(dir)[0].phase, "accepted");
        const acceptedJournal = journal(dir);
        const result = await post(hud, "approve");
        assert.equal(result.status, 200);
        assert.equal(calls, 1);
        assert.equal(acceptedJournal.length, 1);
        assert.deepEqual(
          journal(dir),
          acceptedJournal,
          "Retry reuses the durable accepted journal",
        );
        assert.equal(kernel.loadState(dir).status, "running");
        assert.equal(kernel.loadState(dir).sessions.length, 1);
        assert.equal(
          kernel.readProgressLog(dir).filter((row) => row.type === "owner_history").length,
          1,
        );
        for (const row of records(dir)) {
          assert.equal(row.runId, instructedRun);
          assert.equal(row.taskId, receipt.taskId);
          assert.equal(row.childThreadId, receipt.childThreadId);
          assert.equal(row.dispatchPending, undefined);
        }
        if (originalRun) assert.equal(instructedRun, originalRun);
      } finally {
        await hud.close();
      }
    });
for (const transport of ["HTTP", "handler"])
  test(`HUD Approve refuses a user Pause without invoking the custom start hook via ${transport}`, async (t) => {
    const dir = fixture(t),
      runId = await pending(dir);
    let calls = 0;
    const hook = async () => {
      calls++;
      return receipt;
    };
    const hud = await (transport === "handler" ? createHandlerHud : createMissionHudServer)({
      missionDir: dir,
      port: 0,
      dispatchAdapter: { startMissionRun: hook, runFeature: hook },
    });
    try {
      const saved = bytes(dir);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post(hud, "approve");
        assert.equal(response.status, 409);
        assert.equal(response.body.code, "MISSION_PAUSED");
        assert.equal(response.body.state.status, "paused");
        assert.equal(response.body.state.pausedAt, "2026-10-22T00:00:00Z");
        assert.equal(response.body.state.activeWorker.runId, runId);
        assert.equal(calls, 0);
        assert.deepEqual(bytes(dir), saved);
        assert.deepEqual(journal(dir), []);
      }
    } finally {
      await hud.close();
    }
  });
for (const entry of ["kernel", "http"])
  test(`${entry} legacy resume retains a newly delegated receipt`, async (t) => {
    const dir = fixture(t),
      runId = await pending(dir, true);
    let calls = 0;
    const adapter = {
      resumeWorker: async (worker) => {
        calls++;
        assert.equal(worker.runId, runId);
        return { ...receipt, resumed: true };
      },
    };
    if (entry === "kernel") await kernel.startMissionRun(dir, {}, adapter);
    else {
      const hud = await createMissionHudServer({
        missionDir: dir,
        port: 0,
        dispatchAdapter: adapter,
      });
      try {
        assert.equal((await post(hud, "resume")).status, 200);
      } finally {
        await hud.close();
      }
    }
    assert.equal(calls, 1);
    assert.equal(journal(dir)[0].phase, "accepted");
    for (const row of records(dir)) {
      assert.equal(row.taskId, receipt.taskId);
      assert.equal(row.childThreadId, receipt.childThreadId);
      assert.equal(row.dispatchPending, undefined);
    }
  });
test("Accepted journal is reused after closing and reopening the HUD", async (t) => {
  const dir = fixture(t);
  let originalRun,
    calls = 0;
  let hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    dispatchAdapter: {
      runFeature: async (_feature, _slot, state) => {
        calls++;
        originalRun = state.activeWorker.runId;
        kernel.appendProgressLog(dir, { message: "owner history" });
        return receipt;
      },
    },
  });
  try {
    assert.equal((await post(hud, "approve")).status, 409);
  } finally {
    await hud.close();
  }
  hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    dispatchAdapter: {
      runFeature: async () =>
        assert.fail("Accepted receipt is durable across a fresh HUD instance"),
    },
  });
  try {
    assert.equal((await post(hud, "approve")).status, 200);
    assert.equal(kernel.loadState(dir).activeWorker.runId, originalRun);
    assert.equal(calls, 1);
  } finally {
    await hud.close();
  }
});
test("Concurrent approvals cannot enter one dispatch executor twice", async (t) => {
  const dir = fixture(t);
  let entered,
    release,
    calls = 0;
  const began = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    dispatchAdapter: {
      runFeature: async () => {
        calls++;
        entered();
        await gate;
        return receipt;
      },
    },
  });
  let first;
  try {
    first = post(hud, "approve");
    await began;
    const second = await post(hud, "approve");
    assert.equal(second.body.code, "DISPATCH_OUTCOME_UNKNOWN");
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await first?.catch(() => {});
    await hud.close();
  }
});
for (const initial of [false, true])
  test(`Unknown ${initial ? "initial" : "pending"} transport acceptance blocks retries until verified Bind`, async (t) => {
    const dir = fixture(t, true);
    if (!initial) await kernel.startMissionRun(dir);
    let calls = 0;
    const adapter = {
      runFeature: async () => {
        calls++;
        throw new Error("Provider could have accepted before the reply was lost");
      },
    };
    await assert.rejects(() => kernel.startMissionRun(dir, {}, adapter), {
      code: "DISPATCH_OUTCOME_UNKNOWN",
    });
    assert.equal(journal(dir)[0].phase, "inflight");
    const unchanged = bytes(dir);
    await assert.rejects(() => kernel.startMissionRun(dir, {}, adapter), {
      code: "DISPATCH_OUTCOME_UNKNOWN",
    });
    assert.equal(calls, 1);
    assert.deepEqual(bytes(dir), unchanged);
    const state = kernel.loadState(dir);
    kernel.bindFeatureDispatch(dir, {
      ...receipt,
      featureId: "f1",
      runId: state.activeWorker.runId,
      expectedRevision: state.revision,
    });
    await kernel.startMissionRun(dir, {}, adapter);
    assert.equal(calls, 1);
    assert.equal(journal(dir)[0].phase, "accepted");
  });
test("Accepted journal rename EIO retains a durable receipt and recovers without redispatch", async (t) => {
  const dir = fixture(t),
    before = bytes(dir);
  let calls = 0,
    failed = false;
  const hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    dispatchAdapter: {
      runFeature: async () => {
        calls++;
        return receipt;
      },
    },
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await hud.close();
    }
  };
  t.after(close);
  const original = fs.renameSync;
  fs.renameSync = function (from, to, ...args) {
    if (
      !failed &&
      /^dispatch-.*\.json$/.test(path.basename(String(to))) &&
      JSON.parse(fs.readFileSync(from)).phase === "accepted"
    ) {
      failed = true;
      throw Object.assign(new Error("Owned accepted-journal EIO"), { code: "EIO" });
    }
    return original.call(this, from, to, ...args);
  };
  try {
    const first = await post(hud, "approve");
    assert.equal(first.status, 500);
    assert.equal(first.body.code, "EIO");
  } finally {
    fs.renameSync = original;
  }
  try {
    assert.equal(failed, true);
    const recovered = kernel.readMissionSnapshot(dir);
    assert.equal(recovered.state.planAccepted, true);
    assert.equal(recovered.state.sessions.length, 1);
    assert.equal(recovered.state.activeWorker.dispatchPending, true);
    assert.equal(bytes(dir)[2], before[2]);
    assert.equal(journal(dir)[0].phase, "accepted");
    const journalDir = path.dirname(journal(dir)[0].file);
    assert.equal(
      fs
        .readdirSync(journalDir)
        .filter((name) => name.includes(".accepted-") && name.endsWith(".tmp")).length,
      0,
    );
    const archived = fs.readdirSync(path.join(journalDir, ".txn/receipts"));
    assert.equal(archived.length, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(journalDir, ".txn/receipts", archived[0]), "utf8"))
        .result.taskId,
      receipt.taskId,
    );
    assert.equal((await post(hud, "approve")).status, 200);
    assert.equal(calls, 1);
    assert.equal(journal(dir)[0].phase, "accepted");
    for (const row of records(dir)) assert.equal(row.taskId, receipt.taskId);
    assert.equal(
      fs
        .readdirSync(journalDir)
        .filter((name) => name.includes(".accepted-") && name.endsWith(".tmp")).length,
      0,
    );
  } finally {
    await close();
  }
});
for (const field of ["run", "target", "task-fragments"])
  test(`Accepted ${field} conflict stays fenced and cannot attach foreign identity`, async (t) => {
    const dir = fixture(t);
    let before,
      calls = 0;
    const hud = await createMissionHudServer({
      missionDir: dir,
      port: 0,
      dispatchAdapter: {
        runFeature: async (_f, _w) => {
          calls++;
          before = bytes(dir);
          return field === "run"
            ? { ...receipt, featureId: "f1", runId: "another-run" }
            : field === "target"
              ? { ...receipt, target: { model: "another-model" } }
              : { ...receipt, response: { taskId: "another-task" } };
        },
      },
    });
    try {
      const result = await post(hud, "approve");
      assert.equal(result.status, 500);
      assert.ok(
        ["DISPATCH_RECEIPT_CONFLICT", "DISPATCH_TARGET_CONFLICT"].includes(result.body.code),
      );
      assert.deepEqual(bytes(dir), before);
      await post(hud, "approve");
      assert.equal(calls, 1);
    } finally {
      await hud.close();
    }
  });

test("Clearing three projections cannot erase an accepted journal or permit redispatch", async (t) => {
  const dir = fixture(t, true);
  let calls = 0;
  await kernel.startMissionRun(
    dir,
    {},
    {
      runFeature: async () => {
        calls++;
        return receipt;
      },
    },
  );
  const state = kernel.loadState(dir),
    doc = kernel.loadFeaturesDoc(dir),
    runId = state.activeWorker.runId;
  for (const row of [state.activeWorker, state.sessions[0], doc.features[0]]) {
    for (const key of ["taskId", "childThreadId", "childRunId", "clientRequestId", "worktreePath"])
      delete row[key];
    row.dispatchPending = true;
    row.runtimeTransport = "bridge-cli-subprocess";
  }
  kernel.saveState(dir, state);
  kernel.saveFeaturesDoc(dir, doc);
  await kernel.startMissionRun(
    dir,
    {},
    {
      runFeature: async () => {
        calls++;
        return { taskId: "duplicate", childThreadId: "duplicate" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(kernel.loadState(dir).activeWorker.runId, runId);
  for (const row of records(dir)) assert.equal(row.taskId, receipt.taskId);
});
test("A proven pending target edit records a new request while preserving the original run", async (t) => {
  const dir = fixture(t);
  let calls = 0;
  const requested = [];
  const hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    dispatchAdapter: {
      runFeature: async (_feature, worker) => {
        requested.push({ ...worker });
        calls++;
        return calls === 1
          ? { dispatchPending: true, runtimeTransport: "orchestrator-pending" }
          : receipt;
      },
    },
  });
  try {
    assert.equal((await post(hud, "approve")).status, 200);
    const r = await fetch(hud.url + "/api/mission/model-slots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "max" },
      }),
    });
    assert.equal(r.status, 200);
    assert.equal((await post(hud, "approve")).status, 200);
    assert.equal(calls, 2);
    assert.equal(requested[0].runId, requested[1].runId);
    assert.notEqual(requested[0].clientRequestId, requested[1].clientRequestId);
    assert.equal(requested[1].model, "gpt-6.1-sol");
    assert.equal(journal(dir)[0].history.length, 1);
    for (const row of records(dir)) assert.equal(row.clientRequestId, requested[1].clientRequestId);
  } finally {
    await hud.close();
  }
});
for (const corruption of ["receipt", "intent", "json"])
  test(`Corrupt ${corruption} journal is rejected before replay or transport`, async (t) => {
    const dir = fixture(t);
    let calls = 0;
    const hud = await createMissionHudServer({
      missionDir: dir,
      port: 0,
      dispatchAdapter: {
        runFeature: async () => {
          calls++;
          kernel.appendProgressLog(dir, { message: "owner history before projection" });
          return receipt;
        },
      },
    });
    try {
      assert.equal((await post(hud, "approve")).status, 409);
      const saved = bytes(dir),
        record = journal(dir)[0];
      if (corruption === "receipt") record.receipt = {};
      if (corruption === "intent") record.intent.clientRequestId = null;
      fs.writeFileSync(record.file, corruption === "json" ? "{broken" : JSON.stringify(record));
      const retry = await post(hud, "approve");
      assert.equal(retry.body.code, "INVALID_DISPATCH_JOURNAL");
      assert.equal(calls, 1);
      assert.deepEqual(bytes(dir), saved);
    } finally {
      await hud.close();
    }
  });

test("Progress written by a void callback is not an accepted worker receipt", async (t) => {
  const dir = fixture(t, true);
  await kernel.startMissionRun(
    dir,
    {},
    {
      runFeature: async () => {
        const state = kernel.loadState(dir);
        state.lastStartedAt = new Date(Date.now() - 5000).toISOString();
        kernel.saveState(dir, state);
      },
    },
  );
  for (const row of records(dir)) {
    assert.equal(row.dispatchPending, true);
    assert.equal(row.taskId, undefined);
    assert.equal(row.childThreadId, undefined);
  }
  assert.equal(journal(dir)[0].phase, "inflight");
});
