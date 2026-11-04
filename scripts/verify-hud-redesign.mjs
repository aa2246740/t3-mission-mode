import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMissionHudServer } from "../t3-mission/hud/server.mjs";
import {
  proposeMission,
  loadState,
  saveState,
  loadFeaturesDoc,
  saveFeaturesDoc,
} from "../t3-mission/kernel/index.mjs";

// This verifier drives a disposable Mission. It never attaches to an existing HUD or provider.
const runtimeUrl = pathToFileURL(path.join(os.homedir(), ".codex/playwright-runtime/runtime.mjs"));
const { launchPinnedChromium } = await import(runtimeUrl.href);
const output = path.resolve(process.env.T3_HUD_VISUAL_OUTPUT || "reports/hud-redesign");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-hud-browser-"));
const mission = path.join(root, ".mission");
const screenshots = [];
const checks = [];
const errors = [];
let browser;
let hud;

function fixture() {
  const features = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i + 1}`,
    title: ["Plan review controls", "Repository readiness", "Live thread activity"][i % 3],
    description: `Implement and verify Mission capability ${i + 1}.`,
    milestoneId: i < 2 ? "m1" : "m2",
    status: i < 2 ? "completed" : "pending",
    fulfills: [`VAL-${i + 1}`],
  }));
  proposeMission(root, {
    title: "Mission control: live execution and plan review",
    repoPath: root,
    autopilot: true,
    ownerThreadId: "fixture-owner",
    pauseMode: "let_finish",
    milestones: [
      { id: "m1", title: "Foundation" },
      { id: "m2", title: "Execution and verification" },
    ],
    features,
    assertions: features.map((feature, i) => ({
      id: `VAL-${i + 1}`,
      milestoneId: feature.milestoneId,
      description: `The owner can inspect capability ${i + 1} and verify its result.`,
      status: i < 2 ? "passed" : "pending",
    })),
  });
}

async function capture(page, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  screenshots.push(file);
}

async function checkGeometry(page, name) {
  const problems = await page.evaluate(() => {
    const issues = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push("page overflow");
    for (const control of document.querySelectorAll("button, select, input")) {
      const box = control.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.left < -1 || box.right > window.innerWidth + 1)
        issues.push(`${control.id || control.className}: horizontal clipping`);
    }
    return issues;
  });
  assert.deepEqual(problems, [], name);
  checks.push(`${name}: no page overflow or horizontally clipped controls`);
}

async function verifyPlan(page) {
  await page.goto(hud.url);
  await page.locator("#plan-feedback").waitFor();
  const style = await page.locator("#plan-feedback").evaluate((input) => {
    const css = getComputedStyle(input);
    return {
      minHeight: css.minHeight,
      padding: css.padding,
      radius: css.borderRadius,
      border: css.borderTopWidth,
    };
  });
  assert.deepEqual(style, { minHeight: "38px", padding: "8px 12px", radius: "6px", border: "1px" });
  await page
    .locator("#plan-feedback")
    .fill("Keep validation evidence separate from provider claims.");
  await page.locator("#plan-feedback").focus();
  assert.notEqual(
    await page.locator("#plan-feedback").evaluate((input) => getComputedStyle(input).boxShadow),
    "none",
  );
  fs.writeFileSync(
    path.join(mission, "observations.jsonl"),
    JSON.stringify({ type: "message", message: "Plan context refreshed" }) + "\n",
  );
  await page.waitForFunction(() =>
    document.getElementById("orchestrator-stream").textContent.includes("Plan context refreshed"),
  );
  assert.equal(
    await page.locator("#plan-feedback").evaluate((input) => document.activeElement === input),
    true,
  );
  assert.equal(
    await page.locator("#plan-feedback").inputValue(),
    "Keep validation evidence separate from provider claims.",
  );
  assert.equal(await page.locator("#features-list .feature-row").count(), 12);
  assert.equal(await page.locator("#assertions-list .assertion-row").count(), 12);
  assert.equal(
    await page
      .locator('[data-milestone-id="m1"] [data-toggle-milestone]')
      .getAttribute("aria-expanded"),
    "false",
  );
  await page.locator('[data-toggle-milestone="m1"]').click();
  assert.equal(await page.locator('[data-feature-id="f1"]').first().isVisible(), true);
  checks.push("plan feedback proportions, focus ring, full DOM and milestone expansion");
  await capture(page, "desktop-plan");
}

async function verifyTabs(page) {
  await page.locator('[data-board-tab="contract"]').click();
  assert.equal(await page.locator("#features-section").isVisible(), false);
  await page.locator('[data-assertion-filter="passed"]').click();
  assert.equal(await page.locator(".assertion-row:visible").count(), 2);
  assert.equal(await page.locator("#assertions-list .assertion-row").count(), 12);
  await page.locator('[data-board-tab="contract"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator('[data-board-tab="stream"]').getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Home");
  assert.equal(await page.locator('[data-board-tab="all"]').getAttribute("aria-selected"), "true");
  await page.locator('[data-session-id="session-f1"]').click();
  await page.locator("#btn-back-orchestrator").click();
  assert.equal(
    await page.locator("#plan-feedback").inputValue(),
    "Keep validation evidence separate from provider claims.",
  );
  checks.push("tabs, keyboard navigation, contract filters and feedback draft persistence");
}

async function verifyReadiness(page) {
  assert.match(await page.locator("#readiness-badge").textContent(), /Not Evaluated/);
  fs.writeFileSync(
    path.join(mission, "readiness.json"),
    JSON.stringify({ level: 5, score: 82.4324324324 }),
  );
  await page.waitForFunction(
    () => document.getElementById("readiness-badge").dataset.readinessState === "high",
  );
  assert.equal(await page.locator("#readiness-badge").textContent(), "Readiness: Level 5 · 82.4%");
  assert.equal(await page.locator("#readiness-callout").isVisible(), false);
  checks.push("local readiness update reaches the badge through SSE");
}

async function verifyApprovalAndClock(page) {
  await page.locator("#btn-approve").click();
  await page.waitForFunction(
    () => document.getElementById("status-strip-label").textContent === "ORCHESTRATOR TURN",
  );
  const before = await page.locator("#metric-time").textContent();
  await page.waitForFunction(
    (previous) => document.getElementById("metric-time").textContent !== previous,
    before,
    { timeout: 3500 },
  );
  const next = await page.locator("#metric-time").textContent();
  await page.waitForFunction(
    (previous) => document.getElementById("metric-time").textContent !== previous,
    next,
    { timeout: 3500 },
  );
  checks.push("real approval starts a timer that advances for two consecutive seconds");
}

function attachFixtureWorker() {
  const state = loadState(root);
  state.status = "running";
  state.activeWorker = {
    runId: "fixture-run",
    sessionId: "fixture-worker",
    featureId: "f3",
    featureTitle: "Live thread activity",
    milestoneId: "m2",
    role: "Worker",
    workerNumber: 3,
    childThreadId: "fixture-thread",
    status: "running",
    startedAt: new Date().toISOString(),
    taskBrief: "Render recorded observations and verify the session inspector.",
    handoff: {
      whatWasImplemented: "Feed and inspector",
      commandsRun: ["node --test t3-mission/test/hud-redesign.test.mjs"],
      discoveredIssues: ["Keep separate runs isolated."],
    },
  };
  state.sessions = [state.activeWorker];
  const features = loadFeaturesDoc(root);
  const feature = features.features.find((row) => row.id === "f3");
  feature.status = "running";
  feature.runId = "fixture-run";
  saveFeaturesDoc(root, features);
  saveState(root, state);
  fs.writeFileSync(
    path.join(mission, "observations.jsonl"),
    JSON.stringify({
      type: "command",
      runId: "fixture-run",
      role: "Worker",
      command: "npm run check",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
}

async function verifyLiveFeed(page) {
  attachFixtureWorker();
  await page.waitForFunction(() =>
    document.getElementById("orchestrator-stream").textContent.includes("npm run check"),
  );
  await page.locator('[data-session-id="fixture-worker"]').click();
  await page.waitForFunction(() =>
    document
      .getElementById("session-live-activity")
      .textContent.includes("Fixture thread: reading command output"),
  );
  const inspector = await page.locator("#session-handoff-view").textContent();
  assert.match(inspector, /Render recorded observations/);
  assert.match(inspector, /npm run check/);
  assert.match(inspector, /Keep separate runs isolated/);
  checks.push("observation-only SSE, selected thread messages, brief, commands and issues");
  await capture(page, "desktop-session");
  await page.locator("#btn-back-orchestrator").click();
}

async function verifyMotion(page) {
  const motion = await page
    .locator("#status-strip-dot")
    .evaluate((dot) => getComputedStyle(dot).animationName);
  assert.match(motion, /pulseDot/);
  assert.match(motion, /pulseRing/);
  const shimmer = await page
    .locator("#resume-diagnostic-card")
    .evaluate((card) => getComputedStyle(card, "::after").animationName);
  assert.equal(shimmer, "activityShimmer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page
    .locator("#status-strip-dot")
    .evaluate((dot) => getComputedStyle(dot).animationDuration);
  assert.ok(reduced.split(",").every((duration) => parseFloat(duration) <= 0.00001));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push("active pulse, ring and shimmer; reduced motion resolves in 0.01ms");
}

async function exportRenderedHtml(page, name) {
  const css = fs.readFileSync(
    new URL("../t3-mission/hud/public/styles.css", import.meta.url),
    "utf8",
  );
  const markup = (await page.content())
    .replace(/<link[^>]*href="\/styles\.css"[^>]*>/, () => `<style>${css}</style>`)
    .replace(/<script[^>]*src="\/app\.js"[^>]*><\/script>/, "");
  fs.writeFileSync(path.join(output, `${name}.html`), markup);
}

async function verifySizes(page) {
  for (const width of [1440, 1280, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkGeometry(page, `${width}px overview`);
    if (width === 375 || width === 1440) await capture(page, `${width}-overview`);
  }
}

try {
  fixture();
  hud = await createMissionHudServer({
    missionDir: mission,
    threadReader: async () => ({
      messages: [{ role: "assistant", text: "Fixture thread: reading command output" }],
    }),
  });
  browser = await launchPinnedChromium();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await verifyPlan(page);
  await exportRenderedHtml(page, "plan-rendered");
  await verifyTabs(page);
  await verifyReadiness(page);
  await verifyApprovalAndClock(page);
  await verifyLiveFeed(page);
  await verifyMotion(page);
  await verifySizes(page);
  await exportRenderedHtml(page, "running-rendered");
  assert.deepEqual(errors, []);
  const report = {
    verdict: "PASS",
    evidenceLayer: "isolated HTTP/SSE and pinned Chromium; fixture thread reader",
    checks,
    screenshots,
    errors,
  };
  fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fs.writeFileSync(
    path.join(output, "verification.json"),
    JSON.stringify(
      { verdict: "FAIL", checks, screenshots, errors, failure: error.message },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  await hud?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
