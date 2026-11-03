import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import * as k from "../kernel/index.mjs";
import { createMissionHudServer } from "../hud/server.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { runCli } from "../bridge/cli.mjs";
import { assertRejectedPause } from "./pause-contract-fixture.mjs";

const receipt = { accepted: true, taskId: "receipt-task", childThreadId: "receipt-thread", childRunId: "receipt-child-run", runtimeTransport: "t3-delegate-task" };
function fixture(t, approved = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-boundary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cp.execFileSync("git", ["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  cp.execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  cp.execFileSync("git", ["-C", dir, "-c", "user.name=Receipt Fixture", "-c", "user.email=receipt@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture", "--no-gpg-sign"]);
  k.proposeMission(dir, { repoPath: dir, title: "Receipt boundary", milestones: [{ id: "m1" }], features: [{ id: "f1", milestoneId: "m1" }], modelSettings: { skipScrutiny: true, skipUserTesting: true, worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", reasoningEffort: "max" } } });
  if (approved) k.approveMissionPlan(dir);
  return dir;
}
const nested = value => ({ delegation: { response: value } });
function journal(dir) {
  const root = path.join(dir, ".mission");
  const files = fs.readdirSync(root).filter(name => /^dispatch-.*\.json$/.test(name));
  assert.equal(files.length, 1);
  const file = path.join(root, files[0]);
  return { file, record: JSON.parse(fs.readFileSync(file, "utf8")) };
}
function projections(dir) {
  const state = k.loadState(dir);
  return [state.activeWorker, state.sessions.at(-1), k.loadFeaturesDoc(dir).features[0]].filter(Boolean);
}
async function post(hud) {
  const response = await fetch(hud.url + "/api/mission/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(4000) });
  return { status: response.status, body: await response.json() };
}
async function invoke(entry, dir, adapter) {
  if (entry === "kernel") return k.startMissionRun(dir, {}, adapter);
  if (entry === "MCP") return callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: adapter });
  const hud = await createMissionHudServer({ missionDir: dir, port: 0, dispatchAdapter: adapter });
  try { return await post(hud); } finally { await hud.close(); }
}
async function outcome(entry, dir, adapter) {
  try { return await invoke(entry, dir, adapter); } catch (error) { return { code: error.code, error: error.message }; }
}

for (const entry of ["kernel", "MCP", "http"]) {
  for (const shape of ["accepted-with-scope", "pending", "rejected", "foreign-target", "foreign-run"]) {
    test(`Receipt boundary ${entry} ${shape}`, async t => {
      const dir = fixture(t, entry !== "http");
      let calls = 0;
      const adapter = { runFeature: async (_feature, _slot, state) => {
        calls++;
        if (["pending", "rejected"].includes(shape) && calls > 1) return receipt;
        if (shape === "pending") return nested({ dispatchPending: true });
        if (shape === "rejected") return nested({ accepted: false, ok: false, code: "PROVIDER_BUSY", taskId: "rejected-task", childThreadId: "rejected-thread" });
        if (shape === "foreign-target") return nested({ ...receipt, target: { providerInstanceId: "grok", model: "grok-4.7" } });
        if (shape === "foreign-run") return nested({ ...receipt, missionRunId: "foreign-run", featureId: "foreign-feature" });
        return nested({ accepted: true, started: true, featureId: "f1", runId: state.activeWorker.runId });
      } };
      const first = await outcome(entry, dir, adapter);
      assert.equal(calls, 1);
      assert.equal(projections(dir).some(row => row.taskId === "rejected-task" || row.taskId === receipt.taskId), false);
      const beforeRetry = journal(dir);
      if (shape === "pending") {
        assert.equal(beforeRetry.record.phase, "retryable");
        if (shape === "rejected" && entry === "http") assert.equal(first.status, 409);
        await invoke(entry, dir, adapter);
        assert.equal(calls, 2);
        assert.equal(projections(dir).length, 3);
        for (const row of projections(dir)) assert.equal(row.taskId, receipt.taskId);
      } else {
        assert.equal(beforeRetry.record.phase, "inflight");
        assert.ok(beforeRetry.record.observedReceipt);
        await outcome(entry, dir, adapter);
        assert.equal(calls, 1);
        assert.equal(projections(dir).some(row => row.taskId), false);
      }
    });
  }
}

test("A retained fsynced receipt recovers under the same intent after HUD reopen", async t => {
  const dir = fixture(t, false);
  const files = k.getMissionPaths(dir);
  const before = Object.fromEntries(["statePath", "featuresPath", "modelSettingsPath", "progressLogPath"].map(key => [key, fs.readFileSync(files[key], "utf8")]));
  let calls = 0, injected = false;
  const adapter = { runFeature: async () => { calls++; return receipt; } };
  const hud = await createMissionHudServer({ missionDir: dir, port: 0, dispatchAdapter: adapter });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to, ...args) {
    if (!injected && /^dispatch-.*\.json$/.test(path.basename(String(to))) && JSON.parse(fs.readFileSync(from, "utf8")).phase === "accepted") {
      injected = true;
      throw Object.assign(new Error("Owned one-time accepted rename EIO"), { code: "EIO" });
    }
    return rename.call(this, from, to, ...args);
  };
  let first;
  try { first = await post(hud); } finally { fs.renameSync = rename; await hud.close(); }
  assert.equal(first.status, 500);
  assert.equal(first.body.code, "EIO");
  const recovered = k.readMissionSnapshot(dir);
  assert.equal(recovered.state.planAccepted, true);
  assert.equal(recovered.state.sessions.length, 1);
  assert.equal(recovered.state.activeWorker.dispatchPending, true);
  assert.equal(fs.readFileSync(files.modelSettingsPath, "utf8"), before.modelSettingsPath);
  const retained = fs.readdirSync(path.join(dir, ".mission")).filter(name => name.includes(".accepted-") && name.endsWith(".tmp"));
  assert.equal(retained.length, 0);
  const archived = fs.readdirSync(path.join(dir, ".mission/.txn/receipts"));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".mission/.txn/receipts", archived[0]), "utf8")).result.taskId, receipt.taskId);
  assert.equal(journal(dir).record.phase, "accepted");
  const originalRun = journal(dir).record.intent.runId;
  const reopened = await createMissionHudServer({ missionDir: dir, port: 0, dispatchAdapter: adapter });
  try { assert.equal((await post(reopened)).status, 200); } finally { await reopened.close(); }
  assert.equal(calls, 1);
  assert.equal(journal(dir).record.phase, "accepted");
  for (const row of projections(dir)) { assert.equal(row.runId, originalRun); assert.equal(row.taskId, receipt.taskId); }
  assert.equal(fs.readdirSync(path.join(dir, ".mission")).some(name => name.includes(".accepted-") && name.endsWith(".tmp")), false);
});

