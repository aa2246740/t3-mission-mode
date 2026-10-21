import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import * as kernel from "../kernel/index.mjs";
import { normalizeFeature, normalizeSlotConfig } from "../kernel/schema.mjs";
import { callMissionTool } from "../bridge/mcp-server.mjs";
import { createMissionHudServer, normalizeHudModelSettings } from "../hud/server.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingResult = { ok: true, dispatched: false, dispatchPending: true, runtimeTransport: "orchestrator-pending" };
const acceptedResult = { taskId: "fixture-task", childThreadId: "fixture-thread", runtimeTransport: "t3-delegate-task" };
const modelSettings = {
  worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", effort: 5, reasoningEffort: "max", options: { reasoningEffort: "max", serviceTier: "priority" } },
  validator: { providerInstanceId: "codex", model: "gpt-6.1-sol", effort: 2, reasoningEffort: "low" },
  skipScrutiny: true,
  skipUserTesting: true,
};
function fixture(t, features = [{ id: "f1" }, { id: "f2" }]) {
  const dir = fs.mkdtempSync("/private/tmp/t3-review-regression-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".mission/\n");
  execFileSync("git", ["init", "-q", dir]);
  kernel.proposeMission(dir, {
    repoPath: dir, title: "Review regressions", milestones: [{ id: "m1", title: "M1" }],
    features: features.map((f) => ({ title: f.id, milestoneId: "m1", ...f })), modelSettings,
  });
  return dir;
}
async function hud(t, dir, options = {}) {
  const server = await createMissionHudServer({
    missionDir: dir, port: 0, dispatchAdapter: {
      async runFeature() { return pendingResult; },
      async pauseWorker() { return { ok: true, paused: true }; },
      async resumeWorker() { return { ok: true, resumed: true }; },
    }, ...options,
  });
  t.after(() => server.close());
  return server;
}
async function post(server, action, body = {}) {
  const response = await fetch(`${server.url}/api/mission/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function runRecords(dir) {
  const state = kernel.loadState(dir);
  return [state.activeWorker, state.sessions.at(-1), kernel.loadFeaturesDoc(dir).features[0]];
}
async function bounded(promise, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for test event")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test("V01: repeated HUD approval preserves f1 and its run across mission statuses", async (t) => {
  for (const status of ["running", "orchestrator_turn", "paused"]) {
    await t.test(status, async (t) => {
      const dir = fixture(t);
      const server = await hud(t, dir);
      await post(server, "approve");
      const original = kernel.loadState(dir);
      original.status = status;
      kernel.saveState(dir, original);
      const revision = original.revision;
      kernel.approveMissionPlan(dir);
      assert.equal(kernel.loadState(dir).status, status);
      assert.equal(kernel.loadState(dir).revision, revision);
      const calls = [];
      const state = await callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: {
        async runFeature(feature) { calls.push(feature.id); return acceptedResult; },
      } });
      assert.deepEqual(calls, ["f1"]);
      assert.equal(state.activeWorker.runId, original.activeWorker.runId);
      assert.equal(state.sessions.length, 1);
      assert.deepEqual(kernel.loadFeaturesDoc(dir).features.map((f) => f.status), ["running", "pending"]);
      state.status = "orchestrator_turn";
      kernel.saveState(dir, state);
      await kernel.startMissionRun(dir, {}, { runFeature() { assert.fail("active f1 must block f2 dispatch"); } });
    });
  }
});

test("V02: rejected, throwing, pending and unconfirmed upgrades remain retryable on disk", async (t) => {
  const cases = [
    ["throw", () => { throw new Error("transport unavailable"); }, true],
    ...["ok", "accepted", "started", "canStart", "dispatched"].map((key) =>
      [key, () => ({ [key]: false, taskId: "must-not-attach" }), true]),
    ["blocked", () => ({ blocked: true }), true],
    ["nested rejection", () => ({ response: { accepted: false, taskId: "must-not-attach" } }), true],
    ["outer rejection", () => ({ ok: false, response: { ok: true, taskId: "must-not-attach" } }), true],
    ["pending", () => pendingResult, false],
    ["pending with identity", () => ({ ...pendingResult, ...acceptedResult }), false],
    ["unconfirmed", () => ({ ok: true, worktreePath: "/private/tmp" }), false],
  ];
  for (const [name, result, rejects] of cases) {
    await t.test(name, async (t) => {
      const dir = fixture(t);
      const server = await hud(t, dir);
      await post(server, "approve");
      const runId = kernel.loadState(dir).activeWorker.runId;
      const first = callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: {
        async runFeature() {
          for (const entry of runRecords(dir)) assert.equal(entry.dispatchPending, true);
          return result();
        },
      } });
      if (rejects) await assert.rejects(first);
      else await first;
      for (const entry of runRecords(dir)) {
        assert.equal(entry.dispatchPending, true);
        assert.equal(entry.taskId, undefined);
      }
      let retries = 0;
      const state = await callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: {
        async runFeature() { retries++; return acceptedResult; },
      } });
      assert.equal(retries, 1);
      assert.equal(state.activeWorker.runId, runId);
      assert.equal(state.sessions.length, 1);
      for (const entry of runRecords(dir)) {
        assert.equal(entry.dispatchPending, undefined);
        assert.equal(entry.taskId, "fixture-task");
      }
    });
  }
});

test("V03: StartMissionRun dispatches paused and HUD-resumed pending runs through runFeature", async (t) => {
  for (const viaHudResume of [false, true]) {
    await t.test(viaHudResume ? "HUD resumed" : "paused", async (t) => {
      const dir = fixture(t);
      const server = await hud(t, dir, { dispatchAdapter: {
        async runFeature() { return pendingResult; },
        async pauseWorker() { return { ok: true, paused: true }; },
        async resumeWorker() { assert.fail("HUD must defer an undispatched worker to StartMissionRun"); },
      } });
      await post(server, "approve");
      await post(server, "pause");
      if (viaHudResume) assert.equal((await post(server, "resume")).status, 200);
      const runId = kernel.loadState(dir).activeWorker.runId;
      let dispatches = 0;
      const state = await callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: {
        async runFeature() { dispatches++; return acceptedResult; },
        async resumeWorker() { assert.fail("undispatched workers have no child to resume"); },
      } });
      assert.equal(dispatches, 1);
      assert.equal(state.status, "running");
      assert.equal(state.activeWorker.runId, runId);
      for (const entry of runRecords(dir)) {
        assert.equal(entry.status, "running");
        assert.equal(entry.resumePending, undefined);
        assert.equal(entry.dispatchPending, undefined);
      }
    });
  }
});

test("V04: webhook sees committed disk state, can start f1, and cannot hold approval open", async (t) => {
  const dir = fixture(t);
  let received, release;
  const arrived = new Promise((resolve) => { received = resolve; });
  const hook = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      release = () => res.end("{}");
      received({ event: JSON.parse(raw), state: kernel.loadState(dir), logs: kernel.readProgressLog(dir) });
    });
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  t.after(() => { hook.closeAllConnections(); return new Promise((resolve) => hook.close(resolve)); });
  const server = await hud(t, dir, { notifyUrl: `http://127.0.0.1:${hook.address().port}` });
  const approval = post(server, "approve");
  const observed = await bounded(arrived);
  assert.equal(observed.state.planAccepted, true);
  assert.equal(observed.event.state.planAccepted, true);
  assert.ok(observed.logs.some((entry) => entry.type === "plan_approved"));
  const state = await callMissionTool("StartMissionRun", { missionDir: dir }, { dispatchAdapter: {
    async runFeature() { return acceptedResult; },
  } });
  assert.equal(state.activeWorker.featureId, "f1");
  // The webhook response is still held while the HUD request must finish.
  assert.equal((await bounded(approval, 500)).status, 200);
  release();
});

test("V04/V05: onCommand veto rolls back rejection and emits no webhook", async (t) => {
  const dir = fixture(t);
  const original = kernel.loadState(dir);
  let hooks = 0;
  const hook = http.createServer((req, res) => { hooks++; req.resume(); res.end("{}"); });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  t.after(() => { hook.closeAllConnections(); return new Promise((resolve) => hook.close(resolve)); });
  const server = await hud(t, dir, {
    notifyUrl: `http://127.0.0.1:${hook.address().port}`,
    onCommand() { throw new Error("veto"); },
  });
  assert.equal((await post(server, "reject", { feedback: "split f1" })).status, 500);
  assert.deepEqual(kernel.loadState(dir), original);
  assert.equal(kernel.readProgressLog(dir).some((entry) => entry.type === "plan_rejected"), false);
  await delay(25);
  assert.equal(hooks, 0);
});

test("V05/V06: HUD rejection wakes a waiter; later slot edits do not replay the old rejection", async (t) => {
  const dir = fixture(t);
  const commands = [];
  const server = await hud(t, dir, { onCommand(command) { commands.push(command); } });
  const waiting = callMissionTool("WaitForApproval", { missionDir: dir, timeoutMs: 1000, pollMs: 5 });
  const rejected = await post(server, "reject", { reason: "Split f1" });
  assert.equal(rejected.status, 200);
  assert.equal((await waiting).event, "plan_rejected");
  assert.equal(rejected.body.state.status, "planning");
  assert.equal(rejected.body.state.planAccepted, false);
  assert.equal(rejected.body.state.lastPlanFeedback, "Split f1");
  assert.equal(rejected.body.state.rejectionRevision, rejected.body.state.revision);
  assert.ok(rejected.body.state.lastPlanRejectedAt);
  assert.equal(commands[0].type, "reject");
  const nextWait = callMissionTool("WaitForApproval", { missionDir: dir, timeoutMs: 100, pollMs: 5 });
  assert.equal((await post(server, "model-slots", { worker: { effort: 2 } })).status, 200);
  assert.equal((await nextWait).event, "timeout");
  const again = callMissionTool("WaitForApproval", { missionDir: dir, timeoutMs: 1000, pollMs: 5 });
  await delay(20);
  const kernelRejected = kernel.rejectMissionPlan(dir, "Split f1");
  assert.equal(kernelRejected.rejectionRevision, kernelRejected.revision);
  assert.equal((await again).event, "plan_rejected");
});

test("V05: the rendered Request Changes button posts optional feedback", async () => {
  const app = fs.readFileSync(new URL("../hud/public/app.js", import.meta.url), "utf8")
    .replace("export function applySnapshot", "function applySnapshot").replace(/initHud\(\);\s*$/, "");
  const listeners = new Map();
  const card = {
    innerHTML: "", classList: { add() {}, remove() {} },
    querySelector(selector) {
      if (selector === "#plan-feedback") return { value: "Split f1" };
      return { addEventListener(type, handler) { listeners.set(`${selector}:${type}`, handler); } };
    },
  };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById(id) { return id === "plan-approval-card" ? card : null; } },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
    console, setTimeout, clearTimeout,
  });
  vm.runInContext(app, context);
  vm.runInContext('renderCenterColumn({initialized:true,state:{initialized:true,status:"awaiting_input",planAccepted:false},features:[]})', context);
  assert.match(card.innerHTML, /id="btn-reject-plan" data-action="reject-plan"/);
  await listeners.get("#btn-reject-plan:click")();
  assert.deepEqual(requests, [{ url: "/api/mission/reject", body: { feedback: "Split f1" } }]);
});

