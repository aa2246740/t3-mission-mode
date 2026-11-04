import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import cp from "node:child_process";
import {
  createMissionHudServer,
  inspectRepoAgentReadiness,
  resolveLiveT3McpEnv,
} from "../hud/server.mjs";
import {
  readRecentObservations,
  buildThreadFeed,
  normalizeFeedEvent,
  normalizeThreadMessages,
} from "../hud/thread-feed.mjs";
import { startElapsedClock, stopElapsedClock } from "../kernel/elapsed.mjs";
import { applyAutopilotCommand } from "../kernel/autopilot-commands.mjs";
import {
  proposeMission,
  approveMissionPlan,
  loadState,
  saveState,
  loadFeaturesDoc,
  loadModelSettings,
} from "../kernel/index.mjs";
import { selectFeatureForWorker } from "../kernel/runner.mjs";

const html = fs.readFileSync(new URL("../hud/public/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../hud/public/styles.css", import.meta.url), "utf8");
const source = fs
  .readFileSync(new URL("../hud/public/app.js", import.meta.url), "utf8")
  .replace(/^export /m, "       ")
  .replace(/^initHud\(\);/m, "          ");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hud-redesign-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function setTestEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  function apply(env) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  apply(values);
  t.after(() => apply(previous));
}

function element() {
  const classes = new Set();
  const attributes = new Map();
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
  };
}

function client() {
  const elements = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]),
  );
  let now = Date.parse("2026-11-04T00:00:10Z");
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) || null },
    Date: Clock,
    URLSearchParams,
  });
  vm.runInContext(source, context);
  return {
    elements,
    context,
    advance: (ms) => {
      now += ms;
    },
    run: (code) => vm.runInContext(code, context),
  };
}

function snapshot(overrides = {}) {
  return {
    initialized: true,
    features: [],
    progressLog: [],
    state: {
      missionId: "fixture",
      title: "Plan",
      status: "awaiting_input",
      planAccepted: false,
      milestones: [],
      assertions: [],
      sessions: [],
      ...overrides,
    },
  };
}

test("readiness matches canonical repository paths and the newest valid official report", (t) => {
  const root = temporary(t),
    repo = path.join(root, "repo"),
    reports = path.join(root, "reports");
  fs.mkdirSync(repo);
  const alias = path.join(root, "alias");
  fs.symlinkSync(repo, alias);
  writeJson(path.join(reports, "key", "older.json"), {
    repository: { root: repo },
    createdAt: "2026-11-01",
    summary: { achievedLevel: 2, overallProgress: { percentComplete: 30 } },
  });
  const reportPath = path.join(reports, "key", "latest.json");
  writeJson(reportPath, {
    repository: { root: alias },
    createdAt: "2026-11-03",
    summary: { achievedLevel: 5, overallProgress: { percentComplete: 82.4324324324 } },
  });
  writeJson(path.join(reports, "wrong.json"), {
    repository: { root },
    createdAt: "2026-11-04",
    level: 5,
    score: 100,
  });
  writeJson(path.join(reports, "broken.json"), {
    repository: { root: repo },
    createdAt: "2026-11-05",
    level: 6,
    score: 110,
  });
  fs.writeFileSync(path.join(reports, "invalid.json"), "{");
  const result = inspectRepoAgentReadiness(repo, { stateDir: reports });
  assert.equal(result.evaluated, true);
  assert.equal(result.level, 5);
  assert.equal(result.score, 82.4324324324);
  assert.equal(result.reportPath, reportPath);
  assert.equal(result.recommendation, null);
});

test("missing, local, mismatched and embedded readiness remain non-blocking", (t) => {
  const root = temporary(t),
    stateDir = path.join(root, "absent"),
    missionDir = path.join(root, ".mission");
  const empty = inspectRepoAgentReadiness(root, { stateDir });
  assert.deepEqual(
    [empty.evaluated, empty.level, empty.score, empty.reportPath],
    [false, null, null, null],
  );
  assert.match(empty.recommendation, /\/agent-readiness/);
  writeJson(path.join(missionDir, "readiness.json"), { level: 2, score: 35 });
  assert.equal(inspectRepoAgentReadiness(root, { stateDir }).level, 2);
  writeJson(path.join(missionDir, "readiness.json"), {
    repoPath: "/different-repo",
    level: 5,
    score: 99,
  });
  assert.equal(inspectRepoAgentReadiness(root, { stateDir }).evaluated, false);
  assert.equal(
    inspectRepoAgentReadiness(root, { stateDir, embedded: { level: 3, score: 59 } }).score,
    59,
  );
});

test("repository readiness archive is a fallback after official state and before Mission metadata", (t) => {
  const repo = temporary(t);
  const stateDir = path.join(repo, "external-state");
  const archived = path.join(repo, "reports", "readiness", "latest.json");
  writeJson(archived, { repository: { root: repo }, level: 5, score: 82.4 });
  writeJson(path.join(repo, ".mission", "readiness.json"), { level: 2, score: 35 });
  assert.equal(inspectRepoAgentReadiness(repo, { stateDir }).reportPath, archived);
  assert.equal(inspectRepoAgentReadiness(repo, { stateDir }).score, 82.4);
  const official = path.join(stateDir, "official.json");
  writeJson(official, { repository: { root: repo }, level: 4, score: 70 });
  assert.equal(inspectRepoAgentReadiness(repo, { stateDir }).reportPath, official);
  fs.rmSync(official);
  writeJson(archived, { repoPath: "/foreign", level: 5, score: 99 });
  assert.equal(inspectRepoAgentReadiness(repo, { stateDir }).level, 2);
  fs.writeFileSync(archived, "{");
  assert.equal(inspectRepoAgentReadiness(repo, { stateDir }).level, 2);
});

