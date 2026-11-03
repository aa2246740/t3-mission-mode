import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readController, readObservations } from "../kernel/autopilot-store.mjs";
import { dispatchRuntimeInvocation } from "../kernel/dispatch-journal.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
import {
  init,
  tick,
  now,
  reapprove,
  observation,
  accepted,
  status,
  result,
  fresh,
  first,
  rejectedAttempts,
  finish,
} from "./fixtures/a10-fixture.mjs";
const save = (n, x) =>
  fs.writeFileSync(
    path.join(process.env.R9_EVIDENCE_DIR, n + ".json"),
    JSON.stringify(x, null, 2) + "\n",
  );

for (const intentTagged of [false, true])
  test("R10 active accepted retarget survives historical terminal " + intentTagged, async () => {
    const d = init("active-retarget");
    await assert.rejects(() =>
      k.startMissionRun(
        d,
        {},
        { runFeature: async () => ({ accepted: false, code: "PROVIDER_BUSY" }) },
      ),
    );
    const old = inspectDispatchRecords(d)[0];
    reapprove(d, "replacement-model");
    await k.startMissionRun(
      d,
      {},
      {
        runFeature: async () => ({
          accepted: true,
          taskId: "current-task",
          childThreadId: "current-thread",
          childRunId: "current-turn",
        }),
      },
    );
    const current = inspectDispatchRecords(d)[0];
    assert.notEqual(old.intent.clientRequestId, current.intent.clientRequestId);
    const a = {
      featureId: "f1",
      runId: old.intent.runId,
      intentId: old.intent.clientRequestId,
      invocationId: old.invocations[0].invocationId,
      attempt: 1,
      taskId: "old-task",
      childThreadId: "old-thread",
      childRunId: "old-turn",
    };
    const late = await tick(d, [observation(a, accepted(a))], now + 1000);
    const terminal = status(a, "cancelled");
    if (!intentTagged) delete terminal.intentId;
    let stopped = await tick(d, [terminal], now + 1001);
    if (stopped.type === "ensure_timer")
      stopped = await tick(
        d,
        [
          {
            type: "timer",
            requestId: stopped.requestId,
            response: { taskId: "timer", enabled: true },
          },
        ],
        now + 1002,
      );
    const bare = fresh(d, "tick", { now: now + 1002 });
    const second = fresh(d, "tick", { now: now + 1003 });
    save("active-retarget-" + intentTagged, {
      d,
      old,
      current,
      late,
      terminal,
      stopped,
      bare,
      second,
      state: k.loadState(d),
      ledger: readController(d, k.loadState(d).missionId),
    });
    assert.equal(late.type, "poll");
    assert.notEqual(
      stopped.type,
      "wait_user",
      "An old task terminal must not become a status error on the accepted current task",
    );
    assert.notEqual(bare.result.action.type, "wait_user");
  });

for (const staleLatest of [false, true])
  test("R10 manual terminal proof checks latest terminal identity " + staleLatest, async () => {
    const d = init("manual-latest");
    const timer = await tick(d);
    const a = await tick(d, [
      { type: "timer", requestId: timer.requestId, response: { taskId: "timer", enabled: true } },
    ]);
    await tick(d, [observation(a, { accepted: false, code: "PROVIDER_BUSY" })]);
    const b = {
      ...a,
      taskId: "second-task",
      childThreadId: "second-thread",
      childRunId: "second-turn",
    };
    await tick(d, [observation(a, accepted(a)), observation(b, accepted(b))], now + 1000);
    const ta = status(a, "completed", {
      latestTerminalRunId: staleLatest ? "obsolete-turn" : accepted(a).childRunId,
      latestTerminalStatus: "completed",
      latestTerminalSummary: result(a).response.summary,
    });
    const tb = status(b, "cancelled");
    await tick(d, [ta, tb], now + 1001);
    const terminalObservationIds = readObservations(d)
      .filter((x) => x.observation.type === "task_status")
      .map((x) => x.id);
    let resolution, error;
    try {
      resolution = k.resolveDispatchEvidence(d, {
        intentId: a.intentId,
        userConfirmed: true,
        reason: "Choose only after all current original tasks have stopped.",
        terminalObservationIds,
        selectedTaskId: accepted(a).taskId,
        selectedChildThreadId: accepted(a).childThreadId,
      });
    } catch (e) {
      error = { code: e.code, message: e.message };
    }
    const next = await tick(d, [], now + 2000);
    let calls = 0;
    if (next.type === "dispatch") {
      const rec = inspectDispatchRecords(d).find((r) => r.intent.runId === next.runId);
      await dispatchRuntimeInvocation(
        d,
        {
          missionId: rec.intent.missionId,
          runId: next.runId,
          feature: {
            ...rec.intent.feature,
            clientRequestId: next.intentId,
            invocationId: next.invocationId,
          },
          slotConfig: rec.intent.target,
        },
        async () => {
          calls++;
          return { accepted: true, taskId: "new-task", childThreadId: "new-thread" };
        },
        () => {},
      );
    }
    save("manual-latest-" + staleLatest, {
      d,
      a,
      b,
      ta,
      tb,
      resolution,
      error,
      next,
      calls,
      ledger: readController(d, k.loadState(d).missionId),
      state: k.loadState(d),
    });
    if (staleLatest) {
      assert.equal(
        resolution,
        undefined,
        "An obsolete terminal turn cannot prove the current original turn stopped",
      );
      assert.equal(error?.code, "DISPATCH_RESOLUTION_UNSETTLED");
      assert.notEqual(next.type, "dispatch");
    } else {
      assert.ok(resolution);
      assert.equal(next.type, "dispatch");
    }
  });

