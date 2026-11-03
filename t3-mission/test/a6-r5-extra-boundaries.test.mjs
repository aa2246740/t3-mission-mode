import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { classifyControlReceipt } from "../kernel/schema.mjs";
import { prepareDispatch, dispatchWithIntent } from "../kernel/dispatch-journal.mjs";
const root = process.env.R9_EVIDENCE_DIR;
const child = {
  taskId: "existing-task",
  childThreadId: "existing-thread",
  childRunId: "existing-run",
};
const nested = (x) => ({
  response: {
    delegation: { structuredContent: { content: [{ type: "text", text: JSON.stringify(x) }] } },
  },
});
for (const op of ["dispatch", "pause", "interrupt", "resume"])
  for (const [name, raw, expected] of [
    ["deep-refusal", nested({ ...child, accepted: false }), "rejected"],
    ["deep-pending", nested({ ...child, pending: true }), "pending"],
    [
      "deep-foreign",
      nested({ ...child, childRunId: "foreign", accepted: true }),
      "identity_conflict",
    ],
    [
      "large-extra",
      {
        ...child,
        ...(op === "dispatch"
          ? { accepted: true }
          : op === "resume"
            ? { sent: true }
            : { paused: true }),
        unrecognized: "x".repeat(1024 * 1024),
      },
      "confirmed",
    ],
    ["array-structured", { structuredContent: [{ ...child, accepted: true }] }, "unknown"],
    [
      "array-text",
      { content: [{ type: "text", text: JSON.stringify([{ ...child, accepted: true }]) }] },
      "unknown",
    ],
  ])
    test(`Additional shape ${op}/${name}`, () => {
      const v = classifyControlReceipt(raw, op, child);
      fs.writeFileSync(
        path.join(root, op + "-" + name + ".json"),
        JSON.stringify(
          {
            operation: op,
            name,
            raw:
              name === "large-extra" ? { ...raw, unrecognized: "[generated 1 MiB x string]" } : raw,
            rawStringBytes: JSON.stringify(raw).length,
            expected,
            actual: v.classification,
            diagnostics: v.diagnostics,
          },
          null,
          2,
        ),
      );
      assert.equal(v.classification, expected);
    });
for (const [name, raw] of Object.entries({
  arrayResponse: { ok: false, response: [{ ...child, accepted: true }] },
  arrayStructured: { ok: false, structuredContent: [{ ...child, accepted: true }] },
  arrayText: {
    ok: false,
    content: [{ type: "text", text: JSON.stringify([{ ...child, accepted: true }]) }],
  },
}))
  test("Malformed refusal with unclassified child " + name, async () => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    k.proposeMission(dir, { title: name, repoPath: dir, features: [{ id: "f1" }] });
    k.approveMissionPlan(dir);
    await k.startMissionRun(dir);
    const state = k.loadState(dir),
      feature = k.loadFeaturesDoc(dir).features[0],
      intent = prepareDispatch(dir, {
        state,
        feature,
        worker: state.activeWorker,
        target: state.activeWorker,
      });
    let calls = 0,
      errors = [];
    for (let i = 0; i < 2; i++)
      try {
        await dispatchWithIntent(dir, intent, async () => {
          calls++;
          return raw;
        });
      } catch (e) {
        errors.push({ code: e.code, message: e.message });
      }
    const verdict = classifyControlReceipt(raw, "dispatch", {}),
      journal = fs
        .readdirSync(path.join(dir, ".mission"))
        .filter((n) => /^dispatch-.*\.json$/.test(n))
        .map((n) => JSON.parse(fs.readFileSync(path.join(dir, ".mission", n))));
    fs.writeFileSync(
      path.join(root, name + ".json"),
      JSON.stringify({ raw, verdict, journal, calls, errors }, null, 2),
    );
    assert.equal(
      calls,
      1,
      "Malformed envelopes cannot prove that their hidden child did not start",
    );
    assert.equal(journal[0].phase, "inflight");
  });