for (const [score, tone, callout] of [
  [82.4, "high", false],
  [60, "medium", false],
  [59, "medium", true],
  [40, "medium", true],
  [39.9, "low", true],
]) {
  test(`readiness badge at ${score}% uses ${tone} and the correct recommendation`, () => {
    const ui = client();
    ui.context.data = { readiness: { evaluated: true, score, level: 3 } };
    ui.run("renderReadiness(data)");
    const badge = ui.elements.get("readiness-badge");
    assert.equal(badge.dataset.readinessState, tone);
    assert.equal(badge.textContent, `Readiness: Level 3 · ${score.toFixed(1)}%`);
    assert.equal(ui.elements.get("readiness-callout").classList.contains("hidden"), !callout);
  });
}

test("unevaluated badge recommends an assessment and tolerates missing optional DOM", () => {
  const ui = client();
  ui.run("renderReadiness({})");
  assert.match(
    ui.elements.get("readiness-badge").textContent,
    /Not Evaluated.*Recommend \/agent-readiness/,
  );
  ui.elements.clear();
  assert.doesNotThrow(() =>
    ui.run("renderReadiness({}); renderBoardDisclosure({state:{assertions:[]}})"),
  );
});

for (const [name, fields] of [
  ["plan approval", { planApprovedAt: "2026-11-04T00:00:05Z" }],
  [
    "worker start",
    { planApprovedAt: "2026-11-04T00:00:00Z", activeWorker: { startedAt: "2026-11-04T00:00:05Z" } },
  ],
  [
    "explicit clock",
    { lastStartedAt: "2026-11-04T00:00:05Z", activeWorker: { startedAt: "2026-11-04T00:00:00Z" } },
  ],
]) {
  test(`elapsed time ticks from ${name} and stops when paused`, () => {
    const ui = client();
    ui.context.state = { status: "running", elapsedMs: 1000, lastStartedAt: null, ...fields };
    assert.equal(ui.run("computeLiveElapsedMs(state)"), 6000);
    ui.advance(1000);
    assert.equal(ui.run("formatDurationHms(computeLiveElapsedMs(state))"), "00:00:07");
    ui.run('state.status = "paused"');
    assert.equal(ui.run("computeLiveElapsedMs(state)"), 1000);
  });
}

test("missing and damaged start timestamps still tick without resetting on snapshots", () => {
  const ui = client();
  ui.context.data = snapshot({
    status: "orchestrator_turn",
    elapsedMs: 2000,
    lastStartedAt: "invalid",
  });
  ui.run("renderTopBar(data)");
  ui.advance(2000);
  ui.run("renderTopBar(data)");
  assert.equal(ui.elements.get("metric-time").textContent, "00:00:04");
  assert.equal(ui.elements.get("elapsed-metric").classList.contains("is-ticking"), true);
  ui.run('data.state.status = "paused"; renderTopBar(data)');
  ui.advance(9000);
  ui.run('data.state.status = "running"; renderTopBar(data)');
  assert.equal(ui.elements.get("metric-time").textContent, "00:00:02");
});