test("R10 a bound control and duplicate approval notification remain available behind a late fence", async () => {
  const d = init("bound-control"),
    [a] = await rejectedAttempts(d, 1);
  const b = await tick(d, [], now + 1000);
  await tick(d, [observation(b, accepted(b))], now + 1001);
  await tick(d, [observation(a, accepted(a))], now + 1002);
  applyAutopilotCommand(d, "pause");
  let resumes = 0,
    dispatches = 0,
    notifications = 0;
  const adapter = {
    runFeature: async () => {
      dispatches++;
      return accepted(b);
    },
    resumeWorker: async () => {
      resumes++;
      return { ...accepted(b), resumed: true };
    },
  };
  await k.startMissionRun(d, {}, adapter);
  const hud = await createHandlerHud({
    missionDir: d,
    runtimeAdapter: adapter,
    onCommand: async () => {
      notifications++;
    },
  });
  let approval;
  try {
    approval = await hud.post("approve");
  } finally {
    await hud.close();
  }
  save("bound-controls", {
    d,
    resumes,
    dispatches,
    notifications,
    approval,
    state: k.loadState(d),
  });
  assert.equal(resumes, 1);
  assert.equal(dispatches, 0);
  assert.equal(notifications, 1);
});

test("R10 compressed progress preserves approval question and changed pending child decisions", async () => {
  const d = init("progress-decisions"),
    a = await first(d);
  await tick(d, [observation(a, accepted(a))]);
  const p = await tick(
    d,
    [status(a, "running", { pendingApproval: { id: "approval-1" } })],
    now + 1000,
  );
  const q = await tick(d, [status(a, "running", { hasPendingQuestion: true })], now + 1001);
  const child = status(a, "running", {
    hasPendingChildRuns: true,
    workState: "waiting_for_children",
    pendingChildRuns: [{ taskId: "new-pending-task", childRunId: "pending-turn" }],
  });
  const c = await tick(d, [child], now + 1002);
  const rows = readObservations(d),
    end = await tick(d, [result(a)], now + 1003);
  save("progress-decisions", { d, p, q, c, end, rows });
  assert.equal(p.reason, "CHILD_APPROVAL_REQUIRED");
  assert.equal(q.reason, "CHILD_QUESTION");
  assert.equal(
    rows.some((r) => r.progressCount === 2),
    true,
  );
  assert.equal(
    rows.some(
      (r) =>
        r.observation.response.pendingChildRuns?.[0]?.taskId === "new-pending-task" &&
        r.progressCount === undefined,
    ),
    true,
  );
  assert.equal(end.kind, "integrate");
});

test("R10 late success at exhausted budget resumes via public bonus attempts", async () => {
  const d = init("bonus", 1),
    [a] = await rejectedAttempts(d, 1);
  await tick(d, [observation(a, accepted(a))], now + 1000);
  const wait = await tick(d, [result(a)], now + 1001);
  assert.equal(wait.reason, "MAX_ATTEMPTS_EXCEEDED");
  k.updateMissionFeatures(d, { bonusAttempts: { f1: 1 } });
  const next = await tick(d, [], now + 2000);
  assert.equal(next.type, "dispatch");
  assert.equal(next.attempt, 2);
  await finish(d, next, now + 3000);
  save("bonus-resume", { d, wait, next, state: k.loadState(d) });
});