test("V07/V08: sparse feature overrides inherit the actual role slot in kernel and HUD", async (t) => {
  const cases = [
    ["options target", { workerTarget: { options: { serviceTier: "standard" } } }, { provider: "codex", model: "gpt-6.1-sol", effort: "max", tier: "standard" }],
    ["validator model", { kind: "scrutiny", target: { model: "gpt-6.1-sol" } }, { provider: "codex", model: "gpt-6.1-sol", effort: "low" }],
    ["provider only", { providerInstanceId: "acpRegistry_cursor" }, { provider: "acpRegistry_cursor", model: "gpt-6.1-sol", effort: "max" }],
    ["effort only", { effort: 2 }, { provider: "codex", model: "gpt-6.1-sol", effort: "low" }],
    ["reasoning only", { reasoningEffort: "xhigh" }, { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" }],
    ["options only", { options: { serviceTier: "standard" } }, { provider: "codex", model: "gpt-6.1-sol", effort: "max", tier: "standard" }],
    ["fixed tier", { target: "gemini-4-argon-high" }, { provider: "antigravity", model: "gemini-4-argon-high", effort: undefined }],
  ];
  for (const [name, override, expected] of cases) {
    await t.test(name, async (t) => {
      const dir = fixture(t, [{ id: "f1", ...override }]);
      const feature = kernel.loadFeaturesDoc(dir).features[0];
      if (override.workerTarget) assert.deepEqual(feature.workerTarget, override.workerTarget);
      if (override.target && typeof override.target === "object") assert.deepEqual(feature.target, override.target);
      const resolved = kernel.resolveFeatureSlot(feature, kernel.loadModelSettings(dir)).slotConfig;
      const server = await hud(t, dir);
      const approved = await post(server, "approve");
      assert.equal(approved.status, 200);
      for (const slot of [resolved, approved.body.state.activeWorker]) {
        assert.equal(slot.providerInstanceId, expected.provider);
        assert.equal(slot.model, expected.model);
        assert.equal(slot.options.reasoningEffort, expected.effort);
        if (expected.tier) assert.equal(slot.options.serviceTier, expected.tier);
      }
    });
  }
  assert.deepEqual(normalizeFeature({ target: { model: "gpt-6.1-sol" } }).target, { model: "gpt-6.1-sol" });
  for (const override of [{ model: "gpt-6.1-sol" }, "gpt-6.1-sol"]) {
    assert.equal(normalizeSlotConfig(override, modelSettings.worker).reasoningEffort, "max");
    assert.equal(normalizeHudModelSettings({ worker: override }, modelSettings).worker.reasoningEffort, "max");
  }
});

test("V09: failed, rejected, pending, and unconfirmed initial dispatches remain retryable without attaching rejected identity", async (t) => {
  for (const [label, fn, shouldReject] of [
    ["throw", () => { throw new Error("initial dispatch unavailable"); }, true],
    ["rejected", () => ({ ok: false, accepted: false, dispatched: false, code: "PROVIDER_BUSY", taskId: "must-not-attach" }), true],
    ["pending", () => pendingResult, false],
    ["unconfirmed", () => ({ ok: true }), false],
  ]) {
    await t.test(label, async (t) => {
      const dir = fixture(t);
      kernel.approveMissionPlan(dir);
      const first = callMissionTool("StartMissionRun", { missionDir: dir }, {
        dispatchAdapter: { async runFeature() { return fn(); } },
      });
      if (shouldReject) await assert.rejects(first);
      else await first;
      for (const entry of runRecords(dir)) {
        assert.equal(entry.dispatchPending, true);
        assert.equal(entry.taskId, undefined);
      }
      let retries = 0;
      const retried = await callMissionTool("StartMissionRun", { missionDir: dir }, {
        dispatchAdapter: { async runFeature() { retries++; return acceptedResult; } },
      });
      assert.equal(retries, 1);
      assert.equal(retried.activeWorker.taskId, acceptedResult.taskId);
      assert.equal(retried.sessions.length, 1);
    });
  }
});

test("V10 & V11: pending upgrade records effective slot metadata and honors user pause during in-flight dispatch", async (t) => {
  const dir = fixture(t);
  const server = await hud(t, dir);
  await post(server, "approve");
  await post(server, "model-slots", {
    worker: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", effort: 3 },
  });
  let enterResolve;
  let releaseResolve;
  const entered = new Promise((r) => { enterResolve = r; });
  const release = new Promise((r) => { releaseResolve = r; });
  let pauseCalls = 0;
  let dispatchedSlot = null;
  const runPromise = callMissionTool("StartMissionRun", { missionDir: dir }, {
    dispatchAdapter: {
      async runFeature(_f, slot) {
        dispatchedSlot = slot;
        enterResolve();
        await release;
        return acceptedResult;
      },
      async pauseWorker() {
        pauseCalls++;
        return { ok: true, paused: true };
      },
    },
  });
  await entered;
  const pauseRes = await post(server, "pause");
  assert.equal(pauseRes.status, 200);
  releaseResolve();
  const finalState = await runPromise;
  assert.equal(finalState.status, "paused");
  assert.equal(finalState.activeWorker.status, "paused");
  assert.equal(pauseCalls, 1);
  for (const rec of [finalState.activeWorker, finalState.sessions.at(-1)]) {
    assert.equal(rec.providerInstanceId, dispatchedSlot.providerInstanceId);
    assert.equal(rec.model, dispatchedSlot.model);
    assert.deepEqual(rec.options, dispatchedSlot.options);
  }
});

test("V12: Request Changes feedback draft survives inspecting features/sessions before submission", async () => {
  const app = fs.readFileSync(new URL("../hud/public/app.js", import.meta.url), "utf8")
    .replace("export function applySnapshot", "function applySnapshot").replace(/initHud\(\);\s*$/, "");
  const listeners = new Map();
  let inputVal = "";
  const inputEl = {
    get value() { return inputVal; },
    set value(v) { inputVal = v; },
    addEventListener(type, handler) { listeners.set(`#plan-feedback:${type}`, handler); },
  };
  const card = {
    innerHTML: "",
    classList: { add() {}, remove() {} },
    querySelector(selector) {
      if (selector === "#plan-feedback") return inputEl;
      return { addEventListener(type, handler) { listeners.set(`${selector}:${type}`, handler); } };
    },
  };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById(id) { return id === "plan-approval-card" ? card : null; } },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
    console, setTimeout, clearTimeout,
  });
  vm.runInContext(app, context);
  vm.runInContext("renderCenterColumn({initialized:true,state:{initialized:true,status:\"awaiting_input\",planAccepted:false},features:[{id:\"f1\",title:\"Feature 1\",status:\"pending\"}]})", context);
  inputEl.value = "Draft feedback must survive inspecting feature 1.";
  listeners.get("#plan-feedback:input")?.({ target: inputEl });
  vm.runInContext("hudState.selectedSessionId = \"worker-1\"; renderCenterColumn({initialized:true,state:{initialized:true,status:\"awaiting_input\",planAccepted:false},features:[{id:\"f1\",title:\"Feature 1\",status:\"pending\"}]})", context);
  assert.equal(inputEl.value, "Draft feedback must survive inspecting feature 1.");
  await listeners.get("#btn-reject-plan:click")();
  assert.deepEqual(requests, [{ url: "/api/mission/reject", body: { feedback: "Draft feedback must survive inspecting feature 1." } }]);
  assert.equal(vm.runInContext("hudState.planFeedbackDraft", context), "");
  assert.equal(inputEl.value, "");
  // V13: transition to planning after reject, then propose revised plan (awaiting_input) -> feedback input must be empty
  vm.runInContext("renderCenterColumn({initialized:true,state:{initialized:true,status:\"planning\",planAccepted:false},features:[{id:\"f1\",title:\"Feature 1\",status:\"pending\"}]})", context);
  vm.runInContext("renderCenterColumn({initialized:true,state:{initialized:true,status:\"awaiting_input\",planAccepted:false},features:[{id:\"f1\",title:\"Feature 1 v2\",status:\"pending\"}]})", context);
  assert.equal(inputEl.value, "");
  assert.equal(vm.runInContext("hudState.planFeedbackDraft", context), "");
});