test("views and filters preserve every feature and assertion, including collapsed milestones", () => {
  const ui = client();
  const data = snapshot({
    status: "running",
    planAccepted: true,
    milestones: [{ id: "m1", title: "Closed" }],
  });
  data.features = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i}`,
    title: `Feature ${i}`,
    milestoneId: "m1",
    status: "completed",
    fulfills: [`VAL-${i}`],
  }));
  data.state.assertions = data.features.map((f, i) => ({
    id: `VAL-${i}`,
    milestoneId: "m1",
    status: "passed",
  }));
  ui.context.data = data;
  ui.run("hudState.snapshot = data; renderCenterColumn(data)");
  assert.match(ui.elements.get("features-list").innerHTML, /milestone-swimlane collapsed/);
  const features = ui.elements.get("features-list").innerHTML;
  const assertions = ui.elements.get("assertions-list").innerHTML;
  assert.equal((features.match(/data-feature-id=/g) || []).length, 12);
  assert.equal((assertions.match(/data-assertion-id=/g) || []).length, 12);
  assert.equal(ui.elements.get("assertions-list").classList.contains("is-collapsed-drawer"), true);
  ui.run(
    'hudState.boardTab = "contract"; hudState.assertionFilter = "failed"; renderCenterColumn(data)',
  );
  assert.equal(ui.elements.get("features-section").classList.contains("tab-hidden"), true);
  assert.equal(ui.elements.get("assertions-list").dataset.assertionFilter, "failed");
  assert.equal(ui.elements.get("features-list").innerHTML, features);
  assert.equal(ui.elements.get("assertions-list").innerHTML, assertions);
  ui.run('hudState.expandedMilestones.add("m1"); renderFeaturesAndAssertions(data)');
  assert.doesNotMatch(ui.elements.get("features-list").innerHTML, /milestone-swimlane collapsed/);
  ui.run(
    'hudState.expandedMilestones.clear(); data.state.activeWorker = {featureId: "f0"}; renderFeaturesAndAssertions(data)',
  );
  assert.doesNotMatch(ui.elements.get("features-list").innerHTML, /milestone-swimlane collapsed/);
});

test("approval feedback and actions share a styled, accessible composer", () => {
  const ui = client();
  ui.context.data = snapshot();
  ui.run("renderCenterColumn(data)");
  const markup = ui.elements.get("plan-approval-card").innerHTML;
  assert.match(markup, /class="approval-feedback-group"/);
  assert.match(markup, /id="plan-feedback" type="text" class="plan-feedback-input"/);
  assert.match(markup, /id="btn-reject-plan" data-action="reject-plan"/);
  assert.ok(markup.indexOf('id="plan-feedback"') < markup.indexOf('id="btn-approve"'));
  assert.match(css, /min-height: 38px;/);
  assert.match(css, /padding: 8px 12px;/);
  assert.match(css, /#plan-feedback:focus/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("observations accept both journals and actual Autopilot archives, ignoring partial tails", (t) => {
  const root = temporary(t);
  writeJson(path.join(root, "autopilot", "observations", "aa.json"), {
    sequence: 1,
    observation: { type: "task_status", runId: "r1", response: { message: "Checking files" } },
  });
  fs.writeFileSync(
    path.join(root, "observations.jsonl"),
    '{"type":"command","runId":"r1","command":"npm test"}\n{"partial":',
  );
  fs.writeFileSync(
    path.join(root, "autopilot", "observations.jsonl"),
    '{"type":"message","runId":"r2","message":"Another run"}\n',
  );
  const rows = readRecentObservations(root);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].response.message, "Checking files");
  const feed = buildThreadFeed({ sessions: [] }, rows, []);
  assert.deepEqual(
    new Set(feed.map((row) => row.message)),
    new Set(["Checking files", "npm test", "Another run"]),
  );
});

test("bounded journals keep their recent complete observations", (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, "observations.jsonl"),
    Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({ type: "message", message: `event ${i}` }),
    ).join("\n") + "\n",
  );
  const rows = readRecentObservations(root);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].message, "event 30");
  assert.equal(rows.at(-1).message, "event 79");
});

test("observations without timestamps stay visible after fifty older lifecycle events", (t) => {
  const root = temporary(t);
  fs.writeFileSync(
    path.join(root, "observations.jsonl"),
    '{"type":"message","message":"Newest observation"}\n',
  );
  const events = Array.from({ length: 50 }, (_, index) => ({
    type: "event",
    message: `Older event ${index}`,
    timestamp: "2026-01-01T00:00:00Z",
  }));
  const feed = buildThreadFeed({ sessions: [] }, readRecentObservations(root), events);
  assert.equal(feed.length, 50);
  assert.equal(feed.at(-1).message, "Newest observation");
});

test("session inspector includes the current run's activity and escapes agent content", () => {
  const ui = client();
  const data = snapshot({
    status: "running",
    planAccepted: true,
    sessions: [
      {
        runId: "r1",
        role: "Validator",
        featureId: "f1",
        title: "Audit",
        status: "running",
        childThreadId: "thread1",
        taskBrief: "Check changes",
      },
    ],
  });
  data.threadFeed = [
    { runId: "r1", type: "tool_call", message: "<script>unsafe</script>" },
    { runId: "old", featureId: "f1", message: "Old attempt" },
    { type: "model_slots_updated", message: "Hidden" },
  ];
  ui.context.data = data;
  ui.run('hudState.selectedSessionId = "r1"; renderCenterColumn(data)');
  const inspector = ui.elements.get("session-handoff-view").innerHTML;
  assert.match(inspector, /Live Thread &amp; Agent Activity/);
  assert.match(inspector, /Check changes/);
  assert.match(
    inspector,
    /<a class="strip-btn thread-open-link" id="btn-open-thread-uri" href="t3-thread:\/\/v1\/thread1">↗ Open Thread<\/a>/,
  );
  assert.match(inspector, /id="session-steer-bar"/);
  assert.match(inspector, /id="session-steer-input"/);
  assert.match(inspector, /id="btn-steer-session"[^>]*disabled/);
  assert.match(inspector, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(inspector, /Old attempt|model_slots_updated/);
});

test("overview merges the active thread activity and shows eight running events or three idle events", () => {
  const ui = client();
  const data = snapshot({
    status: "running",
    sessions: [
      { runId: "r0", featureId: "f1", childThreadId: "old", status: "completed" },
      { runId: "r1", featureId: "f1", childThreadId: "live", status: "running" },
      { runId: "r2", featureId: "f2", childThreadId: "other", status: "completed" },
    ],
    activeWorker: { runId: "r1", featureId: "f1", childThreadId: "live", status: "running" },
  });
  data.threadFeed = [
    { type: "run_started", message: "Run started", timestamp: "2026-11-04T00:00:00Z" },
  ];
  ui.context.data = data;
  ui.context.events = Array.from({ length: 12 }, (_, index) => ({
    type: index % 2 ? "command_execution" : "reasoning",
    message: `Live event ${index}`,
    timestamp: new Date(Date.parse("2026-11-04T00:00:00Z") + (index + 1) * 1000).toISOString(),
  }));
  ui.run(`hudState.threadFeeds.set("r1:live", {events});
    hudState.threadFeeds.set("r0:old", {events:[{message:"Old attempt"}]});
    hudState.threadFeeds.set("r2:other", {events:[{message:"Other thread"}]});`);
  const compact = ui.run("renderActivityFeed(data)");
  assert.equal((compact.match(/data-feed-type=/g) || []).length, 8);
  assert.match(compact, /Live event 11/);
  assert.doesNotMatch(compact, /Old attempt|Other thread|Run started|Live event 3/);
  ui.run("hudState.streamExpanded = true");
  const expanded = ui.run("renderActivityFeed(data)");
  assert.match(expanded, /Compact \(8\)/);
  assert.match(expanded, /Run started/);
  assert.equal((expanded.match(/data-feed-type=/g) || []).length, 13);
  ui.run(
    'hudState.streamExpanded = false; data.state.status = "completed"; data.state.activeWorker = null',
  );
  const idle = ui.run("renderActivityFeed(data)");
  assert.match(idle, /Other thread/);
  ui.run("data.state.sessions.pop()");
  const recent = ui.run("renderActivityFeed(data)");
  assert.equal((recent.match(/data-feed-type=/g) || []).length, 3);
  assert.doesNotMatch(recent, /Run started|Live event 8/);
  assert.match(recent, /Live event 9/);
  ui.run("hudState.streamExpanded = true");
  assert.match(ui.run("renderActivityFeed(data)"), /Compact \(3\)/);
});

for (const selectedSessionId of ["orchestrator", "r1"]) {
  test(`${selectedSessionId} selection fetches live activity and updates its visible feed`, async () => {
    const ui = client();
    ui.context.data = snapshot({
      status: "running",
      planAccepted: true,
      activeWorker: { runId: "r1", featureId: "f1", childThreadId: "live", status: "running" },
    });
    ui.context.selection = selectedSessionId;
    ui.run("hudState.snapshot = data; hudState.selectedSessionId = selection");
    const card = element();
    const toggle = element();
    ui.elements.get("orchestrator-stream").querySelector = (selector) =>
      selector === ".live-agent-feed-card"
        ? card
        : selector === "#btn-toggle-stream"
          ? toggle
          : null;
    ui.elements.set("session-live-activity", card);
    const calls = [];
    ui.context.fetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({ events: [{ type: "reasoning", message: "Inspecting <changes>" }] }),
      };
    };
    await ui.run("refreshSelectedThread()");
    assert.equal(calls.length, 1);
    const params = new URL(calls[0], "http://localhost").searchParams;
    assert.equal(params.get("threadId"), "live");
    assert.equal(params.get("sessionId"), "r1");
    assert.match(card.outerHTML, /Inspecting &lt;changes&gt;/);
    assert.equal(ui.run('hudState.threadFeeds.get("r1:live").events.length'), 1);
    if (selectedSessionId === "orchestrator") {
      assert.equal(typeof toggle.listeners.click, "function");
      toggle.listeners.click();
      assert.equal(ui.run("hudState.streamExpanded"), true);
    }
  });
}

for (const [name, state, expectedReads] of [
  ["running", { status: "running" }, 1],
  ["orchestrator turn", { status: "orchestrator_turn" }, 1],
  ["bound worker", { status: "paused", activeWorker: { childThreadId: "live" } }, 1],
  ["idle", { status: "completed" }, 0],
]) {
  test(`elapsed ticker polls ${name} activity after two seconds without a new snapshot`, async () => {
    const ui = client();
    ui.context.data = snapshot({
      ...state,
      sessions: [{ runId: "r1", featureId: "f1", childThreadId: "live", status: "running" }],
    });
    ui.run(
      "hudState.snapshot = data; bindStaticListeners = () => {}; connectSseStream = () => {};",
    );
    const intervals = [];
    ui.context.setInterval = (callback, delay) => intervals.push({ callback, delay });
    const reads = [];
    ui.context.fetch = async (url) => {
      if (url === "/api/mission/state") return { ok: false };
      reads.push(url);
      return { ok: true, json: async () => ({ events: [] }) };
    };
    await ui.run("initHud()");
    const tick = intervals.find((timer) => timer.delay === 1000).callback;
    tick();
    assert.equal(reads.length, 0);
    ui.advance(1000);
    tick();
    assert.equal(reads.length, expectedReads);
    assert.match(ui.elements.get("metric-time").textContent, /^\d{2}:\d{2}:\d{2}$/);
    await ui.run("Promise.resolve()");
  });
}

test("thread jump links support session URIs and the Mission owner, with escaped attributes", () => {
  const ui = client();
  ui.context.data = snapshot({
    status: "running",
    planAccepted: true,
    ownerThreadId: "owner",
    sessions: [{ runId: "r1", link: 't3-thread://v1/thread1?label="quoted"', status: "paused" }],
  });
  ui.run('hudState.snapshot = data; hudState.selectedSessionId = "r1"; renderCenterColumn(data)');
  assert.match(
    ui.elements.get("session-handoff-view").innerHTML,
    /href="t3-thread:\/\/v1\/thread1\?label=&quot;quoted&quot;"/,
  );
  ui.run('hudState.selectedSessionId = "orchestrator"; renderCenterColumn(data)');
  assert.match(
    ui.elements.get("orchestrator-stream").innerHTML,
    /id="btn-open-thread-uri" href="t3-thread:\/\/v1\/owner"/,
  );
  assert.equal(ui.run('sessionThreadUri({link:"javascript:alert(1)"})'), null);
});

test("feature-only sessions retain their run identity so steering instructions appear in the inspector", () => {
  const ui = client();
  const data = snapshot({ status: "paused", planAccepted: true });
  data.features = [
    { id: "legacy", runId: "legacy-run", childThreadId: "legacy-thread", status: "paused" },
  ];
  data.threadFeed = [
    {
      type: "session_steered",
      runId: "legacy-run",
      threadId: "legacy-thread",
      message: "Inspect rollback.",
    },
  ];
  ui.context.data = data;
  ui.run(
    'hudState.snapshot = data; hudState.selectedSessionId = "session-legacy"; renderCenterColumn(data)',
  );
  assert.match(ui.elements.get("session-handoff-view").innerHTML, /Inspect rollback\./);
  assert.match(
    ui.elements.get("session-handoff-view").innerHTML,
    /href="t3-thread:\/\/v1\/legacy-thread"/,
  );
});

test("session steering retains drafts across snapshots and reports recorded, sent and failed submissions", async () => {
  const ui = client();
  ui.context.data = snapshot({
    status: "paused",
    planAccepted: true,
    sessions: [{ runId: "r1", featureId: "f1", childThreadId: "t1", status: "paused" }],
  });
  ui.run(
    'hudState.snapshot = data; hudState.selectedSessionId = "r1"; const session = synthesizeSessions(data.state, [])[0]; steeringState(session).draft = "Keep <tests>."; renderCenterColumn(data)',
  );
  assert.match(ui.elements.get("session-handoff-view").innerHTML, /value="Keep &lt;tests&gt;\."/);
  const calls = [];
  ui.context.fetch = async (url, request) => {
    calls.push([url, JSON.parse(request.body)]);
    return { ok: true, json: async () => ({ delivery: "recorded" }) };
  };
  await ui.run("submitSessionSteering(session)");
  assert.deepEqual(calls, [
    ["/api/mission/steer", { runId: "r1", childThreadId: "t1", message: "Keep <tests>." }],
  ]);
  assert.equal(ui.run("steeringState(session).draft"), "");
  assert.match(ui.elements.get("session-handoff-view").innerHTML, /Recorded locally/);
  ui.context.fetch = async () => ({ ok: false, status: 502, text: async () => "offline" });
  ui.run('steeringState(session).draft = "Retain me"');
  await ui.run("submitSessionSteering(session)");
  assert.equal(ui.run("steeringState(session).draft"), "Retain me");
  assert.equal(ui.run("steeringState(session).failed"), true);
  assert.match(ui.elements.get("session-handoff-view").innerHTML, /offline/);
  ui.context.fetch = async () => ({ ok: true, json: async () => ({ delivery: "sent" }) });
  await ui.run("submitSessionSteering(session)");
  assert.match(ui.elements.get("session-handoff-view").innerHTML, /Sent to thread\./);
});

test("thread endpoint binds reads to Mission sessions and preserves local activity on reader failure", async (t) => {
  const repo = temporary(t),
    mission = path.join(repo, ".mission");
  writeJson(path.join(mission, "state.json"), {
    missionId: "feed",
    title: "Activity",
    repoPath: repo,
    status: "running",
    sessions: [
      { sessionId: "s1", runId: "r1", featureId: "f1", childThreadId: "t1", status: "running" },
      { sessionId: "s0", runId: "r0", featureId: "f1", childThreadId: "t0", status: "completed" },
    ],
  });
  fs.writeFileSync(
    path.join(mission, "observations.jsonl"),
    [
      { type: "command", runId: "r1", command: "npm test" },
      { type: "message", runId: "r0", message: "Old run" },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const reads = [];
  const hud = await createMissionHudServer({
    missionDir: mission,
    threadReader: async (id) => {
      reads.push(id);
      throw new Error("offline");
    },
  });
  t.after(() => hud.close());
  const state = await (await fetch(`${hud.url}/api/mission/state`)).json();
  assert.equal(state.observations.length, 2);
  assert.equal(state.readiness.evaluated, false);
  const overview = await (await fetch(`${hud.url}/api/mission/thread-feed`)).json();
  assert.ok(overview.events.some((row) => row.runId === "r1"));
  assert.ok(overview.events.some((row) => row.runId === "r0"));
  const feed = await (
    await fetch(`${hud.url}/api/mission/thread-feed?threadId=t1&sessionId=r1`)
  ).json();
  assert.equal(feed.unavailable, true);
  assert.ok(feed.events.some((row) => row.message === "npm test"));
  assert.ok(feed.events.every((row) => row.runId === "r1"));
  assert.equal((await fetch(`${hud.url}/api/mission/thread-feed?threadId=foreign`)).status, 404);
  assert.equal(
    (await fetch(`${hud.url}/api/mission/thread-feed?threadId=t1&sessionId=r0`)).status,
    404,
  );
  assert.deepEqual(reads, ["t1"]);
});

test("thread messages normalize supported bridge response envelopes", () => {
  const events = normalizeThreadMessages(
    {
      structuredContent: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "Running checks" }] }],
      },
    },
    "t1",
  );
  assert.equal(events[0].threadId, "t1");
  assert.equal(events[0].message, "Running checks");
});

test("live reasoning and commands keep update times and meaningful roles", () => {
  const updatedAt = "2026-11-04T00:00:05Z";
  const events = normalizeThreadMessages(
    {
      items: [
        {
          type: "reasoning",
          text: "Inspecting state",
          updatedAt,
          createdAt: "2026-11-04T00:00:00Z",
        },
        { type: "command_execution", command: "npm test", updatedAt },
        { type: "reasoning", role: "Validator", text: "Independent check", updatedAt },
      ],
    },
    "live",
  );
  assert.deepEqual(
    events.map(({ role, timestamp, threadId }) => ({ role, timestamp, threadId })),
    [
      { role: "Worker · Thinking", timestamp: updatedAt, threadId: "live" },
      { role: "Worker · Command", timestamp: updatedAt, threadId: "live" },
      { role: "Validator", timestamp: updatedAt, threadId: "live" },
    ],
  );
  assert.equal(
    normalizeFeedEvent({ type: "reasoning", text: "Thinking", updatedAt }, { role: "Agent" }).role,
    "Worker · Thinking",
  );
  assert.equal(
    normalizeFeedEvent({ text: "Explicit", timestamp: "first", updatedAt }).timestamp,
    "first",
  );
});

test("activity items take priority and omit only the initial prompt when other activity exists", () => {
  const prompt = { type: "user_message", role: "user", text: "Task instructions\n".repeat(200) };
  const events = normalizeThreadMessages(
    {
      structuredContent: {
        items: [
          prompt,
          { role: "user", text: "Additional prompt" },
          { type: "reasoning", text: "Live thought" },
        ],
        messages: [{ role: "assistant", text: "Finalized output" }],
      },
    },
    "live",
  );
  assert.deepEqual(
    events.map((event) => event.message),
    ["Additional prompt", "Live thought"],
  );
  assert.equal(normalizeThreadMessages({ items: [prompt] }, "live").length, 1);
});

test("activity items preserve user steering after reasoning", () => {
  const events = normalizeThreadMessages(
    {
      items: [
        { type: "user_message", text: "Initial prompt" },
        { type: "reasoning", text: "Thinking" },
        { role: "user", text: "Stop deployment" },
      ],
    },
    "live",
  );
  assert.deepEqual(
    events.map(({ type, role, message }) => ({ type, role, message })),
    [
      { type: "reasoning", role: "Worker · Thinking", message: "Thinking" },
      { type: "message", role: "user", message: "Stop deployment" },
    ],
  );
});

test("partial activity slices preserve the first user steering message", () => {
  const items = [
    { position: 80, type: "user_message", text: "Stop deployment" },
    { position: 81, type: "reasoning", text: "Stopping..." },
  ];
  for (const metadata of [{}, { hasMoreBefore: true, thread: { itemCount: 100 } }]) {
    const events = normalizeThreadMessages({ items, ...metadata }, "live");
    assert.deepEqual(
      events.map((event) => event.message),
      ["Stop deployment", "Stopping..."],
    );
  }
});

test("unpositioned activity slices use pagination metadata to preserve user steering", () => {
  const items = [
    { type: "user_message", text: "Stop deployment" },
    { type: "reasoning", text: "Stopping..." },
  ];
  for (const metadata of [{ hasMoreBefore: true }, { thread: { itemCount: 100 } }]) {
    const events = normalizeThreadMessages({ items, ...metadata }, "live");
    assert.deepEqual(
      events.map((event) => event.message),
      ["Stop deployment", "Stopping..."],
    );
  }
});

test("confirmed thread-start positions identify the initial prompt despite pagination metadata", () => {
  for (const position of [0, 1]) {
    const events = normalizeThreadMessages(
      {
        hasMoreBefore: true,
        thread: { itemCount: 100 },
        items: [
          { position, type: "user_message", text: "Initial prompt" },
          { type: "reasoning", text: "Thinking" },
        ],
      },
      "live",
    );
    assert.deepEqual(
      events.map((event) => event.message),
      ["Thinking"],
    );
  }
});

test("user-only activity items preserve every user message", () => {
  const events = normalizeThreadMessages(
    {
      items: [
        { type: "user_message", text: "First" },
        { role: "user", text: "Second" },
      ],
    },
    "live",
  );
  assert.deepEqual(
    events.map((event) => event.message),
    ["First", "Second"],
  );
});

for (const envelope of ["messages", "thread.messages"]) {
  test(`legacy ${envelope} preserve the initial prompt and user steering`, () => {
    const messages = [
      { role: "user", text: "Initial prompt" },
      { role: "assistant", text: "Thinking" },
      { role: "user", text: "Stop deployment" },
    ];
    const response = envelope === "messages" ? { messages } : { thread: { messages } };
    assert.deepEqual(
      normalizeThreadMessages(response, "live").map((event) => event.message),
      ["Initial prompt", "Thinking", "Stop deployment"],
    );
  });
}

for (const [mode, threadId, normalizedThreadId] of [
  ["configured", "node:delegated-task:live", "thread:delegated-task:live"],
  ["configured", "ordinary-thread", "ordinary-thread"],
  ["discovered", "node:delegated-task:live", "thread:delegated-task:live"],
]) {
  test(`default live reader uses the ${mode} bridge for ${threadId} and requests bounded activity`, async (t) => {
    const repo = temporary(t);
    const entrypoint = path.join(repo, "bin.mjs");
    fs.writeFileSync(
      entrypoint,
      `
    const [command, tool, payload] = process.argv.slice(2);
    const transportConfigured = process.env.T3_ACP_MCP_ENDPOINT === "http://127.0.0.1:1234/mcp" && process.env.T3_ACP_MCP_AUTHORIZATION === "Bearer fixture-token";
    console.log(JSON.stringify({items:[{type:"assistant_message", text:JSON.stringify({command,tool,args:JSON.parse(payload),transportConfigured})}]}));
  `,
    );
    setTestEnv(t, {
      T3_ACP_MCP_NODE: mode === "configured" ? process.execPath : undefined,
      T3_ACP_MCP_ENTRYPOINT: mode === "configured" ? entrypoint : undefined,
      T3_ACP_MCP_ENDPOINT: mode === "configured" ? "http://127.0.0.1:1234/mcp" : undefined,
      T3_ACP_MCP_AUTHORIZATION: mode === "configured" ? "Bearer fixture-token" : undefined,
      T3_ENABLE_BRIDGE_AUTODISCOVERY: mode === "discovered" ? "1" : undefined,
      T3_DISABLE_BRIDGE_AUTODISCOVERY: undefined,
    });
    const ps = t.mock.method(cp, "execFileSync", () => bridgeProcess(process.execPath, entrypoint));
    const mission = path.join(repo, ".mission");
    writeJson(path.join(mission, "state.json"), {
      missionId: "default-reader",
      repoPath: repo,
      sessions: [{ runId: "r1", childThreadId: threadId, status: "running" }],
    });
    const hud = await createMissionHudServer({ missionDir: mission });
    t.after(() => hud.close());
    const feed = await (
      await fetch(
        `${hud.url}/api/mission/thread-feed?${new URLSearchParams({ threadId, sessionId: "r1" })}`,
      )
    ).json();
    assert.equal(feed.source, "thread+mission");
    assert.deepEqual(
      JSON.parse(feed.events.find((event) => event.type === "assistant_message").message),
      {
        command: "acp-mcp-call",
        tool: "t3_thread_read",
        args: { threadId: normalizedThreadId, view: "activity", limit: 40 },
        transportConfigured: true,
      },
    );
    assert.equal(ps.mock.callCount(), mode === "discovered" ? 1 : 0);
  });
}

test("default live reader never discovers a real bridge during unit tests", async (t) => {
  setTestEnv(t, {
    T3_ACP_MCP_NODE: undefined,
    T3_ACP_MCP_ENTRYPOINT: undefined,
    T3_ENABLE_BRIDGE_AUTODISCOVERY: undefined,
    T3_DISABLE_BRIDGE_AUTODISCOVERY: undefined,
  });
  const ps = t.mock.method(cp, "execFileSync", () => {
    throw new Error("Unexpected process scan");
  });
  const repo = temporary(t),
    mission = path.join(repo, ".mission");
  writeJson(path.join(mission, "state.json"), {
    missionId: "no-discovery",
    repoPath: repo,
    sessions: [{ runId: "r1", childThreadId: "live", status: "running" }],
  });
  const hud = await createMissionHudServer({ missionDir: mission });
  t.after(() => hud.close());
  const feed = await (
    await fetch(`${hud.url}/api/mission/thread-feed?threadId=live&sessionId=r1`)
  ).json();
  assert.equal(ps.mock.callCount(), 0);
  assert.equal(feed.source, "mission");
  assert.equal(feed.unavailable, false);
});

function bridgeProcess(node, entrypoint, endpoint = "http://127.0.0.1:1234/mcp") {
  return `123 ?? S 0:00.01 ${node} ${entrypoint} acp-mcp-bridge T3_ACP_MCP_ENDPOINT=${endpoint} T3_ACP_MCP_AUTHORIZATION=Bearer fixture-token`;
}

function bridgeFiles(t, name = "T3 Code") {
  const repo = temporary(t);
  const node = path.join(repo, `${name}.app`, "Contents", "MacOS", name);
  const entrypoint = path.join(repo, "T3 Resources", "bin.mjs");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(node, "");
  fs.writeFileSync(entrypoint, "");
  return { node, entrypoint };
}

test("explicit bridge configuration bypasses discovery without changing the environment", (t) => {
  const env = { T3_ACP_MCP_NODE: "configured-node", T3_ACP_MCP_ENTRYPOINT: "configured-entry" };
  const ps = t.mock.method(cp, "execFileSync", () => {
    throw new Error("Unexpected process scan");
  });
  assert.equal(resolveLiveT3McpEnv(env), env);
  assert.equal(ps.mock.callCount(), 0);
});

for (const name of ["T3 Code", "T3 Code (Nightly)"]) {
  test(`bridge discovery extracts ${name} paths with spaces and a complete transport environment`, (t) => {
    const { node, entrypoint } = bridgeFiles(t, name);
    const ps = t.mock.method(cp, "execFileSync", (command, args, options) => {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["eww", "-ax"]);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.timeout, 1500);
      return [
        "PID TT STAT TIME COMMAND",
        bridgeProcess("/missing-node", entrypoint),
        bridgeProcess(node, entrypoint),
      ].join("\n");
    });
    const env = {
      T3_ENABLE_BRIDGE_AUTODISCOVERY: "1",
      T3_ACP_MCP_NODE: "incomplete-node",
      PATH: "/fixture",
    };
    assert.deepEqual(resolveLiveT3McpEnv(env), {
      ...env,
      T3_ACP_MCP_NODE: node,
      T3_ACP_MCP_ENTRYPOINT: entrypoint,
      T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1234/mcp",
      T3_ACP_MCP_AUTHORIZATION: "Bearer fixture-token",
    });
    assert.equal(env.T3_ACP_MCP_NODE, "incomplete-node");
    assert.equal(ps.mock.callCount(), 1);
  });
}

for (const outcome of [
  "exists",
  "missing",
  "invalid response",
  "probe failure",
  "missing archive",
]) {
  test(`ASAR bridge entrypoints require Electron filesystem confirmation: ${outcome}`, (t) => {
    const { node, entrypoint } = bridgeFiles(t);
    const archive = path.join(path.dirname(entrypoint), "app.asar");
    const asarEntrypoint = path.join(archive, "bin.mjs");
    if (outcome !== "missing archive") fs.writeFileSync(archive, "fixture archive");
    const ps = t.mock.method(cp, "execFileSync", (command, args, options) => {
      if (command === "ps") return bridgeProcess(node, asarEntrypoint);
      assert.equal(command, node);
      assert.equal(args[0], "-e");
      assert.equal(args[2], asarEntrypoint);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(options.timeout, 1500);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      if (outcome === "probe failure") throw new Error("Electron unavailable");
      return outcome === "exists" ? "1\n" : outcome === "missing" ? "0" : "unconfirmed";
    });
    const env = { T3_ENABLE_BRIDGE_AUTODISCOVERY: "1" };
    const resolved = resolveLiveT3McpEnv(env);
    if (outcome === "exists") assert.equal(resolved.T3_ACP_MCP_ENTRYPOINT, asarEntrypoint);
    else assert.equal(resolved, null);
    assert.equal(ps.mock.callCount(), outcome === "missing archive" ? 1 : 2);
    assert.deepEqual(resolveLiveT3McpEnv(env), resolved);
    assert.equal(ps.mock.callCount(), outcome === "missing archive" ? 1 : 2);
  });
}

for (const found of [true, false]) {
  test(`bridge discovery caches ${found ? "a match" : "a missing bridge"} for thirty seconds`, (t) => {
    const { node, entrypoint } = bridgeFiles(t);
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    let processLine = found ? bridgeProcess(node, entrypoint) : "No bridge";
    const ps = t.mock.method(cp, "execFileSync", () => processLine);
    const env = { T3_ENABLE_BRIDGE_AUTODISCOVERY: "1" };
    const first = resolveLiveT3McpEnv(env);
    assert.equal(first?.T3_ACP_MCP_NODE ?? null, found ? node : null);
    processLine = bridgeProcess(node, entrypoint, "http://127.0.0.1:5678/mcp");
    now += 29_999;
    assert.deepEqual(resolveLiveT3McpEnv(env), first);
    assert.equal(ps.mock.callCount(), 1);
    now += 1;
    assert.equal(resolveLiveT3McpEnv(env).T3_ACP_MCP_ENDPOINT, "http://127.0.0.1:5678/mcp");
    assert.equal(ps.mock.callCount(), 2);
    assert.equal(env.T3_ACP_MCP_ENDPOINT, undefined);
  });
}

test("bridge discovery is disabled in tests unless enabled, and the disable switch takes precedence", (t) => {
  const ps = t.mock.method(cp, "execFileSync", () => {
    throw new Error("Unexpected process scan");
  });
  assert.equal(resolveLiveT3McpEnv({ NODE_ENV: "test" }), null);
  assert.equal(
    resolveLiveT3McpEnv({
      T3_ENABLE_BRIDGE_AUTODISCOVERY: "1",
      T3_DISABLE_BRIDGE_AUTODISCOVERY: "1",
    }),
    null,
  );
  assert.equal(ps.mock.callCount(), 0);
});

test("agent-shell environments discover a bridge without an opt-in outside the test runner", (t) => {
  const { node, entrypoint } = bridgeFiles(t);
  const ps = t.mock.method(cp, "execFileSync", () => bridgeProcess(node, entrypoint));
  setTestEnv(t, { NODE_ENV: undefined, NODE_TEST_CONTEXT: undefined });
  const execArgv = process.execArgv;
  process.execArgv = [];
  t.after(() => {
    process.execArgv = execArgv;
  });
  assert.equal(resolveLiveT3McpEnv({}).T3_ACP_MCP_NODE, node);
  assert.equal(ps.mock.callCount(), 1);
});

for (const fault of [
  "ps failure",
  "missing executable",
  "missing entrypoint",
  "missing authorization",
  "missing endpoint",
]) {
  test(`bridge discovery safely returns null on ${fault}`, (t) => {
    const { node, entrypoint } = bridgeFiles(t);
    const ps = t.mock.method(cp, "execFileSync", () => {
      if (fault === "ps failure") throw new Error("Process listing unavailable");
      if (fault === "missing executable") return bridgeProcess("/missing-node", entrypoint);
      if (fault === "missing entrypoint") return bridgeProcess(node, "/missing/bin.mjs");
      return bridgeProcess(node, entrypoint).replace(
        fault === "missing authorization"
          ? / T3_ACP_MCP_AUTHORIZATION=.*/
          : / T3_ACP_MCP_ENDPOINT=\S+/,
        "",
      );
    });
    assert.equal(resolveLiveT3McpEnv({ T3_ENABLE_BRIDGE_AUTODISCOVERY: "1" }), null);
    assert.equal(ps.mock.callCount(), 1);
  });
}

async function nextSnapshot(reader, match) {
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE ended before the expected observation");
    buffer += new TextDecoder().decode(value);
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const snapshot = JSON.parse(data.slice(6));
      if (match(snapshot)) return snapshot;
    }
  }
}

test("observation-only changes stream through SSE without a state revision", async (t) => {
  const repo = temporary(t),
    mission = path.join(repo, ".mission");
  writeJson(path.join(mission, "state.json"), {
    missionId: "sse-feed",
    title: "Activity",
    repoPath: repo,
    status: "running",
    revision: 1,
  });
  const hud = await createMissionHudServer({ missionDir: mission });
  t.after(() => hud.close());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => {
    clearTimeout(timeout);
    controller.abort();
  });
  const response = await fetch(`${hud.url}/api/mission/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  await nextSnapshot(reader, () => true);
  fs.mkdirSync(path.join(mission, "autopilot"), { recursive: true });
  fs.writeFileSync(
    path.join(mission, "autopilot", "observations.jsonl"),
    '{"type":"message","message":"Fresh tool activity"}\n',
  );
  const streamed = await nextSnapshot(reader, (data) =>
    data.observations.some((row) => row.message === "Fresh tool activity"),
  );
  assert.equal(streamed.state.revision, 1);
  assert.ok(streamed.threadFeed.some((row) => row.message === "Fresh tool activity"));
  await reader.cancel();
});

