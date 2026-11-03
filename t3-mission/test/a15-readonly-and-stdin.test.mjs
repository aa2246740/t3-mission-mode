import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../bridge/cli.mjs";
import { buildDelegateTask } from "../kernel/mission-brief.mjs";
import * as kernel from "../kernel/index.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(root, "t3-mission/bridge/cli.mjs");

test("CLI supports --json - and --stdin payloads without temporary files", async (t) => {
  const parsedDash = parseCliArgs(
    ["MissionTick", "--mission-dir", "/ext/.mission", "--json", "-"],
    {
      stdinText: JSON.stringify({ observations: [{ type: "timer", requestId: "r1" }] }),
    },
  );
  assert.equal(parsedDash.command, "MissionTick");
  assert.equal(parsedDash.missionDir, "/ext/.mission");
  assert.deepEqual(parsedDash.payload.observations, [{ type: "timer", requestId: "r1" }]);

  const parsedStdin = parseCliArgs(["MissionTick", "--mission-dir", "/ext/.mission", "--stdin"], {
    stdinText: JSON.stringify({ observations: [] }),
  });
  assert.deepEqual(parsedStdin.payload.observations, []);

  const dir = fs.mkdtempSync(path.join(root, ".stdin-cli-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  kernel.proposeMission(dir, {
    missionId: "stdin-mission",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "owner-1",
    timerEveryMs: 60000,
    integration: { branch: "mission/stdin", auto: true },
    milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
    features: [{ id: "f1", milestoneId: "m1", title: "F1" }],
  });
  kernel.approveMissionPlan(dir);

  const stdout = execFileSync(
    process.execPath,
    [cliPath, "MissionTick", "--mission-dir", dir, "--json", "-"],
    {
      input: JSON.stringify({ observations: [], timerMaxWakeups: 2 }),
      encoding: "utf8",
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.action.type, "ensure_timer");
  assert.equal(result.action.schedule.type, "once");
});

test("validator and worker briefs enforce no-/tmp writes and macOS sandbox-exec read-only profile", () => {
  const state = {
    missionId: "m-ro",
    repoPath: "/Volumes/Workspace/repo",
    milestones: [{ id: "m1", ordinal: 1, mergeSha: "a".repeat(40) }],
    assertions: [{ id: "VAL-1", milestoneId: "m1", description: "Check output" }],
  };
  const intent = {
    runId: "run-1",
    attempt: 1,
    worker: { workerNumber: 1 },
    clientRequestId: "req-1",
    target: { providerInstanceId: "pi", model: "air-cpa/glm-5.3", options: { thinking: "low" } },
  };

  const validatorTask = buildDelegateTask(
    state,
    {
      id: "scrutiny-validator-m1",
      milestoneId: "m1",
      kind: "scrutiny",
      title: "Scrutiny M1",
      description: "Verify M1",
    },
    intent,
  ).task;

  assert.ok(
    validatorTask.includes(
      "Never use shell output redirection (>, >>, tee) or create files in /tmp, /private/tmp, or $TMPDIR",
    ),
  );
  assert.ok(
    validatorTask.includes(
      `/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper"))'`,
    ),
  );

  const workerTask = buildDelegateTask(
    state,
    {
      id: "f1",
      milestoneId: "m1",
      title: "Implement F1",
      description: "Write F1",
    },
    intent,
  ).task;

  assert.ok(
    workerTask.includes(
      "Never write to the main checkout, /tmp, /private/tmp, or any other directory.",
    ),
  );
});

test("macOS kernel sandbox-exec profile blocks /tmp writes while allowing read-only node execution", (t) => {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    t.skip("macOS sandbox-exec not present");
    return;
  }
  const profile =
    '(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper"))';
  const out = execFileSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      profile,
      process.execPath,
      "-e",
      `
      import fs from "node:fs";
      let blocked = false;
      try {
        fs.writeFileSync("/tmp/t3-mission-sandbox-probe-should-fail", "x");
      } catch (err) {
        blocked = err.code === "EPERM" || err.code === "EACCES";
      }
      process.stdout.write(JSON.stringify({ blocked }));
    `,
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(out), { blocked: true });
});