for (const fault of ["wrong-intent", "wrong-request", "malformed"]) {
  test(`Retained receipt ${fault} stays fenced`, async t => {
    const dir = fixture(t); let calls = 0;
    const adapter = { runFeature: async () => { calls++; return { accepted: true }; } };
    await assert.rejects(k.startMissionRun(dir, {}, adapter), { code: "DISPATCH_OUTCOME_UNKNOWN" });
    const current = journal(dir), retained = current.file + ".accepted-owned-fixture.tmp";
    const record = { ...current.record, phase: "accepted", receipt: { ...receipt, clientRequestId: current.record.intent.clientRequestId }, result: {} };
    if (fault === "wrong-intent") record.intent = { ...record.intent, runId: "foreign-run" };
    if (fault === "wrong-request") record.receipt.clientRequestId = "foreign-request";
    const bytes = fault === "malformed" ? "{broken" : JSON.stringify(record);
    fs.writeFileSync(retained, bytes);
    await assert.rejects(k.startMissionRun(dir, {}, adapter));
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(retained, "utf8"), bytes);
    assert.equal(journal(dir).record.phase, "inflight");
    assert.equal(projections(dir).some(row => row.taskId), false);
  });
}

async function unrelatedProcess(t) {
  const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  await once(child, "spawn");
  return child;
}
function claim(dir, pid, runId, runtimeTransport) {
  const daemonStateFile = path.join(dir, "unrelated-process.json");
  const bytes = JSON.stringify({ pid, missionDir: dir, repoPath: dir, runId, featureId: "f1", status: "running" });
  fs.writeFileSync(daemonStateFile, bytes);
  return { runtimeTransport, workerPid: pid, daemonStateFile, daemonStatus: "running", bytes };
}
for (const transport of ["t3-delegate-task", "bridge-cli-subprocess"]) {
  test(`EndFeatureRun preserves a live unrelated PID tagged ${transport}`, async t => {
    const dir = fixture(t), child = await unrelatedProcess(t);
    await k.startMissionRun(dir, {}, { runFeature: async () => receipt });
    const state = k.loadState(dir), runtime = claim(dir, child.pid, state.activeWorker.runId, transport);
    const { bytes, ...metadata } = runtime;
    Object.assign(state.activeWorker, metadata);
    Object.assign(state.sessions[0], metadata);
    k.saveState(dir, state);
    const features = k.loadFeaturesDoc(dir); Object.assign(features.features[0], metadata); k.saveFeaturesDoc(dir, features);
    k.endFeatureRun(dir, { runId: state.activeWorker.runId, featureId: "f1", successState: "success", validatorsPassed: true, handoff: { whatWasImplemented: "Implemented and verified receipt boundary behavior using this private fixture and its original accepted identity." } });
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal(fs.readFileSync(runtime.daemonStateFile, "utf8"), bytes);
    const ended = [k.loadState(dir).sessions[0], k.loadFeaturesDoc(dir).features[0]];
    if (transport === "t3-delegate-task") for (const row of ended) for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) assert.equal(Object.hasOwn(row, key), false);
    else for (const row of ended) assert.notEqual(row.daemonStatus, "stopped");
  });
}
test("CLI Pause and Resume reject a live PID whose command is unrelated", async t => {
  const dir = fixture(t), child = await unrelatedProcess(t);
  const runtime = claim(dir, child.pid, "private-run", "bridge-cli-subprocess");
  for (const command of ["PauseWorkerRuntime", "ResumeWorkerRuntime"]) {
    let stdout = "", stderr = "";
    const result = await runCli([command, "--mission-dir", dir, "--json", JSON.stringify({ activeWorker: { ...runtime, runId: "private-run", featureId: "f1" } })], { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(stderr || stdout).code, "WORKER_OWNERSHIP_UNVERIFIED");
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal(fs.readFileSync(runtime.daemonStateFile, "utf8"), runtime.bytes);
  }
});
test("Remote transport PID fields are absent in every accepted projection and journal", async t => {
  const dir = fixture(t), child = await unrelatedProcess(t);
  const runtime = claim(dir, child.pid, "private-run", "t3-delegate-task");
  await k.startMissionRun(dir, {}, { runFeature: async () => ({ ...receipt, ...runtime }) });
  for (const row of [...projections(dir), journal(dir).record.receipt]) for (const key of ["workerPid", "daemonStateFile", "daemonStatus"]) assert.equal(Object.hasOwn(row, key), false);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.equal(fs.readFileSync(runtime.daemonStateFile, "utf8"), runtime.bytes);
});


const controlContainers = ["root", "response", "delegation", "response.delegation", "delegation.response"];
const localRuntimeKeys = ["workerPid", "daemonStateFile", "daemonStatus"];
function wrapControl(container, value) {
  for (const key of container === "root" ? [] : container.split(".").reverse()) value = { [key]: value };
  return value;
}
async function pausedControlFixture(t, legacy = true) {
  const dir = fixture(t);
  await k.startMissionRun(dir);
  const state = k.loadState(dir);
  state.status = "paused"; state.pausedAt = "2026-10-22T18:00:00.000Z"; state.lastStartedAt = null;
  for (const row of [state.activeWorker, state.sessions[0]]) {
    row.status = "paused";
    if (legacy) for (const key of ["dispatchPending", "runtimeTransport", "delegatedBy"]) delete row[key];
  }
  k.saveState(dir, state);
  return dir;
}
function missionBytes(dir) {
  const paths = k.getMissionPaths(dir);
  return Object.fromEntries(["statePath", "featuresPath", "modelSettingsPath", "progressLogPath"].map(key => [key, fs.readFileSync(paths[key], "utf8")]));
}
async function invokeControl(entry, dir, adapter) {
  if (entry === "kernel") return k.startMissionRun(dir, {}, adapter);
  if (entry === "MCP") return callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: adapter });
  const hud = await createMissionHudServer({ missionDir: dir, port: 0, dispatchAdapter: adapter });
  try {
    const res = await fetch(hud.url + "/api/mission/resume", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(4000) });
    return { status: res.status, body: await res.json() };
  } finally { await hud.close(); }
}
const resumedReceipt = { ...receipt, resumed: true };
for (const entry of ["kernel", "MCP", "http"]) {
  for (const container of controlContainers) {
    for (const marker of ["resumed", "canResume", "isError"]) {
      test("Resume refusal "+entry+" "+container+" "+marker+" remains retryable across reopen", async t => {
        const dir = await pausedControlFixture(t);
        const before = missionBytes(dir);
        const raw = wrapControl(container, { taskId: "refused-task", childThreadId: "refused-thread", code: "PROVIDER_BUSY", [marker]: marker === "isError" });
        let calls = 0;
        const adapter = { resumeWorker: async () => ++calls === 1 ? raw : resumedReceipt, runFeature: async () => assert.fail("Legacy resume must not dispatch through runFeature") };
        const first = invokeControl(entry, dir, adapter);
        if (entry === "http") assert.equal((await first).status, 409);
        else await assert.rejects(first, { code: "DISPATCH_OUTCOME_UNKNOWN" });
        assert.deepEqual(missionBytes(dir), before);
        assert.equal(journal(dir).record.phase, "inflight");
        assert.equal(journal(dir).record.lastOutcome.kind, "unknown");
        for (const row of projections(dir)) assert.notEqual(row.taskId, "refused-task");
        if (entry === "http") assert.equal((await invokeControl(entry, dir, adapter)).status, 409);
        else await assert.rejects(invokeControl(entry, dir, adapter), { code: "DISPATCH_OUTCOME_UNKNOWN" });
        assert.equal(calls, 1);
        assert.equal(k.loadState(dir).status, "paused");
        for (const row of projections(dir)) assert.equal(row.taskId, undefined);
      });
    }
    test("Resume pending "+entry+" "+container+" preserves paused bytes before accepted retry", async t => {
      const dir = await pausedControlFixture(t), before = missionBytes(dir);
      let calls = 0;
      const raw = wrapControl(container, { dispatchPending: true, taskId: "unaccepted-task", childThreadId: "unaccepted-thread" });
      const adapter = { resumeWorker: async () => ++calls === 1 ? raw : resumedReceipt };
      if (entry === "http") assert.equal((await invokeControl(entry, dir, adapter)).status, 409);
      else await assert.rejects(invokeControl(entry, dir, adapter), { code: "DISPATCH_OUTCOME_UNKNOWN" });
      assert.deepEqual(missionBytes(dir), before);
      assert.equal(journal(dir).record.phase, "inflight");
      assert.equal(journal(dir).record.lastOutcome.kind, "unknown");
      if (entry === "http") assert.equal((await invokeControl(entry, dir, adapter)).status, 409);
      else await assert.rejects(invokeControl(entry, dir, adapter), { code: "DISPATCH_OUTCOME_UNKNOWN" });
      assert.equal(calls, 1);
      for (const row of projections(dir)) assert.equal(row.taskId, undefined);
    });
  }
  test("Initial dispatch "+entry+" accepts Bridge resumed:false metadata", async t => {
    const dir = fixture(t, entry !== "http");
    let calls = 0;
    const adapter = { runFeature: async () => { calls++; return { ...receipt, resumed: false }; } };
    await invoke(entry, dir, adapter);
    assert.equal(calls, 1);
    assert.equal(journal(dir).record.phase, "accepted");
    for (const row of projections(dir)) assert.equal(row.taskId, receipt.taskId);
  });
  test("Legacy accepted without identity "+entry+" remains unknown and cannot redispatch", async t => {
    const dir = await pausedControlFixture(t);
    let calls = 0;
    const adapter = { resumeWorker: async () => { calls++; return { accepted: true }; } };
    for (let i = 0; i < 2; i++) {
      try { await invokeControl(entry, dir, adapter); } catch (error) { assert.equal(error.code, "DISPATCH_OUTCOME_UNKNOWN"); }
    }
    assert.equal(calls, 1);
    assert.equal(journal(dir).record.phase, "inflight");
    assert.equal(k.loadState(dir).status, "paused");
    for (const row of projections(dir)) assert.equal(Boolean(row.taskId || row.childThreadId), false);
  });
}
for (const entry of ["kernel", "MCP"]) for (const container of controlContainers) {
  test("Paused dispatch "+entry+" "+container+" pending does not resume Mission", async t => {
    const dir = await pausedControlFixture(t, false);
    let calls = 0;
    const raw = wrapControl(container, { dispatchPending: true, taskId: "unaccepted-task", childThreadId: "unaccepted-thread" });
    await assert.rejects(invokeControl(entry, dir, { runFeature: async () => { calls++; return raw; } }), { code: "DISPATCH_OUTCOME_UNKNOWN" });
    assert.equal(calls, 1);
    assert.equal(k.loadState(dir).status, "paused");
    assert.equal(k.loadState(dir).activeWorker.status, "paused");
    assert.equal(journal(dir).record.phase, "inflight");
    for (const row of projections(dir)) assert.equal(Boolean(row.taskId || row.childThreadId), false);
  });
}
for (const stale of [false, true]) {
  test("Remote default controls omit local metadata with stale="+stale, async t => {
    const dir = fixture(t, false), shim = path.join(dir, "private-acp.mjs");
    fs.writeFileSync(shim, "const tool=process.argv[3];if(!['delegate_task','t3_thread_send','t3_thread_interrupt'].includes(tool))throw new Error('Unexpected transport operation');console.log(JSON.stringify(tool==='delegate_task'?"+JSON.stringify(receipt)+":tool==='t3_thread_send'?{delivery:'started'}:{ok:true,interrupted:true}));");
    cp.execFileSync("git", ["-C", dir, "add", "private-acp.mjs"]);
    cp.execFileSync("git", ["-C", dir, "-c", "user.name=Receipt Fixture", "-c", "user.email=receipt@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "private protocol", "--no-gpg-sign"]);
    const oldNode = process.env.T3_ACP_MCP_NODE, oldEntry = process.env.T3_ACP_MCP_ENTRYPOINT;
    process.env.T3_ACP_MCP_NODE = process.execPath; process.env.T3_ACP_MCP_ENTRYPOINT = shim;
    let hud;
    async function action(name) {
      const res = await fetch(hud.url + "/api/mission/" + name, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(4000) });
      assert.equal(res.status, 200);
      return res.json();
    }
    try {
      hud = await createMissionHudServer({ missionDir: dir, port: 0 });
      await action("approve");
      if (stale) {
        const state = k.loadState(dir), doc = k.loadFeaturesDoc(dir);
        for (const row of [state.activeWorker, state.sessions[0], doc.features[0]]) Object.assign(row, { workerPid: process.pid, daemonStateFile: "/unrelated/legacy-marker", daemonStatus: "running" });
        k.saveState(dir, state); k.saveFeaturesDoc(dir, doc);
      }
      for (const name of ["pause", "resume"]) {
        const body = await action(name);
        assert.equal(body.state.status, name === "pause" ? "paused" : "running");
        for (const row of projections(dir)) for (const key of localRuntimeKeys) assert.equal(Object.hasOwn(row, key), false);
      }
      for (const command of ["PauseWorkerRuntime", "ResumeWorkerRuntime"]) {
        let stdout = "", stderr = "";
        const result = await runCli([command, "--mission-dir", dir, "--json", JSON.stringify({ activeWorker: k.loadState(dir).activeWorker })], { stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } } });
        assert.equal(result.exitCode, 0, stderr);
        const response = JSON.parse(stdout);
        for (const key of localRuntimeKeys) assert.equal(Object.hasOwn(response, key), false);
      }
    } finally {
      await hud?.close();
      if (oldNode === undefined) delete process.env.T3_ACP_MCP_NODE; else process.env.T3_ACP_MCP_NODE = oldNode;
      if (oldEntry === undefined) delete process.env.T3_ACP_MCP_ENTRYPOINT; else process.env.T3_ACP_MCP_ENTRYPOINT = oldEntry;
    }
  });
}


