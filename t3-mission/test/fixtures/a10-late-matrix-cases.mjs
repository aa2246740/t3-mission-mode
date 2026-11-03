import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as k from "../../kernel/index.mjs";
import { applyAutopilotCommand } from "../../kernel/autopilot-commands.mjs";

import {
  now,
  tick,
  observation,
  accepted,
  status,
  result,
  init,
  ledger,
  fenced,
  reapprove,
  finish,
  rejectedAttempts,
  rejectedHistory,
} from "./a10-fixture.mjs";

const kinds = ["success", "failure", "failed", "cancelled", "interrupted"];
const tuples = (n) =>
  n === 0 ? [[]] : tuples(n - 1).flatMap((t) => kinds.map((kind) => [...t, kind]));
const permutations = (values) =>
  values.length === 0
    ? [[]]
    : values.flatMap((v, i) =>
        permutations(values.filter((_, j) => i !== j)).map((rest) => [v, ...rest]),
      );

const shardFiles = [
  "a10-late-matrix.test.mjs",
  "a10-late-matrix-shard-1.test.mjs",
  "a10-late-matrix-shard-2.test.mjs",
  "a10-late-matrix-shard-3.test.mjs",
];

export function registerLateIdentityCases(testFileUrl) {
  const shard = shardFiles.indexOf(path.basename(fileURLToPath(testFileUrl)));
  if (
    shard < 0 ||
    shardFiles.some((file) => !fs.existsSync(new URL("../" + file, import.meta.url)))
  ) {
    throw new Error("All four late-identity matrix shards are required; no case may be omitted.");
  }
  let caseNumber = 0;
  for (const source of ["attempts", "history"])
    for (const n of [1, 2, 3])
      for (const outcomes of tuples(n))
        for (const order of permutations(Array.from({ length: n }, (_, i) => i))) {
          if (caseNumber++ % shardFiles.length !== shard) continue;
          test(`A10 ${source} ${outcomes.join("/")} terminal order ${order.join("/")}`, async () => {
            const d = init(source),
              attempts = await (source === "attempts"
                ? rejectedAttempts(d, n)
                : rejectedHistory(d, n));
            for (const [i, a] of attempts.entries()) {
              a.worktreePath = d + "/original-worktree-" + i;
              fs.mkdirSync(a.worktreePath);
              fs.writeFileSync(a.worktreePath + "/retained.txt", "original-" + i);
            }
            const sessions = JSON.stringify(k.loadState(d).sessions);
            await tick(
              d,
              attempts.map((a) => observation(a, accepted(a))),
              now + 10000,
            );
            reapprove(d);
            applyAutopilotCommand(d, "pause");
            applyAutopilotCommand(d, "resume");
            for (const a of attempts) {
              const pending = await tick(
                d,
                [
                  status(a, "cancelled", { childRunId: "obsolete-turn" }),
                  status(a, "completed", {
                    workState: "waiting_for_children",
                    hasPendingChildRuns: true,
                    pendingChildRuns: ["still-running"],
                  }),
                ],
                now + 10001,
              );
              assert.notEqual(pending.type, "dispatch");
            }
            assert.equal(Object.keys(ledger(d).dispatchResolutions ?? {}).length, 0);
            fenced(d);
            let action;
            for (let j = 0; j < n; j++) {
              const i = order[j],
                a = attempts[i],
                outcome = outcomes[i];
              action = await tick(
                d,
                [
                  ["success", "failure"].includes(outcome)
                    ? result(a, outcome)
                    : status(a, outcome),
                ],
                now + 11000 + j,
              );
              const resolutions = Object.values(ledger(d).dispatchResolutions ?? {});
              assert.equal(resolutions.length, j + 1);
              assert.equal(
                resolutions.find((row) => row.intentId === a.intentId).terminalStatus,
                ["success", "failure"].includes(outcome) ? "completed" : outcome,
              );
              assert.deepEqual(
                resolutions.find((row) => row.intentId === a.intentId).response,
                (["success", "failure"].includes(outcome) ? result(a, outcome) : status(a, outcome))
                  .response,
              );
              assert.equal(k.loadFeaturesDoc(d).features[0].integration, undefined);
              assert.equal(k.loadFeaturesDoc(d).features[0].acceptedSuccessRunId, undefined);
              assert.equal(ledger(d).lateResults, undefined);
              if (j + 1 < n) {
                assert.notEqual(action.type, "dispatch");
                fenced(d);
              }
            }
            assert.equal(action.type, "dispatch");
            assert.equal(action.attempt, source === "attempts" ? n + 1 : 2);
            assert.equal(
              JSON.stringify(k.loadState(d).sessions.slice(0, source === "attempts" ? n : 1)),
              sessions,
            );
            const log = fs
              .readFileSync(d + "/.mission/progress_log.jsonl", "utf8")
              .trim()
              .split("\n")
              .map(JSON.parse);
            assert.equal(log.filter((row) => row.type === "late_execution_resolved").length, n);
            for (const resolution of Object.values(ledger(d).dispatchResolutions)) {
              assert.deepEqual(
                log.find(
                  (row) =>
                    row.type === "late_execution_resolved" &&
                    row.details?.resolutionId === resolution.resolutionId,
                ).details,
                resolution,
              );
            }
            await finish(d, action, now + 20000);
            for (const [i, a] of attempts.entries())
              assert.equal(
                fs.readFileSync(a.worktreePath + "/retained.txt", "utf8"),
                "original-" + i,
              );
          });
        }

  return caseNumber;
}
