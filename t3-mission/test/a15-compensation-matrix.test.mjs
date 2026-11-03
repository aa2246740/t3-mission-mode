import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const actor = fileURLToPath(new URL("./fixtures/a15-child.mjs", import.meta.url));
const outcomes = ["confirmed", "pending", "unknown", "rejected", "throws"];
const sequences = [
  "no-resume",
  "resume",
  "late-pause-receipt",
  "lost-resume-receipt",
  "new-pause-epoch",
  "terminal-first",
  "interleaved-gates",
];
const accepted = {
  accepted: true,
  taskId: "a15-task",
  childThreadId: "a15-child",
  childRunId: "a15-turn",
};

async function exercise(t, source, mode, outcome, sequence) {
  const raw = [],
    actions = [];
  let dir,
    explicitResumes = 0,
    resumeActions = 0,
    newEpochControls = 0;
  const invoke = (op, input = {}) => {
    const r = spawnSync(process.execPath, [actor, op, dir ?? "", JSON.stringify(input)], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 16000000,
    });
    raw.push({ op, input, stdout: r.stdout, stderr: r.stderr, exit: r.status });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const snapshot = () => invoke("snapshot");
  const command = (command) => {
    if (command === "resume") explicitResumes++;
    return invoke("command", { command });
  };
  let originalIntent;
  const tick = (observations = []) => {
    const a = invoke("tick", { observations });
    actions.push(a);
    assert.notEqual(a.type, "dispatch", "No new dispatch after the original acceptance");
    if (a.type === "resume_worker") {
      assert.ok(explicitResumes > 0);
      assert.equal(a.threadId, "a15-child");
      resumeActions++;
      assert.equal(resumeActions, 1, "Only one same-child Resume in this sequence");
    }
    if (a.type === "interrupt_worker") {
      newEpochControls++;
      assert.equal(sequence, "new-pause-epoch");
      assert.equal(mode, "interrupt");
      assert.equal(newEpochControls, 1);
      assert.equal(a.threadId, "a15-child");
    }
    if (a.type === "ensure_timer" || a.type === "disable_timer") {
      assert.equal(a.scheduledTaskId, "a15-timer");
      assert.equal(a.scheduleTask, undefined);
    }
    const s = snapshot();
    assert.equal(s.records.length, 1);
    assert.equal(s.records[0].invocations.length, 1);
    assert.deepEqual(s.records[0].intent, originalIntent);
    assert.equal(s.state.sessions.length, 1);
    if (resumeActions === 0 || s.ledger.runs[originalIntent.runId].pause.phase !== "resumed") {
      assert.equal(s.ledger.runs[originalIntent.runId].consumed, undefined);
      assert.equal(s.ledger.runs[originalIntent.runId].integration, undefined);
      assert.equal(s.ledger.runs[originalIntent.runId].result, undefined);
    }
    return a;
  };
  const timerReceipt = (a) => ({
    type: a.type === "disable_timer" ? "timer_disabled" : "timer",
    requestId: a.requestId,
    response: { scheduledTaskId: "a15-timer", enabled: a.type === "ensure_timer" },
  });
  const settleTimer = (a) => {
    for (let i = 0; ["ensure_timer", "disable_timer"].includes(a.type); i++) {
      assert.ok(i < 3);
      a = tick([timerReceipt(a)]);
    }
    return a;
  };
  const seed = invoke("seed", { source, mode, outcome });
  dir = seed.dir;
  const timer = invoke("tick");
  assert.equal(timer.type, "ensure_timer");
  if (source === "runner")
    invoke("runner", {
      outcome,
      resumeDuringCallback: sequence === "resume-before-callback-return",
    });
  if (sequence === "resume-before-callback-return") explicitResumes = 1;
  t.after(() => {
    if (process.env.R9_EVIDENCE_DIR)
      fs.writeFileSync(
        path.join(process.env.R9_EVIDENCE_DIR, `a15-${source}-${mode}-${outcome}-${sequence}.json`),
        JSON.stringify({ actions, raw, explicitResumes, resumeActions, newEpochControls }, null, 2),
      );
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let first;
  const timerObservation = {
    type: "timer",
    requestId: timer.requestId,
    response: { scheduledTaskId: "a15-timer", enabled: true },
  };
  if (source !== "runner") {
    const dispatch = invoke("tick", { observations: [timerObservation] });
    assert.equal(dispatch.type, "dispatch");
    if (source === "recovery") assert.equal(invoke("tick").type, "recover_dispatch");
    command("pause");
    const obs = {
      type: source === "recovery" ? "children" : "dispatch",
      featureId: dispatch.featureId,
      runId: dispatch.runId,
      intentId: dispatch.intentId,
      ...(source === "recovery" ? { cursor: null } : { invocationId: dispatch.invocationId }),
      response:
        source === "recovery"
          ? {
              threads: [
                { ...accepted, parentThreadId: "owner", clientRequestId: dispatch.intentId },
              ],
            }
          : accepted,
    };
    const control = invoke("tick", { observations: [obs] });
    assert.equal(control.type, "interrupt_worker");
    assert.equal(control.threadId, "a15-child");
    const response = invoke("callback", { outcome });
    first = invoke("tick", {
      observations:
        outcome === "throws"
          ? []
          : [
              {
                type: "interrupt",
                featureId: control.featureId,
                runId: control.runId,
                controlId: control.controlId,
                response,
              },
            ],
    });
  }
  const initial = snapshot();
  originalIntent = initial.records[0].intent;
  if (source === "runner") first = tick([timerObservation]);
  const callback = JSON.parse(fs.readFileSync(path.join(dir, "compensation-callback.json")));
  assert.deepEqual(callback, { calls: 1, threadId: "a15-child" });
  if (sequence === "resume-before-callback-return" && outcome === "confirmed")
    assert.equal(first.type, "resume_worker");
  else {
    assert.equal(first.type, "wait_user");
    assert.equal(
      first.reason,
      outcome === "confirmed" ? "USER_PAUSED" : "WORKER_CONTROL_OUTCOME_UNKNOWN",
    );
  }
  const pauseReceipt = () => {
    const pause = snapshot().ledger.runs[originalIntent.runId].pause;
    return {
      type: "interrupt",
      featureId: "f1",
      runId: originalIntent.runId,
      controlId: `${originalIntent.runId}:${pause.epoch}:interrupt`,
      response: { paused: true, threadId: "a15-child" },
    };
  };
  const terminal = (turn) => ({
    type: "task_status",
    featureId: "f1",
    runId: originalIntent.runId,
    taskId: "a15-task",
    response: {
      ...accepted,
      childRunId: turn,
      latestTerminalRunId: turn,
      latestTerminalStatus: "completed",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      latestTerminalSummary:
        "```mission-result\n" +
        JSON.stringify({
          version: 1,
          featureId: "f1",
          runId: originalIntent.runId,
          status: "success",
          summary:
            "The original feature is complete with literal deterministic local checks and retained exact source identity for integration.",
          commit: "abcdef1234567",
          branch: "feature/a15",
          tests: [{ command: "literal-a15-check", status: "passed" }],
          discoveredIssues: [],
          whatWasLeftUndone: [],
        }) +
        "\n```",
    },
  });
  if (sequence === "no-resume" || (sequence === "resume" && outcome !== "confirmed")) {
    if (sequence === "resume") command("resume");
    const waits = [tick(), tick(), tick(), tick()];
    if (outcome !== "confirmed") {
      assert.equal(waits.filter((a) => a.type === "disable_timer").length, 1);
      assert.equal(waits.at(-1).reason, "TIMER_OUTCOME_UNKNOWN");
      const stop = waits.find((a) => a.type === "disable_timer");
      assert.equal(tick([timerReceipt(stop)]).reason, "STALLED_DECISION");
      assert.equal(snapshot().ledger.timer.phase, "disabled");
    } else assert.ok(waits.every((a) => a.reason === "USER_PAUSED"));
    assert.equal(resumeActions, 0);
    return;
  }
  if (sequence !== "resume-before-callback-return") command("resume");
  if (sequence === "interleaved-gates") {
    command("pause");
    const paused = tick();
    assert.equal(paused.type, "wait_user");
    assert.equal(snapshot().state.status, "paused");
    command("resume");
  }
  if (sequence === "terminal-first") {
    const before = tick([terminal("a15-turn")]);
    if (outcome === "confirmed") assert.equal(before.type, "resume_worker");
    else assert.equal(before.reason, "WORKER_CONTROL_OUTCOME_UNKNOWN");
  }
  let resume = actions.find((a) => a.type === "resume_worker");
  if (!resume)
    resume = settleTimer(
      tick(sequence === "late-pause-receipt" || outcome !== "confirmed" ? [pauseReceipt()] : []),
    );
  assert.equal(resume.type, "resume_worker");
  assert.equal(resume.threadId, "a15-child");
  if (sequence === "lost-resume-receipt") {
    assert.equal(tick().reason, "WORKER_CONTROL_OUTCOME_UNKNOWN");
    assert.equal(tick().reason, "WORKER_CONTROL_OUTCOME_UNKNOWN");
    const stop = tick();
    assert.equal(stop.type, "disable_timer");
    assert.equal(tick().reason, "TIMER_OUTCOME_UNKNOWN");
    assert.equal(tick([timerReceipt(stop)]).reason, "STALLED_DECISION");
    assert.equal(snapshot().ledger.timer.phase, "disabled");
  } else {
    const fenced = tick(sequence === "terminal-first" ? [terminal("a15-new-turn")] : []);
    assert.equal(fenced.type, "wait_user");
  }
  const afterResume = settleTimer(
    tick([
      {
        type: "resume",
        featureId: "f1",
        runId: originalIntent.runId,
        controlId: resume.controlId,
        response: { resumed: true, threadId: "a15-child" },
      },
    ]),
  );
  assert.equal(afterResume.type, "poll");
  assert.equal(snapshot().ledger.timer.phase, "confirmed");
  assert.equal(snapshot().ledger.runs[originalIntent.runId].pause.phase, "resumed");
  if (sequence === "new-pause-epoch") {
    command("pause");
    const a = tick();
    assert.equal(snapshot().state.pauseEpoch, 2);
    assert.equal(a.type, mode === "interrupt" ? "interrupt_worker" : "wait_user");
    if (mode === "let_finish") assert.equal(a.reason, "USER_PAUSED");
  } else {
    const consume = settleTimer(tick([terminal("a15-new-turn")]));
    assert.equal(consume.type, "orchestrator_decision");
    assert.equal(consume.kind, "integrate");
  }
  assert.equal(resumeActions, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "compensation-callback.json"))),
    callback,
  );
}

for (const mode of ["let_finish", "interrupt"])
  for (const outcome of outcomes)
    for (const sequence of sequences)
      test(`A15 compensation matrix runner ${mode} ${outcome} ${sequence}`, (t) =>
        exercise(t, "runner", mode, outcome, sequence));
for (const source of ["owner", "recovery"])
  for (const mode of ["let_finish", "interrupt"])
    for (const outcome of outcomes)
      test(`A15 compensation matrix ${source} ${mode} ${outcome} late-pause-receipt`, (t) =>
        exercise(t, source, mode, outcome, "late-pause-receipt"));

for (const mode of ["let_finish", "interrupt"])
  for (const outcome of outcomes)
    test(`A15 compensation matrix runner ${mode} ${outcome} resume-before-callback-return`, (t) =>
      exercise(t, "runner", mode, outcome, "resume-before-callback-return"));