test("elapsed clock accumulates once, preserves active intervals and clamps clock rollback", () => {
  const state = { elapsedMs: 2000, lastStartedAt: null };
  startElapsedClock(state, "2026-11-04T00:00:00Z");
  startElapsedClock(state, "2026-11-04T00:00:03Z");
  stopElapsedClock(state, Date.parse("2026-11-04T00:00:05Z"));
  stopElapsedClock(state, Date.parse("2026-11-04T00:00:07Z"));
  assert.deepEqual(state, { elapsedMs: 7000, lastStartedAt: null });
  startElapsedClock(state, "2026-11-04T00:00:10Z");
  stopElapsedClock(state, Date.parse("2026-11-04T00:00:05Z"));
  assert.equal(state.elapsedMs, 7000);
});

test("approval, worker selection, pause and resume persist a continuous elapsed clock", (t) => {
  const root = temporary(t);
  proposeMission(root, {
    title: "Clock",
    repoPath: root,
    autopilot: true,
    ownerThreadId: "owner",
    milestones: [{ id: "m1", title: "Clock" }],
    features: [{ id: "f1", title: "Feature", milestoneId: "m1" }],
  });
  const approved = approveMissionPlan(root).state;
  assert.equal(approved.status, "orchestrator_turn");
  assert.ok(Number.isFinite(Date.parse(approved.lastStartedAt)));
  const doc = loadFeaturesDoc(root);
  selectFeatureForWorker(root, doc.features[0], 0, loadModelSettings(root));
  const selected = loadState(root);
  assert.equal(selected.lastStartedAt, approved.lastStartedAt);
  selected.lastStartedAt = new Date(Date.now() - 5000).toISOString();
  selected.elapsedMs = 1000;
  saveState(root, selected);
  const paused = applyAutopilotCommand(root, "pause");
  assert.equal(paused.lastStartedAt, null);
  assert.ok(paused.elapsedMs >= 6000);
  assert.equal(applyAutopilotCommand(root, "pause").elapsedMs, paused.elapsedMs);
  const resumed = applyAutopilotCommand(root, "resume");
  assert.ok(Number.isFinite(Date.parse(resumed.lastStartedAt)));
  assert.equal(resumed.elapsedMs, paused.elapsedMs);
  assert.equal(applyAutopilotCommand(root, "resume").lastStartedAt, resumed.lastStartedAt);
});
