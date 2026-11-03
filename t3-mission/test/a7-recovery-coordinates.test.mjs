import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as k from "../kernel/index.mjs";

import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import { missionTransaction, writeTransactionFile } from "../kernel/mission-transaction.mjs";
import { buildDelegateTask } from "../kernel/mission-brief.mjs";
import { runFeature as bridgeRun } from "../bridge/t3-adapter.mjs";
const tick = async (d, observations = []) => (await k.missionTick(d, { observations })).action;
const observe = (a, response, cursor) => ({
  type: "children",
  featureId: a.featureId,
  runId: a.runId,
  intentId: a.intentId,
  response,
  ...(cursor ? { cursor } : {}),
});
async function boot(d) {
  k.proposeMission(d, {
    title: "Coordinate fixture",
    repoPath: d,
    autopilot: true,
    ownerThreadId: "original-owner",
    milestones: [{ id: "m7", ordinal: 3 }],
    features: [{ id: "f1", title: "Original title", milestoneId: "m7" }],
  });
  k.approveMissionPlan(d);
  const t = await tick(d);
  return tick(d, [
    { type: "timer", requestId: t.requestId, response: { taskId: "timer", enabled: true } },
  ]);
}
test("A7 frozen coordinates survive title, owner, pagination and a fresh process", async () => {
  const d = fs.mkdtempSync(
      path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-coordinates-"),
    ),
    a = await boot(d),
    intent = inspectDispatchRecords(d)[0].intent;
  assert.deepEqual(intent.recovery, {
    ownerThreadId: "original-owner",
    parentThreadId: "original-owner",
    clientRequestId: a.intentId,
    title: "[M3] Worker #1: Original title",
  });
  k.updateMissionFeatures(d, { updateFeatures: [{ id: "f1", title: "Changed title" }] });
  const old = k.loadState(d);
  k.rejectMissionPlan(d, "Change owner");
  k.proposeMission(d, {
    ...old,
    ownerThreadId: "new-owner",
    features: k.loadFeaturesDoc(d).features,
  });
  k.approveMissionPlan(d);
  assert.equal(
    buildDelegateTask(k.loadState(d), k.loadFeaturesDoc(d).features[0], intent).title,
    "[M3] Worker #1: Original title",
  );
  const first = await tick(d);
  assert.equal(first.t3ThreadList.titleContains, "[M3] Worker #1: Original title");
  assert.equal(first.recoveryCoordinates.parentThreadId, "original-owner");
  const p1 = await tick(d, [
    observe(a, {
      threads: [
        {
          taskId: "foreign-owner-task",
          childThreadId: "foreign-owner-child",
          clientRequestId: a.intentId,
          parentThreadId: "new-owner",
        },
      ],
      nextCursor: "page-two",
    }),
  ]);
  assert.equal(p1.type, "recover_dispatch");
  assert.equal(p1.t3ThreadList.cursor, "page-two");
  const p2 = await tick(d, [
    observe(
      a,
      {
        threads: [
          {
            taskId: "foreign-request-task",
            childThreadId: "foreign-request-child",
            clientRequestId: "other-request",
            parentThreadId: "original-owner",
          },
        ],
        nextCursor: "page-three",
      },
      "page-two",
    ),
  ]);
  assert.equal(p2.type, "recover_dispatch");
  assert.equal(p2.t3ThreadList.cursor, "page-three");
  const input = {
    observations: [
      observe(
        a,
        {
          threads: [
            {
              accepted: true,
              taskId: "original-task",
              childThreadId: "original-child",
              clientRequestId: a.intentId,
              parentThreadId: "original-owner",
            },
          ],
        },
        "page-three",
      ),
    ],
  };
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};console.log(JSON.stringify(await k.missionTick(process.argv[1],JSON.parse(process.argv[2]))));`,
        d,
        JSON.stringify(input),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(result.action.type, "poll");
  assert.equal(result.action.taskId, "original-task");
  assert.equal(k.loadState(d).sessions.length, 1);
  assert.equal(inspectDispatchRecords(d)[0].phase, "accepted");
});
test("A7 legacy intent missing frozen coordinates diagnoses fallback and never redispatches", async () => {
  const d = fs.mkdtempSync(
      path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-legacy-coordinates-"),
    ),
    a = await boot(d);
  const file = fs.readdirSync(path.join(d, ".mission")).find((n) => /^dispatch-.*\.json$/.test(n)),
    absolute = path.join(d, ".mission", file),
    record = JSON.parse(fs.readFileSync(absolute));
  delete record.intent.recovery;
  missionTransaction(d, () =>
    writeTransactionFile(absolute, JSON.stringify(record, null, 2) + "\n"),
  );
  const recovery = await tick(d);
  assert.equal(recovery.type, "recover_dispatch");
  assert.equal(recovery.diagnostics[0].code, "LEGACY_RECOVERY_COORDINATES");
  assert.equal(recovery.recoveryCoordinates.parentThreadId, "original-owner");
  const after = await tick(d, [
    observe(a, {
      threads: [
        {
          accepted: true,
          taskId: "legacy-task",
          childThreadId: "legacy-child",
          clientRequestId: a.intentId,
          parentThreadId: "original-owner",
        },
      ],
    }),
  ]);
  assert.equal(after.type, "poll");
  assert.equal(after.taskId, "legacy-task");
  assert.equal(k.loadState(d).sessions.length, 1);
});
test("A7 default bridge receives the exact title frozen in its dispatch intent", async () => {
  const d = fs.mkdtempSync(
    path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a7-dispatch-title-"),
  );
  k.proposeMission(d, {
    title: "Title transport",
    repoPath: d,
    ownerThreadId: "owner",
    milestones: [{ id: "m7", ordinal: 3 }],
    features: [{ id: "f1", title: "Original title", milestoneId: "m7" }],
  });
  k.approveMissionPlan(d);
  let title,
    calls = 0;
  await k.startMissionRun(
    d,
    {},
    {
      runFeature: (feature, target, state) =>
        bridgeRun(feature, target, state, {
          transportClient: async (tool, args) => {
            calls++;
            title = args.title;
            return { accepted: true, taskId: "title-task", childThreadId: "title-child" };
          },
        }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(title, "[M3] Worker #1: Original title");
  assert.equal(
    inspectDispatchRecords(d)[0].intent.recovery.title,
    "[M3] Worker #1: Original title",
  );
});