for (const stale of [false, true]) {
  test("Remote controls without ACP reject without local metadata stale="+stale, async t => {
    const dir = fixture(t), oldNode = process.env.T3_ACP_MCP_NODE, oldEntry = process.env.T3_ACP_MCP_ENTRYPOINT;
    delete process.env.T3_ACP_MCP_NODE; delete process.env.T3_ACP_MCP_ENTRYPOINT;
    try {
      const worker = { ...receipt, runtimeTransport: "t3-delegate-task", ...(stale ? { workerPid: process.pid, daemonStateFile: path.join(dir, "missing-local-marker"), daemonStatus: "running" } : {}) };
      const rows = [];
      for (const command of ["PauseWorkerRuntime", "ResumeWorkerRuntime"]) {
        let stdout = "", stderr = "";
        const result = await runCli([command, "--mission-dir", dir, "--json", JSON.stringify({ activeWorker: worker })], { stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } } });
        rows.push({ result, response: JSON.parse(stdout || stderr) });
      }
      for (const row of rows) {
        assert.equal(row.response.ok, false);
        assert.equal(row.response.code, "NO_T3_TRANSPORT");
        for (const key of localRuntimeKeys) assert.equal(Object.hasOwn(row.response, key), false);
      }
    } finally {
      if (oldNode !== undefined) process.env.T3_ACP_MCP_NODE = oldNode;
      if (oldEntry !== undefined) process.env.T3_ACP_MCP_ENTRYPOINT = oldEntry;
    }
  });
}
test("Pausing an undispatched worker is a logical pause with no daemon metadata", async t => {
  const dir = fixture(t), oldNode = process.env.T3_ACP_MCP_NODE;
  delete process.env.T3_ACP_MCP_NODE;
  let stdout = "", stderr = "";
  try {
    const result = await runCli(["PauseWorkerRuntime", "--mission-dir", dir, "--json", JSON.stringify({ activeWorker: { dispatchPending: true } })], { stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } } });
    assert.equal(result.exitCode, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.paused, true);
    for (const key of localRuntimeKeys) assert.equal(Object.hasOwn(response, key), false);
  } finally { if (oldNode !== undefined) process.env.T3_ACP_MCP_NODE = oldNode; }
});


