import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildDelegateTask } from "../kernel/mission-brief.mjs";

test("A15 worker brief requires observed Git provenance and preservation", () => {
  const task = buildDelegateTask(
    { missionId: "m", repoPath: "/read-only-reference", milestones: [{ id: "m1" }] },
    {
      id: "f",
      milestoneId: "m1",
      title: "Implement a feature",
      description: "Literal feature contract",
    },
    {
      runId: "r",
      attempt: 1,
      worker: { workerNumber: 1 },
      clientRequestId: "original-request",
      target: { providerInstanceId: "codex", model: "gpt-6.1-sol", options: {} },
    },
  ).task;
  for (const text of [
    "commit or branch rename that you did not execute",
    "compare its content with your intended changes",
    "Continue on top of those changes",
    "actual branch, HEAD and these commits",
    "state that you did not execute them",
    "Do not reset, rebase or delete them",
  ])
    assert.ok(task.includes(text), text);
});

test("A15 both skills require exact source SHA, preserved dirty changes and approved fast-forward", () => {
  const root = fs.readFileSync(new URL("../../SKILL.md", import.meta.url), "utf8");
  assert.equal(root, fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8"));
  for (const text of [
    "actual source HEAD equals context.commit",
    "unknown dirty changes, preserve them and report blocked",
    "only that exact SHA for the approved fast-forward",
    "do not establish provenance from a branch name or a model claim",
    "commits or a branch rename it did not execute",
    "Do not assume another executor finished the task",
    "do not reset, rebase or delete those commits",
  ])
    assert.ok(root.includes(text), text);
});
