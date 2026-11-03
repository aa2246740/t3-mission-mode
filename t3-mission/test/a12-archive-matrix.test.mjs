import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { readObservations } from "../kernel/autopilot-store.mjs";
import {
  init,
  now,
  observation,
  accepted,
  status,
  fresh,
  reapprove,
  ledger,
} from "./fixtures/a10-fixture.mjs";

// The raw storage API seeds old archives, including shapes the input boundary now rejects.
// Each replay and every public-entry probe runs in a fresh Node process.
const shapes = [
  { name: "no-intent", tag: "none", encoded: false },
  { name: "wrong-intent", tag: "wrong", encoded: false },
  { name: "correct-intent", tag: "correct", encoded: false },
  { name: "encoded-id", tag: "none", encoded: true },
  { name: "plain-id", tag: "none", encoded: false },
];
const expected = {
  "no-intent": { unique: "applied", multiple: "unattributed", zero: "unattributed" },
  "wrong-intent": { unique: "unattributed", multiple: "unattributed", zero: "unattributed" },
  "correct-intent": { unique: "applied", multiple: "applied", zero: "refused" },
  "encoded-id": { unique: "applied", multiple: "unattributed", zero: "unattributed" },
  "plain-id": { unique: "applied", multiple: "unattributed", zero: "unattributed" },
};
for (const phase of ["before_archive", "after_archive", "after_reduce"])
  for (const shape of shapes)
    for (const ownership of ["unique", "multiple", "zero"])
      test(`A12 archive ${phase} ${shape.name} ${ownership}`, async () => {
        const d = init("archive-matrix");
        let setupCalls = 0;
        await assert.rejects(() =>
          k.startMissionRun(
            d,
            {},
            {
              runFeature: async () => {
                setupCalls++;
                return { accepted: false, code: "PROVIDER_BUSY" };
              },
            },
          ),
        );
        const old = inspectDispatchRecords(d)[0];
        reapprove(d, "replacement-model");
        const suffix =
          ":delegated-task:" +
          encodeURIComponent(
            "command:mcp:original-owner:delegate-task:" + old.intent.clientRequestId,
          );
        const taskId = shape.encoded ? "node" + suffix : "current-task",
          childThreadId = shape.encoded ? "thread" + suffix : "current-thread";
        await k.startMissionRun(
          d,
          {},
          {
            runFeature: async () => {
              setupCalls++;
              return { accepted: true, taskId, childThreadId, childRunId: "current-turn" };
            },
          },
        );
        const current = inspectDispatchRecords(d)[0];
        const a = {
          featureId: "f1",
          runId: current.intent.runId,
          intentId: current.intent.clientRequestId,
          ...current.receipt,
        };
        const timer = fresh(d, "tick", { now: now + 998 });
        assert.equal(timer.result.action.type, "ensure_timer");
        const primed = fresh(d, "tick", {
          now: now + 999,
          observations: [
            {
              type: "timer",
              requestId: timer.result.action.requestId,
              response: { taskId: "timer", enabled: true },
            },
          ],
        });
        assert.equal(primed.result.action.type, "poll");
        const h = {
          ...a,
          intentId: old.intent.clientRequestId,
          invocationId: old.invocations[0].invocationId,
          taskId: ownership === "multiple" ? taskId : "history-task",
          childThreadId: ownership === "multiple" ? childThreadId : "history-thread",
          childRunId: "history-turn",
        };
        const late = fresh(d, "tick", {
          now: now + 1000,
          observations: [observation(h, accepted(h))],
        });
        assert.equal(late.ok, true);
        assert.equal(late.result.action.type, "poll");
        assert.equal(late.result.action.taskId, h.taskId);
        assert.deepEqual(late.calls, []);
        const raw = status(
          ownership === "zero"
            ? { ...a, taskId: "orphan-task", childThreadId: "orphan-thread" }
            : a,
          "running",
        );
        if (shape.tag === "wrong") raw.intentId = "wrong-intent";
        else if (shape.tag === "none") delete raw.intentId;
        const child = cp.spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL("./fixtures/a12-archive-matrix-child.mjs", import.meta.url)),
            d,
            JSON.stringify(raw),
            phase,
          ],
          { encoding: "utf8" },
        );
        const replay = fresh(d, "tick", { now: now + 1002 });
        const rows = readObservations(d),
          stored = rows.find((row) => JSON.stringify(row.observation) === JSON.stringify(raw));
        const after = ledger(d);
        const entry = stored && after.observations[stored.id];
        const fenced = fresh(d);
        const recovery = fresh(d, "tick", {
          now: now + 1003,
          observations: [status(h, "cancelled"), status(a, "running")],
        });
        const next = fresh(d, "tick", { now: now + 1004 });
        const final = ledger(d),
          want = phase === "before_archive" ? "absent" : expected[shape.name][ownership];
        fs.writeFileSync(
          path.join(process.env.R9_EVIDENCE_DIR, `${phase}-${shape.name}-${ownership}.json`),
          JSON.stringify(
            {
              d,
              phase,
              shape,
              ownership,
              raw,
              child: { exit: child.status, stderr: child.stderr },
              stored,
              entry,
              after,
              replay,
              fenced,
              recovery,
              next,
              final,
              setupCalls,
            },
            null,
            2,
          ) + "\n",
        );
        assert.equal(child.status, 77, child.stderr);
        assert.equal(replay.ok, true);
        assert.equal(replay.result.action.type, "poll");
        assert.equal(replay.result.action.taskId, h.taskId);
        assert.deepEqual(replay.calls, []);
        assert.equal(entry?.outcome ?? "absent", want);
        if (want === "unattributed") {
          assert.equal(
            entry.code,
            shape.tag === "wrong" || ownership === "zero"
              ? "TASK_STATUS_OWNERSHIP_UNRESOLVED"
              : "TASK_STATUS_OWNERSHIP_AMBIGUOUS",
          );
          assert.equal(entry.details.taskId, raw.taskId);
          assert.ok(entry.message.includes("exactly one intent"));
          assert.deepEqual(stored.observation, raw);
        }
        for (const run of Object.values(after.runs))
          assert.equal(
            run.statusError?.code,
            want === "refused" ? "INVALID_T3_OBSERVATION" : undefined,
          );
        assert.equal(fenced.ok, true);
        assert.deepEqual(fenced.calls, []);
        assert.equal(setupCalls, 2);
        assert.equal(recovery.ok, true);
        assert.equal(recovery.result.action.type, "sleep");
        assert.deepEqual(recovery.calls, []);
        assert.equal(next.ok, true);
        assert.equal(next.result.action.type, "poll");
        assert.equal(next.result.action.taskId, taskId);
        assert.deepEqual(next.calls, []);
        assert.equal(Object.values(final.dispatchResolutions ?? {}).length, 1);
        for (const run of Object.values(final.runs)) assert.equal(run.statusError, undefined);
      });

