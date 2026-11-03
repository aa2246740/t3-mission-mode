import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as k from "../kernel/index.mjs";
import { createHandlerHud } from "./hud-handler-fixture.mjs";
const modes = {
  empty: {},
  pending: { dispatchPending: true },
  nested: { response: { pending: true } },
  refused: { accepted: false, code: "PROVIDER_BUSY" },
  confirmed: { ok: true, interrupted: true },
};
for (const [name, raw] of Object.entries(modes))
  test("Default HUD to actual CLI Pause evidence " + name, async () => {
    const d = path.join(process.env.R9_EVIDENCE_DIR, name);
    fs.mkdirSync(d);
    k.proposeMission(d, { title: name, repoPath: d, features: [{ id: "f1" }] });
    k.approveMissionPlan(d);
    await k.startMissionRun(
      d,
      {},
      {
        runFeature: async () => ({
          accepted: true,
          taskId: "original-task",
          childThreadId: "original-thread",
          runtimeTransport: "t3-delegate-task",
        }),
      },
    );
    const shim = path.join(d, "protocol-fixture.mjs");
    fs.writeFileSync(
      shim,
      "import fs from 'node:fs';fs.appendFileSync(" +
        JSON.stringify(path.join(d, "private-calls.jsonl")) +
        ",JSON.stringify(process.argv.slice(2))+'\\n');console.log(" +
        JSON.stringify(JSON.stringify(raw)) +
        ");",
    );
    const oldN = process.env.T3_ACP_MCP_NODE,
      oldE = process.env.T3_ACP_MCP_ENTRYPOINT;
    process.env.T3_ACP_MCP_NODE = process.execPath;
    process.env.T3_ACP_MCP_ENTRYPOINT = shim;
    let hud, reply;
    try {
      hud = await createHandlerHud({ missionDir: d });
      reply = await hud.post("pause");
    } finally {
      await hud?.close();
      if (oldN === undefined) delete process.env.T3_ACP_MCP_NODE;
      else process.env.T3_ACP_MCP_NODE = oldN;
      if (oldE === undefined) delete process.env.T3_ACP_MCP_ENTRYPOINT;
      else process.env.T3_ACP_MCP_ENTRYPOINT = oldE;
    }
    const state = k.loadState(d),
      calls = fs.readFileSync(path.join(d, "private-calls.jsonl"), "utf8").trim().split("\n");
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, name + ".json"),
      JSON.stringify({ raw, reply, state, calls }, null, 2),
    );
    assert.equal(calls.length, 1);
    assert.equal(state.status, "paused");
    assert.equal(
      state.activeWorker.status,
      name === "confirmed" ? "paused" : "running",
      "An unconfirmed private transport response cannot prove the child was interrupted",
    );
    assert.equal(reply.status, name === "confirmed" ? 200 : 409);
  });
