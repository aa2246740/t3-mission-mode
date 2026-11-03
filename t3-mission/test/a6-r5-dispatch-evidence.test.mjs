import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { prepareDispatch, dispatchWithIntent } from "../kernel/dispatch-journal.mjs";
import { classifyControlReceipt } from "../kernel/schema.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const out = process.env.R9_EVIDENCE_DIR;
const wraps = {
  root: (x) => x,
  response: (x) => ({ response: x }),
  delegation: (x) => ({ delegation: x }),
  structured: (x) => ({ structuredContent: x }),
  content: (x) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }),
};
const child = { taskId: "already-created-task", childThreadId: "already-created-thread" };
function setup(label, autopilot = false) {
  const dir = path.join(out, label);
  fs.mkdirSync(dir);
  k.proposeMission(dir, {
    title: label,
    repoPath: dir,
    autopilot,
    ownerThreadId: "r5-owner",
    features: [{ id: "f1", milestoneId: "m1" }],
    milestones: [{ id: "m1" }],
    assertions: [{ id: "VAL-1", milestoneId: "m1" }],
  });
  k.approveMissionPlan(dir);
  return dir;
}
function journals(dir) {
  return fs
    .readdirSync(path.join(dir, ".mission"))
    .filter((n) => /^dispatch-.*\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, ".mission", n))));
}
async function tolerate(fn) {
  try {
    return await fn();
  } catch (e) {
    return { code: e.code, message: e.message };
  }
}
for (const entry of ["journal", "runner", "hud"])
  for (const [shape, body] of Object.entries({
    refusalWithIdentity: { ok: false, ...child },
    pendingWithIdentity: { pending: true, ...child },
    refusalWithRuntime: {
      ok: false,
      workerPid: 2147483647,
      daemonStateFile: "/unstarted-fixture-only",
    },
    bareRefusal: { blocked: true },
    empty: {},
    accepted: { accepted: true, ...child },
  }))
    for (const [name, wrap] of Object.entries(wraps)) {
      test(`${entry}/${shape}/${name}`, async () => {
        const label = [entry, shape, name].join("-"),
          dir = setup(label),
          raw = wrap(body);
        let calls = 0;
        const invoke = async () => {
          calls++;
          return raw;
        };
        let results = [],
          hud;
        if (entry === "journal") {
          await k.startMissionRun(dir);
          const state = k.loadState(dir),
            feature = k.loadFeaturesDoc(dir).features[0];
          const intent = prepareDispatch(dir, {
            state,
            feature,
            worker: state.activeWorker,
            target: state.activeWorker,
          });
          for (let i = 0; i < 2; i++)
            results.push(await tolerate(() => dispatchWithIntent(dir, intent, invoke)));
        } else if (entry === "runner")
          for (let i = 0; i < 2; i++)
            results.push(await tolerate(() => k.startMissionRun(dir, {}, { runFeature: invoke })));
        else {
          k.rejectMissionPlan(dir, "seed unapproved");
          hud = await createHandlerHud({ missionDir: dir, runtimeAdapter: { runFeature: invoke } });
          try {
            for (let i = 0; i < 2; i++)
              results.push(await hud.post("approve", { commandId: "approve-" + i }));
          } finally {
            await hud.close();
          }
        }
        const row = {
          entry,
          shape,
          container: name,
          raw,
          calls,
          results,
          journals: journals(dir),
          state: k.loadState(dir),
          verdict: classifyControlReceipt(raw, "dispatch", {}),
        };
        fs.writeFileSync(path.join(out, label + ".json"), JSON.stringify(row, null, 2));
        assert.equal(
          calls,
          shape === "bareRefusal" ? 2 : 1,
          "Only proven nonacceptance may invoke the original dispatch again",
        );
        if (
          ["refusalWithIdentity", "pendingWithIdentity", "refusalWithRuntime", "empty"].includes(
            shape,
          )
        )
          assert.equal(
            row.journals[0].phase,
            "inflight",
            "Evidence that a child may exist must stay fenced",
          );
      });
    }
