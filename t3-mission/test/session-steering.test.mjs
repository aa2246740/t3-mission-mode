import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
import { sendLiveThread } from "../hud/session-steering.mjs";

async function fixture(t, { status = "running", threadSender = async () => "recorded" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-steering-"));
  const mission = path.join(root, ".mission");
  fs.mkdirSync(mission);
  const worker = { sessionId: "s1", runId: "r1", featureId: "f1", childThreadId: "t1", status };
  const state = {
    missionId: "steering",
    title: "Steer threads",
    repoPath: root,
    status,
    revision: 3,
    ownerThreadId: "owner",
    activeWorker: worker,
    sessions: [
      { sessionId: "s0", runId: "r0", featureId: "f1", childThreadId: "t0", status: "completed" },
      worker,
      {
        sessionId: "v1",
        runId: "vr1",
        featureId: "vf1",
        link: "t3-thread://v1/validator",
        role: "Validator",
        status: "paused",
      },
      { sessionId: "pending", runId: "pending-run", featureId: "f2", status: "pending" },
    ],
  };
  const stateFile = path.join(mission, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const hud = await createHandlerHud({ missionDir: mission, threadSender });
  t.after(async () => {
    await hud.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    hud,
    state,
    stateFile,
    mission,
    logs: () =>
      fs
        .readFileSync(path.join(mission, "progress_log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse),
    snapshot: async () => (await fetch(hud.url + "/api/mission/state")).json(),
  };
}

for (const status of ["running", "paused"]) {
  test(`steering a ${status} Worker is recorded with exact run identity in its live feed`, async (t) => {
    const f = await fixture(t, { status });
    const result = await f.hud.post("steer", {
      sessionId: "s1",
      runId: "r1",
      featureId: "f1",
      childThreadId: "t1",
      message: "  Check the rollback path.  ",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      threadId: "t1",
      message: "Check the rollback path.",
      delivery: "recorded",
    });
    const event = f.logs()[0];
    assert.equal(event.type, "session_steered");
    assert.equal(event.seq, 1);
    assert.equal(event.featureId, "f1");
    assert.equal(event.runId, "r1");
    assert.equal(event.sessionId, "s1");
    assert.deepEqual(event.details, {
      threadId: "t1",
      message: "Check the rollback path.",
      delivery: "recorded",
    });
    const snapshot = await f.snapshot();
    assert.equal(snapshot.state.status, status);
    assert.equal(snapshot.state.revision, 3);
    assert.deepEqual(
      snapshot.threadFeed
        .filter((row) => row.type === "session_steered")
        .map((row) => [row.threadId, row.runId, row.role, row.message]),
      [["t1", "r1", "User", "Check the rollback path."]],
    );
    const scoped = await (
      await fetch(f.hud.url + "/api/mission/thread-feed?threadId=t1&sessionId=r1")
    ).json();
    assert.ok(scoped.events.some((row) => row.type === "session_steered"));
  });
}

test("steering supports default active, feature, URI-only Validator and owner selectors", async (t) => {
  const sends = [];
  const f = await fixture(t, {
    threadSender: async (...args) => {
      sends.push(args);
      return "sent";
    },
  });
  for (const [selector, expected] of [
    [{}, "t1"],
    [{ featureId: "f1" }, "t1"],
    [{ runId: "vr1", childThreadId: "t3-thread://v1/validator" }, "validator"],
    [{ childThreadId: "owner" }, "owner"],
  ]) {
    const result = await f.hud.post("steer", { ...selector, message: "Keep the tests." });
    assert.equal(result.status, 200);
    assert.equal(result.body.threadId, expected);
    assert.equal(result.body.delivery, "sent");
  }
  f.state.activeWorker = null;
  fs.writeFileSync(f.stateFile, JSON.stringify(f.state));
  assert.equal(
    (await f.hud.post("steer", { message: "Continue planning." })).body.threadId,
    "owner",
  );
  assert.deepEqual(sends, [
    ["t1", "Keep the tests."],
    ["t1", "Keep the tests."],
    ["validator", "Keep the tests."],
    ["owner", "Keep the tests."],
    ["owner", "Continue planning."],
  ]);
  assert.deepEqual(
    f.logs().map((row) => row.seq),
    [1, 2, 3, 4, 5],
  );
});

test("steering rejects empty messages, invalid selectors and foreign or mixed-run targets", async (t) => {
  const sends = [];
  const f = await fixture(t, { threadSender: async (...args) => sends.push(args) });
  for (const body of [
    {},
    { message: " " },
    { message: 1 },
    [],
    { message: "ok", runId: [] },
    { message: "ok", childThreadId: " " },
  ])
    assert.equal((await f.hud.post("steer", body)).status, 400, JSON.stringify(body));
  for (const selector of [
    { childThreadId: "foreign" },
    { runId: "r1", childThreadId: "t0" },
    { sessionId: "missing" },
    { runId: "r1", featureId: "vf1" },
    { sessionId: "s1", childThreadId: "owner" },
  ])
    assert.equal(
      (await f.hud.post("steer", { ...selector, message: "must not send" })).status,
      404,
      JSON.stringify(selector),
    );
  assert.equal((await f.hud.post("steer", { sessionId: "pending", message: "Wait." })).status, 409);
  assert.deepEqual(sends, []);
  assert.equal(fs.existsSync(path.join(f.mission, "progress_log.jsonl")), false);
});

test("provider steering runs outside the transaction and never overwrites concurrent state", async (t) => {
  let f;
  f = await fixture(t, {
    threadSender: async () => {
      const updated = { ...f.state, revision: 9, title: "Updated while sending" };
      fs.writeFileSync(f.stateFile, JSON.stringify(updated));
      return "sent";
    },
  });
  assert.equal((await f.hud.post("steer", { runId: "r1", message: "Check it." })).status, 200);
  assert.equal((await f.snapshot()).state.revision, 9);
  assert.equal((await f.snapshot()).state.title, "Updated while sending");
});

test("failed bridge sends never report success or append a successful steering event", async (t) => {
  const f = await fixture(t, {
    threadSender: async () => {
      throw new Error("bridge offline");
    },
  });
  const result = await f.hud.post("steer", { runId: "r1", message: "Try again." });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "STEERING_FAILED");
  assert.equal(result.body.ok, false);
  assert.equal(fs.existsSync(path.join(f.mission, "progress_log.jsonl")), false);
});

test("feature-only inspector sessions remain steerable without targeting stale handoffs", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    path.join(f.mission, "features.json"),
    JSON.stringify({
      features: [
        {
          id: "feature-only",
          runId: "feature-run",
          childThreadId: "feature-thread",
          status: "paused",
        },
        { id: "not-dispatched", status: "pending", lastHandoff: { childThreadId: "stale-thread" } },
      ],
    }),
  );
  const result = await f.hud.post("steer", {
    runId: "feature-run",
    childThreadId: "feature-thread",
    message: "Inspect the feature.",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.threadId, "feature-thread");
  assert.equal(
    (await f.hud.post("steer", { featureId: "not-dispatched", message: "Wait." })).status,
    409,
  );
});

test("historical sessions with a thread in their handoff can be steered by the inspector selectors", async (t) => {
  const f = await fixture(t);
  f.state.sessions[0].handoff = { childThreadId: "t0" };
  delete f.state.sessions[0].childThreadId;
  fs.writeFileSync(f.stateFile, JSON.stringify(f.state));
  const result = await f.hud.post("steer", {
    runId: "r0",
    childThreadId: "t0",
    message: "Explain the handoff.",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.threadId, "t0");
});

test("steering command replay does not send twice", async (t) => {
  const sends = [];
  const f = await fixture(t, {
    threadSender: async (...args) => {
      sends.push(args);
      return "sent";
    },
  });
  const body = { runId: "r1", commandId: "steer-once", message: "Run the required checks." };
  const first = await f.hud.post("steer", body);
  const second = await f.hud.post("steer", body);
  assert.equal(first.status, 200);
  assert.deepEqual(second, first);
  assert.deepEqual(sends, [["t1", "Run the required checks."]]);
  assert.equal(f.logs().length, 1);
});

test("steering rejects cross-origin and oversized HTTP requests before sending or recording", async (t) => {
  const sends = [];
  const f = await fixture(t, { threadSender: async (...args) => sends.push(args) });
  const foreign = await fetch(f.hud.url + "/api/mission/steer", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ runId: "r1", message: "No." }),
  });
  assert.equal(foreign.status, 403);
  await foreign.text();
  const oversized = await f.hud.post("steer", { runId: "r1", message: "x".repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(sends, []);
  assert.equal(fs.existsSync(path.join(f.mission, "progress_log.jsonl")), false);
});

test("default sender calls t3_thread_send through the bridge and distinguishes absent transport", async () => {
  assert.equal(await sendLiveThread("t1", "Inspect the diff.", { env: {} }), "recorded");
  const calls = [];
  const options = {
    env: {},
    transportClient: async (...args) => {
      calls.push(args.slice(0, 2));
      return { accepted: true, threadId: "t1" };
    },
  };
  assert.equal(await sendLiveThread("t1", "Inspect the diff.", options), "sent");
  assert.deepEqual(calls, [["t3_thread_send", { threadId: "t1", message: "Inspect the diff." }]]);
  await assert.rejects(
    sendLiveThread("t1", "Inspect the diff.", {
      env: {},
      transportClient: async () => ({
        isError: true,
        content: [{ type: "text", text: "refused" }],
      }),
    }),
  );
});
