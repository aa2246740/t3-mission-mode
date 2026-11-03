import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { classifyControlReceipt } from "../kernel/schema.mjs";
import { prepareDispatch, dispatchWithIntent } from "../kernel/dispatch-journal.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import { callT3McpTool, resumeWorker } from "../bridge/t3-adapter.mjs";
import { runCli } from "../bridge/cli.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";

const child = {
  taskId: "original-task",
  childThreadId: "original-thread",
  childRunId: "original-child",
};
const accepted = { accepted: true, ...child, runtimeTransport: "t3-delegate-task" };
const target = {
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  options: { reasoningEffort: "max", serviceTier: "priority" },
};
const containers = ["root", "response", "delegation", "structuredContent", "content"];
const wrap = (container, inner) =>
  container === "root"
    ? inner
    : container === "content"
      ? { content: [{ type: "text", text: JSON.stringify(inner) }] }
      : { [container]: inner };
const affirmative = (op) =>
  op === "dispatch" ? { accepted: true } : op === "resume" ? { sent: true } : { interrupted: true };

// The expected column is literal case data. It never calls a production predicate.
function shapes(op, bound) {
  const rows = [
    { name: "undefined", raw: undefined, expected: "unknown" },
    { name: "null", raw: null, expected: "unknown" },
    { name: "empty", raw: {}, expected: "unknown" },
    { name: "status-only", raw: { status: "running" }, expected: "unknown" },
  ];
  const negatives = [
    "ok",
    "accepted",
    "started",
    "canStart",
    ...(op === "resume"
      ? ["resumed", "sent", "canResume"]
      : op === "dispatch"
        ? []
        : ["paused", "interrupted", "canPause"]),
  ];
  for (const container of containers) {
    for (const key of negatives)
      rows.push({
        name: `${container}/false-${key}`,
        raw: wrap(container, { ...child, ...affirmative(op), [key]: false }),
        expected: "rejected",
      });
    for (const key of ["resumed", "sent", "canResume", "paused", "interrupted", "canPause"].filter(
      (key) => !negatives.includes(key),
    ))
      rows.push({
        name: `${container}/unrelated-false-${key}`,
        raw: wrap(container, { ...child, ...affirmative(op), [key]: false }),
        expected: "confirmed",
      });
    // Bare refusals that state the dispatch never started; a dispatch must stay retryable.
    for (const [label, refusal] of [
      ["blocked", { blocked: true }],
      ["status-blocked", { status: "blocked_by_conflicts" }],
      ["action-blocked", { action: "blocked_by_conflicts" }],
      ["dispatched-false", { dispatched: false }],
      ["outcome-rejected", { dispatchOutcome: "rejected" }],
    ])
      rows.push({
        name: `${container}/${label}`,
        raw: wrap(container, refusal),
        expected: "rejected",
        retryable: op === "dispatch",
      });
    rows.push({
      name: `${container}/isError-only`,
      raw: wrap(container, { isError: true }),
      expected: "rejected",
      noRetry: op === "dispatch",
    });
    rows.push({
      name: `${container}/isError-over-positive`,
      raw: wrap(container, { ...child, ...affirmative(op), isError: true }),
      expected: "rejected",
      noRetry: op === "dispatch",
    });
    rows.push({
      name: `${container}/isError`,
      raw: wrap(container, {
        isError: true,
        accepted: false,
        message: "401 Unauthorized: API key rejected",
      }),
      expected: "rejected",
      nonacceptance: true,
    });
    for (const key of ["pending", "dispatchPending"]) {
      rows.push({
        name: `${container}/${key}-only`,
        raw: wrap(container, { [key]: true }),
        expected: "pending",
        retryablePending: true,
      });
      rows.push({
        name: `${container}/${key}-with-positive`,
        raw: wrap(container, { ...child, ...affirmative(op), [key]: true }),
        expected: "pending",
      });
      rows.push({
        name: `${container}/refusal-over-${key}`,
        raw: wrap(container, { ...child, ...affirmative(op), [key]: true, accepted: false }),
        expected: "rejected",
      });
    }
    for (const key of ["threadId", "taskId", "childRunId"]) {
      const ids = { ...child };
      if (key === "threadId") delete ids.childThreadId;
      rows.push({
        name: `${container}/foreign-${key}`,
        raw: wrap(container, { ...ids, ...affirmative(op), [key]: "foreign-" + key }),
        expected: bound ? "identity_conflict" : "confirmed",
      });
      rows.push({
        name: `${container}/foreign-${key}-pending`,
        raw: wrap(container, {
          ...ids,
          ...affirmative(op),
          [key]: "foreign-" + key,
          pending: true,
        }),
        expected: bound ? "identity_conflict" : "pending",
      });
      rows.push({
        name: `${container}/refusal-over-foreign-${key}`,
        raw: wrap(container, {
          ...ids,
          ...affirmative(op),
          [key]: "foreign-" + key,
          pending: true,
          accepted: false,
        }),
        expected: "rejected",
      });
    }
    rows.push({
      name: `${container}/correct-identity`,
      raw: wrap(container, { ...child, ...affirmative(op) }),
      expected: "confirmed",
    });
    rows.push({
      name: `${container}/no-identity-affirmative`,
      raw: wrap(container, affirmative(op)),
      expected: op === "dispatch" ? "unknown" : "confirmed",
    });
    rows.push({
      name: `${container}/ok-only`,
      raw: wrap(container, { ok: true }),
      expected: ["pause", "interrupt"].includes(op) ? "confirmed" : "unknown",
    });
    rows.push({
      name: `${container}/alias-conflict`,
      raw: wrap(container, { ...child, threadId: "foreign-thread", ...affirmative(op) }),
      expected: "identity_conflict",
    });
    if (container !== "root")
      rows.push({
        name: `${container}/outer-inner-conflict`,
        raw: {
          ...child,
          ...wrap(container, { ...child, taskId: "foreign-task", ...affirmative(op) }),
        },
        expected: "identity_conflict",
      });
  }
  for (const [name, envelope] of Object.entries({
    "invalid-text": { content: [{ type: "text", text: "{" }] },
    "multiple-text": {
      content: [
        { type: "text", text: "{}" },
        { type: "text", text: "{}" },
      ],
    },
    "scalar-text": { content: [{ type: "text", text: "true" }] },
    "scalar-structured": { structuredContent: true },
  }))
    rows.push({
      name: "malformed/" + name,
      raw: { ...child, ...affirmative(op), ...envelope },
      expected: "unknown",
    });
  rows.push({
    name: "R3-nested-refusal",
    raw: { ok: true, response: { accepted: false, code: "PROVIDER_BUSY" } },
    expected: "rejected",
    retryable: op === "dispatch",
  });
  rows.push({
    name: "R3-ok-pending",
    raw: { ok: true, dispatchPending: true },
    expected: "pending",
    retryablePending: true,
  });
  for (const mode of ["content", "structuredContent"])
    rows.push({
      name: "R3-outer-refusal-" + mode,
      raw: { accepted: false, ...wrap(mode, { accepted: true, ...child }) },
      expected: "rejected",
    });
  for (const mode of ["response", "delegation"])
    rows.push({
      name: "R4-plain-thread-conflict-" + mode,
      raw: {
        threadId: child.childThreadId,
        [mode]: { threadId: "foreign-thread", interrupted: true },
      },
      expected: "identity_conflict",
    });
  rows.push({
    name: "R4-plain-auth-without-isError",
    raw: { accepted: false, message: "401 Unauthorized: API key rejected" },
    expected: "rejected",
    nonacceptance: true,
  });
  if (["pause", "interrupt"].includes(op)) {
    rows.push({
      name: "R3-ok-interrupted-false",
      raw: { ok: true, interrupted: false },
      expected: "rejected",
    });
    rows.push({
      name: "R4-foreign-HUD-thread",
      raw: { threadId: "foreign-thread", interrupted: true },
      expected: "identity_conflict",
    });
  }
  return rows;
}
const entries = [
  ...["dispatch", "pause", "interrupt", "resume"].map((op) => ({
    name: "schema-" + op,
    kind: "schema",
    op,
    bound: op !== "dispatch",
  })),
  ...["dispatch", "pause", "resume"].map((op) => ({
    name: "bridge-" + op,
    kind: "bridge",
    op,
    bound: op !== "dispatch",
  })),
  { name: "bridge-resume-worker", kind: "adapter", op: "resume", bound: true },
  ...["dispatch", "pause", "resume"].map((op) => ({
    name: "cli-" + op,
    kind: "cli",
    op,
    bound: op !== "dispatch",
  })),
  ...["custom", "default"].flatMap((adapter) => [
    {
      name: "hud-" + adapter + "-approve",
      kind: "hud",
      op: "dispatch",
      action: "approve",
      adapter,
      bound: false,
    },
    {
      name: "hud-" + adapter + "-pause",
      kind: "hud",
      op: "pause",
      action: "pause",
      adapter,
      bound: true,
    },
    {
      name: "hud-" + adapter + "-resume",
      kind: "hud",
      op: "resume",
      action: "resume",
      adapter,
      bound: true,
    },
  ]),
  {
    name: "hud-custom-approve-start-hook",
    kind: "hud",
    op: "dispatch",
    action: "approve",
    adapter: "custom",
    hook: true,
    bound: false,
  },
  {
    name: "hud-custom-resume-start-hook",
    kind: "hud",
    op: "resume",
    action: "resume",
    adapter: "custom",
    hook: true,
    bound: true,
  },
  { name: "runner-dispatch", kind: "runner", op: "dispatch", bound: false },
  { name: "runner-resume", kind: "runner", op: "resume", bound: true },
  { name: "runner-compensation-pause", kind: "compensation", op: "pause", bound: true },
  ...["dispatch", "interrupt", "resume"].map((op) => ({
    name: "controller-" + op,
    kind: "controller",
    op,
    bound: op !== "dispatch",
  })),
  ...["dispatch", "resume"].map((op) => ({
    name: "journal-" + op,
    kind: "journal",
    op,
    bound: false,
  })),
];
const tick = async (dir, observations = []) => (await k.missionTick(dir, { observations })).action;
const observation = (type, action, response) => ({
  type,
  runId: action.runId,
  featureId: action.featureId,
  intentId: action.intentId,
  taskId: child.taskId,
  controlId: action.controlId,
  response,
});
function disk(dir) {
  const base = k.getMissionPaths(dir).baseDir;
  const state = JSON.parse(fs.readFileSync(path.join(base, "state.json"))),
    features = JSON.parse(fs.readFileSync(path.join(base, "features.json")));
  const journals = fs
    .readdirSync(base)
    .filter((name) => /^dispatch-.*\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(base, name))));
  const effectsDir = path.join(base, ".txn/effects");
  const effects = fs.existsSync(effectsDir)
    ? fs
        .readdirSync(effectsDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(effectsDir, name))))
    : [];
  return {
    state,
    features,
    journals,
    effects,
    controller: fs.existsSync(path.join(base, "autopilot", "controller.json"))
      ? JSON.parse(fs.readFileSync(path.join(base, "autopilot", "controller.json")))
      : {},
  };
}
async function seed(dir, entry) {
  fs.mkdirSync(dir);
  k.proposeMission(dir, {
    title: entry.name,
    repoPath: dir,
    autopilot: entry.kind === "controller",
    ownerThreadId: "matrix-owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
    modelSettings: { worker: target, validator: target },
    integration: { branch: "mission/a5", auto: true },
  });
  if (!(entry.kind === "hud" && entry.action === "approve")) k.approveMissionPlan(dir);
  if (entry.kind === "controller") {
    const timer = await tick(dir);
    const dispatch = await tick(dir, [
      {
        type: "timer",
        requestId: timer.requestId,
        response: { taskId: "matrix-timer", enabled: true },
      },
    ]);
    if (entry.op === "dispatch") return dispatch;
    await tick(dir, [observation("dispatch", dispatch, accepted)]);
    applyAutopilotCommand(dir, "pause");
    const interrupt = await tick(dir);
    if (entry.op === "interrupt") return interrupt;
    await tick(dir, [observation("interrupt", interrupt, { ...child, interrupted: true })]);
    applyAutopilotCommand(dir, "resume");
    return tick(dir);
  }
  if (entry.bound && entry.kind !== "compensation") {
    await k.startMissionRun(dir, {}, { runFeature: async () => accepted });
    if (entry.op === "resume") {
      const state = k.loadState(dir);
      state.status = "paused";
      state.pausedAt = "matrix-pause";
      state.pauseEpoch = 1;
      for (const row of [state.activeWorker, ...state.sessions]) row.status = "paused";
      k.saveState(dir, state);
    }
  } else if (["cli", "journal"].includes(entry.kind)) {
    await k.startMissionRun(dir);
    if (entry.op === "resume") {
      const state = k.loadState(dir);
      state.status = "paused";
      state.activeWorker.status = "paused";
      state.sessions[0].status = "paused";
      for (const row of [state.activeWorker, state.sessions[0]]) {
        delete row.dispatchPending;
        row.runtimeTransport = "legacy-unbound";
      }
      k.saveState(dir, state);
    }
  }
  return null;
}

