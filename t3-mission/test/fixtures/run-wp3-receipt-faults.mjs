import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || fs.existsSync(root)) throw new Error("Pass a new owned evidence directory");
fs.mkdirSync(root, { recursive: true });
const actor = fileURLToPath(new URL("./wp3-actor.mjs", import.meta.url));
function run(operation, dir, input, output) {
  fs.mkdirSync(output, { recursive: true });
  const argv = [actor, operation, dir, JSON.stringify(input ?? {})];
  const r = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 16000000,
  });
  fs.writeFileSync(path.join(output, "stdout.log"), r.stdout ?? "");
  fs.writeFileSync(path.join(output, "stderr.log"), r.stderr ?? "");
  fs.writeFileSync(
    path.join(output, "run.json"),
    JSON.stringify(
      {
        argv: [process.execPath, ...argv],
        status: r.status,
        signal: r.signal,
        error: r.error?.message,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    ...r,
    result: r.status === 0 ? JSON.parse(r.stdout).result : null,
    events: r.status === 0 ? JSON.parse(r.stdout).events : [],
  };
}
const summaries = [];
for (const scenario of ["receipt", "consume"]) {
  const home = path.join(root, scenario);
  fs.mkdirSync(home);
  const template = path.join(home, "template");
  fs.mkdirSync(template);
  assert.equal(run("init", template, {}, path.join(template, "init")).status, 0);
  assert.equal(run("budget", template, {}, path.join(template, "budget")).status, 0);
  const actionResult = run("tick", template, {}, path.join(template, "dispatch"));
  assert.equal(actionResult.status, 0, actionResult.stderr);
  const action = actionResult.result.action;
  assert.equal(action.type, "dispatch");
  const receipt = {
    accepted: true,
    taskId: "durable-task",
    childThreadId: "durable-thread",
    childRunId: "durable-child",
    runtimeTransport: "t3-delegate-task",
  };
  const dispatchObservation = {
    type: "dispatch",
    runId: action.runId,
    featureId: action.featureId,
    intentId: action.intentId,
    response: receipt,
  };
  let payload = { observations: [dispatchObservation] };
  if (scenario === "consume") {
    assert.equal(run("tick", template, { payload }, path.join(template, "bind")).status, 0);
    const sha = "a".repeat(40);
    const envelope = {
      version: 1,
      featureId: action.featureId,
      runId: action.runId,
      status: "success",
      summary:
        "Implemented the full owned fixture with a deterministic command interface and verified its behavior through explicit checks.",
      tests: [{ command: "owned-fixture-check", status: "passed" }],
      discoveredIssues: [],
      whatWasLeftUndone: [],
      commit: sha,
      branch: "feature/wp3",
    };
    const status = {
      ...receipt,
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      summary: "```mission-result\n" + JSON.stringify(envelope) + "\n```",
    };
    payload = {
      observations: [
        {
          type: "task_status",
          runId: action.runId,
          featureId: action.featureId,
          taskId: receipt.taskId,
          response: status,
        },
        {
          type: "integration",
          runId: action.runId,
          featureId: action.featureId,
          response: {
            branch: "mission/wp3",
            sourceBranch: "feature/wp3",
            commit: sha,
            mergeSha: sha,
          },
        },
      ],
    };
  }
  function fixture(name) {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    fs.cpSync(path.join(template, ".mission"), path.join(dir, ".mission"), { recursive: true });
    return dir;
  }
  const golden = fixture("trace"),
    trace = run("tick", golden, { payload, trace: true }, path.join(golden, "update"));
  assert.equal(trace.status, 0, trace.stderr);
  const expected = run("read", golden, {}, path.join(golden, "after"));
  assert.equal(expected.status, 0, expected.stderr);
  if (scenario === "receipt")
    assert.equal(expected.result.state.activeWorker.taskId, receipt.taskId);
  else
    assert.equal(
      expected.result.progressLog.filter((row) => row.type === "feature_run_ended").length,
      1,
    );
  fs.writeFileSync(
    path.join(home, "boundaries.json"),
    JSON.stringify(trace.events, null, 2) + "\n",
  );
  const matrix = [];
  for (const kind of ["EIO", "ENOSPC", "SIGKILL"])
    for (const event of trace.events) {
      const name = `${kind}-${event.ordinal}-${event.role.replaceAll("/", "_")}-${event.operation}-${event.boundary}`;
      const dir = fixture(name),
        failed = run(
          "tick",
          dir,
          { payload, fault: { kind, ordinal: event.ordinal } },
          path.join(dir, "injected"),
        );
      const row = { name, kind, event, failureStatus: failed.status, failureSignal: failed.signal };
      try {
        if (kind === "SIGKILL") assert.equal(failed.signal, "SIGKILL", failed.stderr);
        else {
          assert.equal(failed.status, 1, failed.stderr);
          assert.match(failed.stderr, new RegExp(kind));
        }
        const recovered = run("read", dir, {}, path.join(dir, "recovery"));
        assert.equal(recovered.status, 0, recovered.stderr);
        const snap = recovered.result;
        const projections = [
          snap.state.activeWorker,
          snap.state.sessions[0],
          snap.featuresDoc.features[0],
        ].filter(Boolean);
        if (scenario === "receipt") {
          const identities = projections.map((row) => row.taskId ?? null);
          assert.ok(
            identities.every((id) => id === null) ||
              identities.every((id) => id === receipt.taskId),
            "Mixed accepted identity projections",
          );
          assert.equal(snap.ledger.features.f1.providerErrors, 2);
          assert.equal(snap.ledger.consecutiveProviderErrors, 2);
        } else {
          assert.ok(snap.progressLog.filter((row) => row.type === "feature_run_ended").length <= 1);
          if (!snap.state.activeWorker) assert.equal(snap.ledger.runs[action.runId].consumed, true);
          assert.equal(snap.state.sessions[0].taskId, receipt.taskId);
        }
        const retry = run("tick", dir, { payload }, path.join(dir, "retry"));
        assert.equal(retry.status, 0, retry.stderr);
        assert.notEqual(retry.result.action.type, "dispatch");
        const duplicate = run("tick", dir, { payload }, path.join(dir, "duplicate"));
        assert.equal(duplicate.status, 0, duplicate.stderr);
        assert.notEqual(duplicate.result.action.type, "dispatch");
        const final = run("read", dir, {}, path.join(dir, "final"));
        assert.equal(final.status, 0, final.stderr);
        assert.equal(final.result.records[0].phase, "accepted");
        assert.equal(final.result.records[0].receipt.taskId, receipt.taskId);
        if (scenario === "receipt") {
          assert.equal(final.result.state.activeWorker.taskId, receipt.taskId);
          assert.equal(final.result.ledger.features.f1.providerErrors, 2);
        } else {
          assert.equal(
            final.result.progressLog.filter((row) => row.type === "feature_run_ended").length,
            1,
          );
          assert.equal(final.result.ledger.runs[action.runId].consumed, true);
        }
        row.pass = true;
      } catch (error) {
        row.pass = false;
        row.error = error.stack;
      }
      matrix.push(row);
      fs.writeFileSync(path.join(home, "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
    }
  const summary = {
    scenario,
    boundaries: trace.events.length,
    cases: matrix.length,
    passed: matrix.filter((row) => row.pass).length,
    failed: matrix.filter((row) => !row.pass).length,
  };
  summaries.push(summary);
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summaries, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}
if (summaries.some((row) => row.failed)) process.exitCode = 1;
