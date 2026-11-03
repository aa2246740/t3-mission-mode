import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
import * as k from "../kernel/index.mjs";

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const save = (n, x) =>
  fs.writeFileSync(
    path.join(process.env.R9_EVIDENCE_DIR, n + ".json"),
    JSON.stringify(x, null, 2) + "\n",
  );
test("A12 configured short Git deadline fails closed and default budget resumes a finite 2.2 second check", async () => {
  const d = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR, "git-budget-"));
  k.proposeMission(d, {
    title: "git-budget",
    repoPath: d,
    autopilot: false,
    ownerThreadId: "owner",
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
  });
  k.approveMissionPlan(d);
  const git = (...args) =>
    cp.execFileSync("git", args, {
      cwd: d,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "-q");
  fs.writeFileSync(
    path.join(d, ".gitignore"),
    ".mission/\nfsmonitor-hook\nhook-entered\nhook-finished\n",
  );
  fs.writeFileSync(path.join(d, "README.md"), "owned clean repository\n");
  git("add", ".gitignore", "README.md");
  git(
    "-c",
    "user.name=Review",
    "-c",
    "user.email=review@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "fixture",
  );
  const identity = { accepted: true, taskId: "git-task", childThreadId: "git-thread" };
  await k.startMissionRun(d, {}, { runFeature: async () => identity });
  const s = k.loadState(d);
  s.status = "paused";
  s.pausedAt = new Date().toISOString();
  s.revision++;
  s.activeWorker.status = "paused";
  s.sessions[0].status = "paused";
  k.saveState(d, s);
  const before = k.loadState(d),
    hook = path.join(d, "fsmonitor-hook");
  fs.writeFileSync(
    hook,
    "#!/bin/sh\nprintf entered > " +
      quote(path.join(d, "hook-entered")) +
      "\n/bin/sleep 2.2\nprintf finished > " +
      quote(path.join(d, "hook-finished")) +
      '\nprintf "\\n"\n',
    { mode: 0o700 },
  );
  git("config", "--local", "core.fsmonitor", hook);
  let calls = 0,
    timerRan = false;
  const adapter = {
    resumeWorker: async () => {
      calls++;
      return { ...identity, resumed: true };
    },
  };
  const timer = setTimeout(() => {
    timerRan = true;
  }, 20);
  const defaultHud = await createHandlerHud({
    missionDir: d,
    runtimeAdapter: adapter,
    gitPreflightTimeoutMs: 100,
  });
  let first;
  try {
    first = await defaultHud.post("resume");
  } finally {
    await defaultHud.close();
    clearTimeout(timer);
  }
  const afterDefault = k.loadState(d);
  const callsAfterDefault = calls;
  const configuredHud = await createHandlerHud({ missionDir: d, runtimeAdapter: adapter });
  let second;
  try {
    second = await configuredHud.post("resume");
  } finally {
    await configuredHud.close();
  }
  save("git-default-and-configured", {
    d,
    before,
    first,
    afterDefault,
    callsAfterDefault,
    timerRan,
    second,
    calls,
    after: k.loadState(d),
    hookFinished: fs.existsSync(path.join(d, "hook-finished")),
  });
  assert.equal(first.status, 409);
  assert.equal(first.body.code, "GIT_PREFLIGHT_TIMEOUT");
  assert.equal(first.body.reasonCode, "RESUME_BLOCKED_BY_GIT_ERROR");
  assert.equal(timerRan, true);
  assert.equal(callsAfterDefault, 0);
  assert.deepEqual(afterDefault, before);
  assert.equal(fs.existsSync(path.join(d, "hook-finished")), true);
  assert.equal(second.status, 200);
  assert.equal(second.body.state?.status ?? k.loadState(d).status, "running");
  assert.equal(calls, 1);
});