for (const mode of ["exit", "SIGKILL"])
  test(`A12 unattributed progress diagnostic survives replacement ${mode}`, async () => {
    const d = init("progress-diagnostic-" + mode);
    let setupCalls = 0;
    await assert.rejects(() =>
      k.startMissionRun(
        d,
        {},
        {
          runFeature: async () => {
            setupCalls++;
            return { accepted: false, code: "PROVIDER_BUSY" };
          },
        },
      ),
    );
    const old = inspectDispatchRecords(d)[0];
    reapprove(d, "replacement-model");
    await k.startMissionRun(
      d,
      {},
      {
        runFeature: async () => {
          setupCalls++;
          return {
            accepted: true,
            taskId: "shared-task",
            childThreadId: "shared-thread",
            childRunId: "shared-turn",
          };
        },
      },
    );
    const current = inspectDispatchRecords(d)[0],
      a = {
        featureId: "f1",
        runId: current.intent.runId,
        intentId: current.intent.clientRequestId,
        ...current.receipt,
      };
    const timer = fresh(d, "tick", { now: now + 997 });
    assert.equal(timer.result.action.type, "ensure_timer");
    fresh(d, "tick", {
      now: now + 998,
      observations: [
        {
          type: "timer",
          requestId: timer.result.action.requestId,
          response: { taskId: "timer", enabled: true },
        },
      ],
    });
    fresh(d, "tick", {
      now: now + 999,
      observations: [status(a, "running", { summary: "known-current-progress" })],
    });
    const raw = status(a, "running", { summary: "original-unattributed-progress-diagnostic" });
    delete raw.intentId;
    const child = cp.spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/a12-archive-crash-child.mjs", import.meta.url)),
        d,
        JSON.stringify([raw]),
        mode,
      ],
      { encoding: "utf8" },
    );
    if (mode === "SIGKILL") assert.equal(child.signal, "SIGKILL", child.stderr);
    else assert.equal(child.status, 77, child.stderr);
    const persisted = readObservations(d).find(
      (r) => r.observation.response?.summary === "original-unattributed-progress-diagnostic",
    );
    assert.equal(persisted.progressCount, 1);
    const h = {
      ...a,
      intentId: old.intent.clientRequestId,
      invocationId: old.invocations[0].invocationId,
    };
    const first = fresh(d, "tick", {
      now: now + 1001,
      observations: [observation(h, accepted(h))],
    });
    const marked = ledger(d).observations[persisted.id];
    const beforeControl = fresh(d);
    const resumed = fresh(d, "tick", {
      now: now + 1002,
      observations: [
        status(h, "cancelled"),
        status(a, "running", { summary: "new-explicit-current-progress" }),
      ],
    });
    const next = fresh(d, "tick", { now: now + 1003 }),
      again = fresh(d, "tick", { now: now + 1004 });
    const rows = readObservations(d),
      after = ledger(d),
      log = fs
        .readFileSync(k.getMissionPaths(d).progressLogPath, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
    const diagnostics = log.filter(
      (row) =>
        row.type === "task_status_unattributed" && row.details?.observationId === persisted.id,
    );
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, "progress-diagnostic-" + mode + ".json"),
      JSON.stringify(
        {
          d,
          mode,
          raw,
          persisted,
          first,
          marked,
          beforeControl,
          resumed,
          next,
          again,
          rows,
          after,
          log,
          diagnostics,
          setupCalls,
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(first.ok, true);
    assert.equal(first.result.action.type, "poll");
    assert.equal(marked.outcome, "unattributed");
    assert.equal(marked.code, "TASK_STATUS_OWNERSHIP_AMBIGUOUS");
    assert.equal(beforeControl.ok, true);
    assert.deepEqual(beforeControl.calls, []);
    assert.equal(setupCalls, 2);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.result.action.type, "sleep");
    assert.deepEqual(resumed.calls, []);
    for (const value of [next, again]) {
      assert.equal(value.ok, true);
      assert.equal(value.result.action.type, "poll");
      assert.equal(value.result.action.taskId, "shared-task");
      assert.deepEqual(value.calls, []);
    }
    assert.equal(
      rows.some(
        (row) => row.observation.response?.summary === "original-unattributed-progress-diagnostic",
      ),
      false,
      "Ordinary progress still keeps its latest raw status",
    );
    assert.equal(
      diagnostics.length,
      1,
      "An identified unattributed status must retain one complete diagnostic after progress replacement",
    );
    assert.equal(diagnostics[0].details.code, "TASK_STATUS_OWNERSHIP_AMBIGUOUS");
    assert.deepEqual(diagnostics[0].details.observation, raw);
    assert.equal(Object.values(after.dispatchResolutions ?? {}).length, 1);
    for (const run of Object.values(after.runs)) assert.equal(run.statusError, undefined);
  });
