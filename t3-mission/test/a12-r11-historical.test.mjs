import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { inspectDispatchRecords } from "../kernel/dispatch-journal.mjs";
import {
  init,
  tick,
  now,
  observation,
  status,
  ledger,
  fresh,
  reapprove,
} from "./fixtures/a10-fixture.mjs";
for (const tagged of [false, true])
  test("R11 historical encoded recovery page owns original task tagged=" + tagged, async () => {
    const d = init("historical-recovery-" + tagged);
    await assert.rejects(() =>
      k.startMissionRun(
        d,
        {},
        { runFeature: async () => ({ accepted: false, code: "PROVIDER_BUSY" }) },
      ),
    );
    const old = inspectDispatchRecords(d)[0];
    reapprove(d, "replacement-model");
    await k.startMissionRun(
      d,
      {},
      {
        runFeature: async () => ({
          accepted: true,
          taskId: "current-task",
          childThreadId: "current-thread",
          childRunId: "current-turn",
        }),
      },
    );
    const suffix =
      ":delegated-task:" +
      encodeURIComponent("command:mcp:original-owner:delegate-task:" + old.intent.clientRequestId);
    const a = {
      featureId: "f1",
      runId: old.intent.runId,
      intentId: old.intent.clientRequestId,
      taskId: "node" + suffix,
      childThreadId: "thread" + suffix,
      attempt: 1,
    };
    const child = { id: a.childThreadId, parentThreadId: "owner" };
    const poll = await tick(d, [observation(a, { threads: [child] }, "children")], now + 1000);
    assert.equal(poll.type, "poll");
    assert.equal(poll.taskId, a.taskId);
    assert.equal(poll.intentId, a.intentId);
    const stop = status(a, "cancelled");
    if (!tagged) delete stop.intentId;
    const before = ledger(d);
    const reply = fresh(d, "tick", { observations: [stop], now: now + 1001 });
    const control = fresh(d, "tick", { observations: [status(a, "cancelled")], now: now + 1002 });
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, "historical-recovery-" + tagged + ".json"),
      JSON.stringify(
        { d, old, a, child, poll, stop, before, reply, control, after: ledger(d) },
        null,
        2,
      ) + "\n",
    );
    assert.equal(control.ok, true);
    assert.equal(ledger(d).runs[a.runId].statusError, undefined);
    assert.equal(
      reply.ok,
      true,
      "An already requested original-task poll must resolve ownership from the valid recovery page",
    );
    assert.equal(Object.values(ledger(d).dispatchResolutions ?? {}).length, tagged ? 1 : 2);
  });