for (const entry of entries)
  test("A5 exhaustive control entry " + entry.name, async (t) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "a5-matrix-"));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const rows = [];
    const output =
      process.env.R9_EVIDENCE_DIR &&
      path.join(process.env.R9_EVIDENCE_DIR, "control-matrix-" + entry.name + ".json");
    t.after(() => {
      if (output)
        fs.writeFileSync(
          output,
          JSON.stringify({ entry, cases: rows.length, rows }, null, 2) + "\n",
        );
    });
    if (["schema", "bridge", "adapter"].includes(entry.kind)) {
      for (const shape of shapes(entry.op, entry.bound))
        await t.test(shape.name, async () => {
          const verdict = classifyControlReceipt(shape.raw, entry.op, entry.bound ? child : {});
          const row = {
            name: shape.name,
            rawDefined: shape.raw !== undefined,
            raw: shape.raw,
            expected: shape.expected,
            actual: verdict,
            calls: 0,
          };
          rows.push(row);
          try {
            assert.equal(verdict.classification, shape.expected);
            assert.equal(verdict.raw, shape.raw);
            const invoke = async () => {
              row.calls++;
              return shape.raw;
            };
            if (entry.kind === "bridge") {
              const tool =
                entry.op === "dispatch"
                  ? "delegate_task"
                  : entry.op === "resume"
                    ? "t3_thread_send"
                    : "t3_thread_interrupt";
              row.result = await callT3McpTool(
                tool,
                entry.bound ? { threadId: child.childThreadId } : {},
                { transportClient: invoke },
                { expected: entry.bound ? child : {}, retainRaw: true },
              );
              assert.deepEqual(row.result, shape.raw);
              assert.equal(row.calls, 1);
            } else if (entry.kind === "adapter") {
              row.result = await resumeWorker(
                { activeWorker: child, preflight: { canResume: true, clean: true, path: work } },
                { transportClient: invoke },
              );
              assert.equal(row.result.classification, shape.expected);
              assert.equal(row.calls, 1);
            }
            assert.deepEqual(
              fs.readdirSync(work),
              [],
              "Pure receipt boundaries do not write Mission state",
            );
            row.pass = true;
          } catch (error) {
            row.pass = false;
            row.assertion = error.stack;
            throw error;
          }
        });
      return;
    }
    const template = path.join(work, "template");
    const action = await seed(template, entry);
    for (const [index, shape] of shapes(entry.op, entry.bound).entries())
      await t.test(shape.name, async () => {
        const dir = path.join(work, "case-" + index);
        fs.mkdirSync(dir);
        fs.cpSync(path.join(template, ".mission"), path.join(dir, ".mission"), { recursive: true });
        const expectedIdentity = entry.bound ? child : {};
        const verdict = classifyControlReceipt(shape.raw, entry.op, expectedIdentity);
        const row = {
          name: shape.name,
          rawDefined: shape.raw !== undefined,
          raw: shape.raw,
          expected: shape.expected,
          actual: verdict,
          calls: 0,
        };
        rows.push(row);
        try {
          assert.equal(verdict.classification, shape.expected, entry.name + " classification");
          assert.equal(verdict.raw, shape.raw, "The classifier retains the exact raw object");
          const invoke = async () => {
            row.calls++;
            return shape.raw;
          };
          const tolerate = async (fn) => {
            try {
              return await fn();
            } catch (error) {
              (row.errors ??= []).push({ code: error.code, message: error.message });
              return null;
            }
          };
          const before = disk(dir);
          if (entry.kind === "controller") {
            row.result = await tolerate(() =>
              tick(dir, [observation(entry.op, action, shape.raw)]),
            );
            const after = disk(dir),
              run = after.controller.runs[action.runId];
            assert.equal(
              (entry.op === "dispatch" ? run.dispatchControlReceipt : run.controlReceipt)
                .classification,
              shape.expected,
            );
            if (entry.op === "dispatch") {
              assert.equal(after.journals[0].phase === "accepted", shape.expected === "confirmed");
              assert.notEqual(
                (await tick(dir)).type,
                "dispatch",
                "An original claimed intent cannot dispatch again",
              );
            } else {
              assert.equal(
                run.pause.phase,
                shape.expected === "confirmed"
                  ? entry.op === "interrupt"
                    ? "interrupted"
                    : "resumed"
                  : entry.op + "_requested",
              );
              assert.notEqual(
                (await tick(dir)).type,
                entry.op === "interrupt" ? "interrupt_worker" : "resume_worker",
              );
            }
          } else if (entry.kind === "compensation") {
            const adapter = {
              runFeature: async () => {
                const hud = await createHandlerHud({ missionDir: dir, runtimeAdapter: {} });
                try {
                  assert.equal((await hud.post("pause")).status, 200);
                } finally {
                  await hud.close();
                }
                return accepted;
              },
              pauseWorker: invoke,
            };
            row.result = await k.startMissionRun(dir, {}, adapter);
            await k.startMissionRun(dir, {}, adapter);
            const effect = disk(dir).effects.find((value) => value.runId);
            assert.equal(
              effect.phase,
              shape.expected === "confirmed"
                ? "confirmed"
                : shape.expected === "rejected"
                  ? "failed"
                  : "unknown",
            );
            assert.equal(effect.controlReceipt.classification, shape.expected);
            for (const record of [
              k.loadState(dir).activeWorker,
              k.loadState(dir).sessions[0],
              k.loadFeaturesDoc(dir).features[0],
            ])
              assert.equal(record.status, shape.expected === "confirmed" ? "paused" : "running");
            assert.equal(row.calls, 1, "Compensation retains its once-only claim");
          } else if (entry.kind === "journal") {
            const state = k.loadState(dir),
              feature = k.loadFeaturesDoc(dir).features[0];
            const intent = prepareDispatch(dir, {
              state,
              feature,
              worker: state.activeWorker,
              target: state.activeWorker,
            });
            await tolerate(() => dispatchWithIntent(dir, intent, invoke, { operation: entry.op }));
            const record = disk(dir).journals[0];
            assert.equal(
              record.phase === "accepted",
              shape.expected === "confirmed" &&
                !(entry.op === "resume" && shape.name.endsWith("/no-identity-affirmative")),
            );
            await tolerate(() => dispatchWithIntent(dir, intent, invoke, { operation: entry.op }));
            if (
              shape.noRetry ||
              shape.expected === "unknown" ||
              shape.expected === "identity_conflict"
            )
              assert.equal(row.calls, 1);
            if (shape.retryable)
              assert.equal(row.calls, 2, "A proven non-acceptance stays retryable");
          } else if (entry.kind === "runner") {
            const adapter =
              entry.op === "dispatch" ? { runFeature: invoke } : { resumeWorker: invoke };
            row.result = await tolerate(() => k.startMissionRun(dir, {}, adapter));
            await tolerate(() => k.startMissionRun(dir, {}, adapter));
            if (entry.op === "resume")
              assert.equal(
                k.loadState(dir).activeWorker.status,
                shape.expected === "confirmed" ? "running" : "paused",
              );
            else
              assert.equal(
                Boolean(k.loadState(dir).activeWorker.taskId),
                shape.expected === "confirmed",
              );
            if (
              shape.noRetry ||
              ["unknown", "identity_conflict"].includes(shape.expected) ||
              entry.op === "resume"
            )
              assert.equal(row.calls, 1);
            if (shape.retryable)
              assert.equal(row.calls, 2, "A proven non-acceptance stays retryable");
          } else {
            let restore;
            if (entry.kind === "cli" || entry.adapter === "default") {
              const fixture = path.join(dir, "private-protocol.mjs");
              const callsFile = path.join(dir, "private-calls.jsonl");
              fs.writeFileSync(
                fixture,
                `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(callsFile)},'call\\n');console.log(${JSON.stringify(JSON.stringify(shape.raw) ?? "null")});`,
              );
              const old = [process.env.T3_ACP_MCP_NODE, process.env.T3_ACP_MCP_ENTRYPOINT];
              process.env.T3_ACP_MCP_NODE = process.execPath;
              process.env.T3_ACP_MCP_ENTRYPOINT = fixture;
              restore = () => {
                for (const [i, key] of ["T3_ACP_MCP_NODE", "T3_ACP_MCP_ENTRYPOINT"].entries())
                  old[i] === undefined ? delete process.env[key] : (process.env[key] = old[i]);
                row.calls = fs.existsSync(callsFile)
                  ? fs.readFileSync(callsFile, "utf8").trim().split("\n").length
                  : 0;
              };
            }
            try {
              if (entry.kind === "cli") {
                const state = k.loadState(dir),
                  feature = k.loadFeaturesDoc(dir).features[0];
                const args = [
                  entry.op === "dispatch"
                    ? "DispatchWorkerRuntime"
                    : entry.op === "pause"
                      ? "PauseWorkerRuntime"
                      : "ResumeWorkerRuntime",
                  "--mission-dir",
                  dir,
                  "--json",
                  JSON.stringify({
                    missionId: state.missionId,
                    runId: state.activeWorker.runId,
                    activeWorker: state.activeWorker,
                    feature,
                    slotConfig: target,
                  }),
                ];
                const stdio = { stdout: { write() {} }, stderr: { write() {} } };
                if (entry.op === "dispatch") {
                  const adapter = {
                    runFeature: async (currentFeature, currentSlot, currentState) => {
                      const response = await runCli(
                        [
                          "DispatchWorkerRuntime",
                          "--mission-dir",
                          dir,
                          "--json",
                          JSON.stringify({
                            missionId: currentState.missionId,
                            runId: currentFeature.runId,
                            feature: currentFeature,
                            slotConfig: currentSlot,
                          }),
                        ],
                        stdio,
                      );
                      return response.result;
                    },
                  };
                  row.result = await tolerate(() => k.startMissionRun(dir, {}, adapter));
                  await tolerate(() => k.startMissionRun(dir, {}, adapter));
                } else {
                  row.result = await runCli(args, stdio);
                  await runCli(args, stdio);
                }
              } else {
                const options = { missionDir: dir };
                if (entry.adapter === "custom")
                  options.runtimeAdapter = entry.hook
                    ? { startMissionRun: invoke }
                    : { runFeature: invoke, pauseWorker: invoke, resumeWorker: invoke };
                const hud = await createHandlerHud(options);
                try {
                  row.result = await hud.post(entry.action, { commandId: "matrix-command" });
                  row.repeat = await hud.post(entry.action, { commandId: "matrix-command-next" });
                } finally {
                  await hud.close();
                }
              }
            } finally {
              restore?.();
            }
            const after = disk(dir);
            if (entry.kind === "hud") {
              if (entry.op === "pause") {
                assert.equal(
                  after.state.activeWorker.status,
                  shape.expected === "confirmed" ? "paused" : "running",
                );
                assert.equal(
                  after.state.pauseControl.phase,
                  shape.expected === "confirmed"
                    ? "confirmed"
                    : shape.expected === "rejected"
                      ? "rejected"
                      : "unknown",
                );
                assert.equal(row.calls, 1);
              } else if (entry.op === "resume") {
                assert.equal(
                  after.state.status,
                  shape.expected === "confirmed" ? "running" : "paused",
                );
                assert.equal(
                  after.state.activeWorker.status,
                  shape.expected === "confirmed" ? "running" : "paused",
                );
                assert.equal(row.calls, 1);
              } else {
                assert.equal(
                  Boolean(after.state.activeWorker?.taskId),
                  shape.expected === "confirmed",
                );
                if (shape.noRetry || ["unknown", "identity_conflict"].includes(shape.expected))
                  assert.equal(row.calls, 1);
              }
            } else
              assert.equal(
                row.calls,
                entry.op === "dispatch" &&
                  (shape.retryable || shape.retryablePending || shape.nonacceptance)
                  ? 2
                  : 1,
                "CLI retries only decided nonacceptance and replays every other durable raw return",
              );
          }
          row.after = disk(dir);
          if (entry.bound && entry.kind !== "schema")
            assert.equal(
              row.after.state.activeWorker?.taskId,
              before.state.activeWorker?.taskId ?? child.taskId,
              "Original child ownership is retained",
            );
          row.pass = true;
        } catch (error) {
          row.pass = false;
          row.assertion = error.stack;
          throw error;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
  });
