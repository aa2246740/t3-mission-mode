import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { readController } from "../kernel/autopilot-store.mjs";
const now = 1793000000000,
  root = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a9-multiple-"));
const tick = async (d, observations = [], time = now) =>
  (await k.missionTick(d, { observations, now: time })).action;
const obs = (a, response, type = "dispatch") => ({
  type,
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  ...(type === "dispatch" ? { invocationId: a.invocationId } : { taskId: "task-" + a.attempt }),
  response,
});
const status = (a, kind, extra = {}) =>
  obs(
    a,
    {
      taskId: "task-" + a.attempt,
      childThreadId: "thread-" + a.attempt,
      childRunId: "current-" + a.attempt,
      status: kind,
      workState: kind === "running" ? "working" : "result_available",
      hasPendingChildRuns: false,
      ...extra,
    },
    "task_status",
  );
const permute = (a) =>
  a.length === 0
    ? [[]]
    : a.flatMap((v, i) => permute(a.filter((_, j) => j !== i)).map((rest) => [v, ...rest]));
const fresh = (d, time) =>
  JSON.parse(
    cp.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify((await k.missionTick(process.argv[1],{now:Number(process.argv[2])})).action));`,
        d,
        String(time),
      ],
      { encoding: "utf8" },
    ),
  );
for (const n of [2, 3])
  for (const order of permute(Array.from({ length: n }, (_, i) => i)))
    test(`A9 ${n} late intents terminal order ${order}`, async () => {
      const d = path.join(root, n + "-" + order.join("-"));
      fs.mkdirSync(d);
      k.proposeMission(d, {
        title: "All intents own their fence",
        repoPath: d,
        autopilot: true,
        pauseMode: "let_finish",
        ownerThreadId: "owner",
        milestones: [{ id: "m1" }],
        features: [{ id: "f1", milestoneId: "m1", maxAttempts: 6 }],
        retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000, maxConsecutiveProviderErrors: 10 },
        integration: { branch: "main", auto: true },
      });
      k.approveMissionPlan(d);
      const t = await tick(d);
      let a = await tick(d, [
          { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
        ]),
        attempts = [];
      for (let i = 0; i < n; i++) {
        assert.equal(a.type, "dispatch");
        attempts.push(a);
        await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })], now + i * 1000);
        if (i + 1 < n) a = await tick(d, [], now + (i + 1) * 1000);
      }
      const original = JSON.stringify(k.loadState(d).sessions);
      await tick(
        d,
        attempts.map((a) =>
          obs(a, {
            accepted: true,
            taskId: "task-" + a.attempt,
            childThreadId: "thread-" + a.attempt,
            childRunId: "current-" + a.attempt,
          }),
        ),
        now + n * 1000,
      );
      // An obsolete child turn and a terminal parent with pending children cannot settle anything.
      assert.notEqual(
        (
          await tick(
            d,
            [
              status(attempts[0], "cancelled", { childRunId: "obsolete" }),
              status(attempts[0], "completed", {
                hasPendingChildRuns: true,
                pendingChildRuns: ["child"],
                workState: "waiting_for_children",
              }),
            ],
            now + n * 1000,
          )
        ).type,
        "dispatch",
      );
      assert.equal(
        Object.keys(readController(d, k.loadState(d).missionId).dispatchResolutions ?? {}).length,
        0,
      );
      for (let j = 0; j < n; j++) {
        const action = await tick(
          d,
          [status(attempts[order[j]], j % 2 ? "cancelled" : "failed")],
          now + (n + 1 + j) * 1000,
        );
        const ledger = readController(d, k.loadState(d).missionId);
        assert.equal(Object.values(ledger.dispatchResolutions ?? {}).length, j + 1);
        assert.equal(
          Object.values(ledger.dispatchReconciliations).filter((row) => !row.resolutionId).length,
          n - j - 1,
        );
        assert.equal(JSON.stringify(k.loadState(d).sessions.slice(0, n)), original);
        if (j + 1 < n) {
          assert.notEqual(action.type, "dispatch");
          assert.notEqual(fresh(d, now + (n + j + 2) * 1000).type, "dispatch");
        } else {
          assert.equal(action.type, "dispatch");
          assert.equal(action.attempt, n + 1);
          await finishMission(d, action, now + (n + j + 3) * 1000);
        }
      }
    });

async function finishMission(d, action, time) {
  for (let step = 0; step < 4 && action.type === "dispatch"; step++) {
    const a = action,
      task = "finish-" + a.runId;
    await tick(
      d,
      [obs(a, { accepted: true, taskId: task, childThreadId: task + "-thread" })],
      time++,
    );
    const body = {
      version: 1,
      featureId: a.featureId,
      runId: a.runId,
      status: "success",
      summary:
        "This literal fixture completes the selected original task with matching commit, branch, passing checks and both required validator stages.",
      tests: [{ command: "fixture-check", status: "passed" }],
      discoveredIssues: [],
      whatWasLeftUndone: [],
      commit: "abcdef1234567",
      branch: "feature/original",
      testedSha: "abcdef1234567",
      failedAssertions: [],
      assertionResults: {},
    };
    action = await tick(
      d,
      [
        {
          type: "task_status",
          runId: a.runId,
          featureId: a.featureId,
          taskId: task,
          response: {
            taskId: task,
            childThreadId: task + "-thread",
            status: "completed",
            workState: "result_available",
            hasPendingChildRuns: false,
            summary: "```mission-result\n" + JSON.stringify(body) + "\n```",
          },
        },
      ],
      time++,
    );
    if (action.kind === "integrate")
      action = await tick(
        d,
        [
          obs(
            a,
            {
              branch: "main",
              sourceBranch: "feature/original",
              commit: "abcdef1234567",
              mergeSha: "abcdef1234567",
            },
            "integration",
          ),
        ],
        time++,
      );
  }
  assert.equal(action.type, "disable_timer");
  await tick(
    d,
    [
      {
        type: "timer_disabled",
        requestId: action.requestId,
        response: { taskId: action.scheduledTaskId, enabled: false },
      },
    ],
    time++,
  );
  assert.equal(fresh(d, time).type, "done");
}

test("A9 consumes the newer active run after auditing late success, then continues within budget", async () => {
  const d = path.join(root, "active-newer");
  fs.mkdirSync(d);
  k.proposeMission(d, {
    title: "Adopt before selecting again",
    repoPath: d,
    autopilot: true,
    pauseMode: "let_finish",
    ownerThreadId: "owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1", maxAttempts: 6 }],
    retryPolicy: { baseDelayMs: 1000, maxDelayMs: 1000 },
    integration: { branch: "main", auto: true },
  });
  k.approveMissionPlan(d);
  const t = await tick(d),
    a = await tick(d, [
      { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
    ]);
  await tick(d, [obs(a, { accepted: false, code: "PROVIDER_BUSY" })]);
  const old = JSON.stringify(k.loadState(d).sessions[0]);
  const b = await tick(d, [], now + 1000);
  await tick(
    d,
    [
      obs(b, {
        accepted: true,
        taskId: "task-2",
        childThreadId: "thread-2",
        childRunId: "current-2",
      }),
    ],
    now + 1001,
  );
  await tick(
    d,
    [
      obs(a, {
        accepted: true,
        taskId: "task-1",
        childThreadId: "thread-1",
        childRunId: "current-1",
      }),
    ],
    now + 1002,
  );
  const body = {
    version: 1,
    featureId: a.featureId,
    runId: a.runId,
    status: "success",
    summary:
      "The preserved original work has a durable matching commit and branch with passing checks. Its immutable session history must remain intact.",
    tests: [{ command: "fixture-check", status: "passed" }],
    discoveredIssues: [],
    whatWasLeftUndone: [],
    commit: "abcdef1234567",
    branch: "feature/original",
  };
  assert.equal(
    (
      await tick(
        d,
        [
          status(a, "completed", {
            summary: "```mission-result\n" + JSON.stringify(body) + "\n```",
          }),
        ],
        now + 1003,
      )
    ).type,
    "poll",
  );
  let action = await tick(d, [status(b, "failed", { summary: "429 rate limit" })], now + 1004);
  assert.equal(action.type, "sleep");
  assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
  assert.equal(k.loadFeaturesDoc(d).features[0].attempts, 2);
  assert.equal(JSON.stringify(k.loadState(d).sessions[0]), old);
  const resolved = Object.values(readController(d, k.loadState(d).missionId).dispatchResolutions);
  assert.equal(resolved[0].result.envelope.status, "success");
  assert.equal(k.loadState(d).lateResultAdoptions, undefined);
  action = await tick(d, [], now + 100000);
  assert.equal(action.type, "dispatch");
  assert.equal(action.attempt, 3);
  await finishMission(d, action, now + 100001);
});
