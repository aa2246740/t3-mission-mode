import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createMissionHudServer, inspectRepoAgentReadiness } from "../hud/server.mjs";
import {
  readRecentObservations,
  buildThreadFeed,
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
  assert.match(inspector, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(inspector, /Old attempt|model_slots_updated/);
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
