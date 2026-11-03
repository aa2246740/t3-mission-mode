import test from "node:test";
import assert from "node:assert/strict";
import { callT3McpTool } from "../bridge/t3-adapter.mjs";
for (const mode of ["content", "structuredContent"])
  for (const tool of ["t3_thread_send", "t3_thread_interrupt"])
    for (const transport of ["function", "callTool", "call", "named"])
      test(`A4 bridge rejects operation-specific outer control refusal ${mode} ${tool} ${transport}`, async () => {
        const refusal =
          tool === "t3_thread_send"
            ? { resumed: false, sent: false }
            : { interrupted: false, paused: false };
        const positive =
          tool === "t3_thread_send"
            ? { sent: true, resumed: true }
            : { interrupted: true, paused: true };
        const inner = { ok: true, threadId: "original", ...positive };
        const raw = {
          ok: true,
          ...refusal,
          ...(mode === "content"
            ? { content: [{ type: "text", text: JSON.stringify(inner) }] }
            : { structuredContent: inner }),
        };
        let calls = 0;
        const invoke = async () => {
          calls++;
          return raw;
        };
        const transportClient =
          transport === "function"
            ? invoke
            : { [transport === "named" ? tool : transport]: invoke };
        await assert.rejects(
          callT3McpTool(tool, { threadId: "original" }, { transportClient }),
          (error) => error.code === "T3_OBSERVATION_ERROR" && error.runtimeResult === raw,
        );
        assert.equal(calls, 1);
      });