for (const refusal of ["accepted", "interrupted"]) {
  test("Default remote Pause preserves explicit "+refusal+" refusal", async t => {
    const dir = fixture(t, false), shim = path.join(dir, "private-acp.mjs");
    const negative = { [refusal]: false, code: "PROVIDER_BUSY" };
    fs.writeFileSync(shim, "const tool=process.argv[3];console.log(JSON.stringify(tool==='delegate_task'?"+JSON.stringify(receipt)+":tool==='t3_thread_interrupt'?"+JSON.stringify(negative)+":{delivery:'started'}));");
    cp.execFileSync("git", ["-C", dir, "add", "private-acp.mjs"]);
    cp.execFileSync("git", ["-C", dir, "-c", "user.name=Receipt Fixture", "-c", "user.email=receipt@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "private refusal protocol", "--no-gpg-sign"]);
    const oldNode = process.env.T3_ACP_MCP_NODE, oldEntry = process.env.T3_ACP_MCP_ENTRYPOINT;
    process.env.T3_ACP_MCP_NODE = process.execPath; process.env.T3_ACP_MCP_ENTRYPOINT = shim;
    let hud;
    try {
      hud = await createMissionHudServer({ missionDir: dir, port: 0 });
      const approve = await fetch(hud.url+"/api/mission/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(approve.status, 200);
      const before = missionBytes(dir);
      const paused = await fetch(hud.url+"/api/mission/pause", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await paused.json();
      assert.equal(paused.status, 409, JSON.stringify(body));
      assert.equal(body.code, "PROVIDER_BUSY");
      assertRejectedPause(dir, before);
      const saved = missionBytes(dir);
      const retry = await fetch(hud.url+"/api/mission/pause", { method: "POST", body: "{}" });
      assert.equal(retry.status, 409); assert.deepEqual(missionBytes(dir), saved);
    } finally {
      await hud?.close();
      if (oldNode === undefined) delete process.env.T3_ACP_MCP_NODE; else process.env.T3_ACP_MCP_NODE = oldNode;
      if (oldEntry === undefined) delete process.env.T3_ACP_MCP_ENTRYPOINT; else process.env.T3_ACP_MCP_ENTRYPOINT = oldEntry;
    }
  });
}
