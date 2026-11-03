import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";
import { createHandlerHud, bounded } from "./hud-handler-fixture.mjs";
import { hasActiveMissionTransaction } from "../kernel/mission-transaction.mjs";
import { assertRejectedPause } from "./pause-contract-fixture.mjs";

const receipt = {
  accepted: true,
  taskId: "continuation-task",
  childThreadId: "continuation-thread",
  runtimeTransport: "t3-delegate-task",
};
async function fixture(t, bound = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-continuation-"));
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
  k.proposeMission(dir, {
    repoPath: dir,
    title: "Continuation",
    features: [{ id: "f1" }],
    modelSettings: { skipScrutiny: true, skipUserTesting: true },
  });
  k.approveMissionPlan(dir);
  await k.startMissionRun(dir, {}, bound ? { runFeature: async () => receipt } : {});
  return dir;
}
function bytes(dir) {
  const p = k.getMissionPaths(dir);
  return Object.fromEntries(
    ["statePath", "featuresPath", "modelSettingsPath", "progressLogPath"].map((key) => [
      key,
      fs.readFileSync(p[key], "utf8"),
    ]),
  );
}
function paused(dir) {
  const state = k.loadState(dir);
  state.status = "paused";
  state.pausedAt = "2026-10-23T00:00:00.000Z";
  state.revision++;
  state.activeWorker.status = "paused";
  state.sessions[0].status = "paused";
  k.saveState(dir, state);
}

test("WP3 P22 handler retains the Pause gate after a thrown control and preserves failed Resume", async (t) => {
  const dir = await fixture(t),
    before = k.loadState(dir),
    calls = [];
  const hud = await createHandlerHud({
    missionDir: dir,
    dispatchAdapter: {
      pauseWorker: async () => {
        calls.push("pause");
        throw new Error("Runtime pause unavailable");
      },
      resumeWorker: async () => {
        calls.push("resume");
        throw new Error("Runtime resume unavailable");
      },
    },
  });
  t.after(() => hud.close());
  assert.equal((await hud.post("pause")).status, 500);
  const state = k.loadState(dir);
  assert.equal(state.status, "paused");
  assert.deepEqual(state.activeWorker, before.activeWorker);
  assert.deepEqual(state.sessions, before.sessions);
  assert.equal(state.pauseControl.phase, "unknown");
  const saved = bytes(dir);
  assert.equal((await hud.post("resume")).status, 500);
  assert.deepEqual(calls, ["pause", "resume"]);
  assert.deepEqual(bytes(dir), saved);
});

test("WP3 dead-runtime handler retains the Pause gate and never repeats a refused control", async (t) => {
  const dir = await fixture(t),
    before = bytes(dir);
  let pauses = 0,
    resumes = 0;
  const hud = await createHandlerHud({
    missionDir: dir,
    dispatchAdapter: {
      pauseWorker: async () => {
        pauses++;
        return { ok: false, paused: false, code: "WORKER_NOT_ALIVE" };
      },
      resumeWorker: async () => {
        resumes++;
        return { ok: false, resumed: false, code: "WORKER_NOT_ALIVE" };
      },
    },
  });
  t.after(() => hud.close());
  const first = await hud.post("pause");
  assert.equal(first.status, 409);
  assert.equal(first.body.code, "WORKER_NOT_ALIVE");
  assertRejectedPause(dir, before, "WORKER_NOT_ALIVE");
  const saved = bytes(dir);
  assert.equal((await hud.post("pause")).status, 409);
  assert.equal(pauses, 1);
  assert.deepEqual(bytes(dir), saved);
  assert.equal((await hud.post("resume")).status, 409);
  assert.equal(resumes, 1);
  assert.deepEqual(bytes(dir), saved);
});

test("WP3 handler commits only the Pause gate while control awaits, then confirms every run projection", async (t) => {
  const dir = await fixture(t),
    before = k.readMissionSnapshot(dir);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const hud = await createHandlerHud({
    missionDir: dir,
    dispatchAdapter: {
      pauseWorker: async () => {
        assert.equal(hasActiveMissionTransaction(), false);
        enter();
        await wait;
        return { paused: true };
      },
    },
  });
  t.after(() => hud.close());
  const response = hud.post("pause");
  try {
    await bounded(entered);
    const during = k.readMissionSnapshot(dir);
    assert.equal(during.state.status, "paused");
    assert.deepEqual(during.state.activeWorker, before.state.activeWorker);
    assert.deepEqual(during.state.sessions, before.state.sessions);
    assert.deepEqual(during.featuresDoc, before.featuresDoc);
    assert.equal(during.state.pauseControl.phase, "requested");
  } finally {
    release();
  }
  assert.equal((await response).status, 200);
  const after = k.readMissionSnapshot(dir);
  assert.equal(after.state.pauseControl.phase, "confirmed");
  for (const row of [
    after.state.activeWorker,
    after.state.sessions[0],
    after.featuresDoc.features[0],
  ])
    assert.equal(row.status, "paused");
});

test("WP3 handler refuses Resume when no adapter can control the existing run", async (t) => {
  const dir = await fixture(t);
  paused(dir);
  const saved = bytes(dir);
  const hud = await createHandlerHud({ missionDir: dir, dispatchAdapter: {} });
  t.after(() => hud.close());
  const response = await hud.post("resume");
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "NO_T3_TRANSPORT");
  assert.deepEqual(bytes(dir), saved);
});

for (const outcome of ["throws", "rejects", "confirms"])
  test(`WP3 handler bound Resume invokes its transport before gate commit: ${outcome}`, async (t) => {
    const dir = await fixture(t);
    paused(dir);
    const saved = bytes(dir);
    let calls = 0;
    const hud = await createHandlerHud({
      missionDir: dir,
      dispatchAdapter: {
        resumeWorker: async () => {
          calls++;
          assert.equal(k.loadState(dir).status, "paused");
          assert.equal(hasActiveMissionTransaction(), false);
          if (outcome === "throws") throw new Error("Unknown acceptance");
          if (outcome === "rejects") return { accepted: false, code: "PROVIDER_BUSY" };
          return { ...receipt, resumed: true };
        },
      },
    });
    t.after(() => hud.close());
    const response = await hud.post("resume");
    assert.equal(calls, 1);
    assert.equal(response.status, outcome === "confirms" ? 200 : outcome === "throws" ? 500 : 409);
    if (outcome === "confirms") {
      const state = k.loadState(dir);
      assert.equal(state.status, "running");
      assert.equal(state.activeWorker.taskId, receipt.taskId);
    } else assert.deepEqual(bytes(dir), saved);
  });