test("real T3 t3_thread_send resume receipt with :thread-send: taskId and ordinal:2 childRunId confirms and polls cleanly", async (t) => {
  const dir = fs.mkdtempSync(path.join(root, ".thread-send-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = {
    providerInstanceId: "pi",
    model: "air-cpa/glm-5.3-flash",
    options: { thinking: "low" },
  };
  kernel.proposeMission(dir, {
    missionId: "thread-send-e2e",
    repoPath: dir,
    autopilot: true,
    ownerThreadId: "owner-thread-send",
    timerEveryMs: 60000,
    integration: { branch: "mission/thread-send", auto: true },
    milestones: [{ id: "M1", title: "M1", ordinal: 1 }],
    features: [{ id: "F1", milestoneId: "M1", title: "Implement F1" }],
    assertions: [{ id: "VAL-M1-1", milestoneId: "M1", description: "Verify M1" }],
    modelSettings: { worker: target, validator: target },
  });
  kernel.approveMissionPlan(dir);

  const t1 = (await kernel.missionTick(dir, { observations: [] })).action;
  assert.equal(t1.type, "ensure_timer");
  const d1 = (
    await kernel.missionTick(dir, {
      observations: [
        { type: "timer", requestId: t1.requestId, response: { taskId: "timer-1", enabled: true } },
      ],
    })
  ).action;
  assert.equal(d1.type, "dispatch");

  const delegateTaskId = "node:delegated-task:command%3Amcp%3A1%3Adelegate-task%3At3m%253A1";
  const childThreadId = "thread:delegated-task:command%3Amcp%3A1%3Adelegate-task%3At3m%253A1";
  const runOrdinal1 = "run:thread:thread%3Adelegated-task%3A1:ordinal:1";
  const runOrdinal2 = "run:thread:thread%3Adelegated-task%3A1:ordinal:2";
  const threadSendTaskId = "node:delegated-task:command%3Amcp%3A1%3Athread-send%3A2";

  const p1 = (
    await kernel.missionTick(dir, {
      observations: [
        {
          type: "dispatch",
          featureId: "F1",
          runId: d1.runId,
          intentId: d1.intentId,
          invocationId: d1.invocationId,
          response: {
            accepted: true,
            taskId: delegateTaskId,
            childThreadId,
            childRunId: runOrdinal1,
            ...target,
          },
        },
      ],
    })
  ).action;
  assert.equal(p1.type, "poll");
  assert.equal(p1.taskId, delegateTaskId);

  // First completion has unparseable JSON fence (e.g. invalid escape), triggering resume_worker
  const resumeAction = (
    await kernel.missionTick(dir, {
      observations: [
        {
          type: "task_status",
          featureId: "F1",
          runId: d1.runId,
          intentId: d1.intentId,
          taskId: delegateTaskId,
          response: {
            taskId: delegateTaskId,
            childThreadId,
            childRunId: runOrdinal1,
            status: "completed",
            workState: "result_available",
            hasPendingChildRuns: false,
            latestTerminalRunId: runOrdinal1,
            latestTerminalStatus: "completed",
            ...target,
            summary: "Done\n```mission-result\n{broken json}\n```",
          },
        },
      ],
    })
  ).action;
  assert.equal(resumeAction.type, "resume_worker");
  assert.equal(resumeAction.threadId, childThreadId);

  // Real T3 t3_thread_send receipt returns :thread-send: taskId and ordinal:2 runId on the same threadId
  const pollResumed = (
    await kernel.missionTick(dir, {
      observations: [
        {
          type: "resume",
          featureId: "F1",
          runId: d1.runId,
          controlId: resumeAction.controlId,
          response: {
            threadId: childThreadId,
            messageId: "message:mcp:1:thread-send:2",
            runId: runOrdinal2,
            taskId: threadSendTaskId,
            status: "starting",
            delivery: "started",
          },
        },
      ],
    })
  ).action;
  assert.equal(pollResumed.type, "poll");
  assert.equal(pollResumed.taskId, threadSendTaskId);

  // Terminal task_status on the :thread-send: taskId is accepted and advances to integrate
  const validEnvelope = {
    version: 1,
    featureId: "F1",
    runId: d1.runId,
    status: "success",
    summary:
      "Implemented F1 cleanly with full tests and verified working tree is clean on feature branch.",
    commit: "eddf23a",
    branch: "t3/todo-mjs-core-commands",
    tests: [{ command: "node test-m1.mjs", status: "passed" }],
    discoveredIssues: [],
    whatWasLeftUndone: [],
  };
  const integrateAction = (
    await kernel.missionTick(dir, {
      observations: [
        {
          type: "task_status",
          featureId: "F1",
          runId: d1.runId,
          taskId: threadSendTaskId,
          response: {
            taskId: threadSendTaskId,
            childThreadId,
            childRunId: runOrdinal2,
            status: "completed",
            workState: "result_available",
            hasPendingChildRuns: false,
            latestTerminalRunId: runOrdinal2,
            latestTerminalStatus: "completed",
            ...target,
            summary:
              "Fixed fence\n```mission-result\n" + JSON.stringify(validEnvelope, null, 2) + "\n```",
          },
        },
      ],
    })
  ).action;
  assert.equal(integrateAction.type, "orchestrator_decision");
  assert.equal(integrateAction.kind, "integrate");
});
