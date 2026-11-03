import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
test("A8 prepared invocation survives SIGKILL before entering the executor", async () => {
  const d = fs.mkdtempSync(
    path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a8-prepared-wal-"),
  );
  k.proposeMission(d, { title: "Prepared call crash", repoPath: d, features: [{ id: "f1" }] });
  k.approveMissionPlan(d);
  const script = `import fs from 'node:fs';import * as k from ${JSON.stringify(new URL("../kernel/index.mjs", import.meta.url).href)};
 const d=process.argv[1],rename=fs.renameSync;fs.renameSync=function(a,b,...args){const r=rename.call(this,a,b,...args);if(/dispatch-[a-f0-9]+\\.json$/.test(String(b))){const record=JSON.parse(fs.readFileSync(b));if(record.invocations?.at(-1)?.phase==='prepared')process.kill(process.pid,'SIGKILL');}return r;};await k.startMissionRun(d,{}, {runFeature:async()=>{fs.writeFileSync(d+'/unexpected-execution','called');return {};}});`;
  const child = cp.spawnSync(process.execPath, ["--input-type=module", "-e", script, d], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(fs.existsSync(path.join(d, "unexpected-execution")), false);
  const record = inspectDispatchRecords(d)[0];
  assert.equal(record.phase, "inflight");
  assert.equal(record.invocations.length, 1);
  assert.equal(record.invocations[0].phase, "prepared");
  assert.deepEqual(record.invocations[0].phases, ["prepared"]);
  let calls = 0;
  await assert.rejects(
    () =>
      k.startMissionRun(
        d,
        {},
        {
          runFeature: async () => {
            calls++;
            return {};
          },
        },
      ),
    { code: "DISPATCH_OUTCOME_UNKNOWN" },
  );
  assert.equal(calls, 0);
  assert.equal(inspectDispatchRecords(d)[0].intent.clientRequestId, record.intent.clientRequestId);
});
test("A8 prepared, inflight and returned are durable facts around the callback", async () => {
  const d = fs.mkdtempSync(path.join(process.env.R9_EVIDENCE_DIR ?? os.tmpdir(), "a8-phases-"));
  k.proposeMission(d, { title: "Call phases", repoPath: d, features: [{ id: "f1" }] });
  k.approveMissionPlan(d);
  let id;
  await assert.rejects(
    () =>
      k.startMissionRun(
        d,
        {},
        {
          runFeature: async () => {
            const record = inspectDispatchRecords(d)[0];
            id = record.invocations[0].invocationId;
            assert.equal(record.invocations[0].phase, "inflight");
            assert.deepEqual(record.invocations[0].phases, ["prepared", "inflight"]);
            return { accepted: false };
          },
        },
      ),
    { code: "DISPATCH_REJECTED" },
  );
  const record = inspectDispatchRecords(d)[0];
  assert.equal(record.phase, "retryable");
  assert.equal(record.invocations[0].invocationId, id);
  assert.deepEqual(record.invocations[0].phases, ["prepared", "inflight", "returned"]);
});
