import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, redact, scrubText } from "../ops/logger.mjs";
import { createDiagnostics } from "../ops/diagnostics.mjs";
import { hasAsciiControlCharacters } from "../kernel/text-validation.mjs";

const token = "ghp_" + "a".repeat(32);
test("structured diagnostics redact nested credentials without changing useful context", () => {
  const lines = [];
  const log = createLogger({
    write: (line) => {
      lines.push(line);
    },
    now: () => 0,
  });
  const value = {
    requestId: "request-17",
    token,
    nested: {
      password: "do-not-log",
      message: `Bearer ${token} owner@example.invalid /Users/test/private.txt`,
    },
  };
  log("error", "request_failed", value);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "1970-01-01T00:00:00.000Z",
    level: "error",
    event: "request_failed",
    context: {
      requestId: "request-17",
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", message: "Bearer [REDACTED] [EMAIL] [LOCAL_PATH]" },
    },
  });
  assert.equal(value.token, token);
});

test("redaction bounds cyclic and deep values and survives an unavailable destination", () => {
  const cyclic = { ok: true };
  cyclic.self = cyclic;
  assert.deepEqual(redact(cyclic), { ok: true, self: "[CIRCULAR]" });
  assert.equal(
    scrubText("api_key=hidden token:secret-value password=not-public"),
    "api_key=[REDACTED] token=[REDACTED] password=[REDACTED]",
  );
  assert.doesNotThrow(() =>
    createLogger({
      write: () => {
        throw new Error("closed pipe");
      },
    })("info", "cleanup"),
  );
  assert.equal(scrubText("x".repeat(3000)).length, 2048);
});

test("the error ring keeps the latest 20 contextualized errors with scrubbed stacks", () => {
  const lines = [];
  const diagnostics = createDiagnostics({
    write: (line) => {
      lines.push(line);
    },
    now: () => 1000,
  });
  for (let i = 0; i < 25; i++)
    diagnostics.recordError(
      Object.assign(new Error(`failure ${i} ${token}`), { code: "TX_BUSY" }),
      { requestId: `request-${i}`, operation: "getMissionState" },
    );
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.recentErrors.length, 20);
  assert.equal(snapshot.recentErrors[0].requestId, "request-5");
  assert.equal(snapshot.recentErrors.at(-1).code, "TX_BUSY");
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  snapshot.recentErrors.length = 0;
  assert.equal(diagnostics.snapshot().recentErrors.length, 20);
  assert.equal(lines.length, 25);
});

test("ASCII identity checks reject controls and preserve the existing tab/LF-only text exception", () => {
  const allowedTextControls = new Set([9, 10]);
  for (let code = 0; code < 32; code++) {
    assert.equal(
      hasAsciiControlCharacters(String.fromCharCode(code)),
      true,
      `identity control ${code}`,
    );
    assert.equal(
      hasAsciiControlCharacters(String.fromCharCode(code), true),
      !allowedTextControls.has(code),
      `text control ${code}`,
    );
  }
  for (const value of ["", "normal-id", "中文说明", "id-123", "DEL\u007f"])
    assert.equal(hasAsciiControlCharacters(value), false);
});

test("credential keys and secret-shaped request IDs are scrubbed before retention", () => {
  assert.deepEqual(
    redact({ apiKey: "opaque-value", api_key: "opaque-value", accessKey: "opaque-value" }),
    { apiKey: "[REDACTED]", api_key: "[REDACTED]", accessKey: "[REDACTED]" },
  );
  const diagnostics = createDiagnostics({ write: () => {} });
  diagnostics.recordError(new Error("failed"), { requestId: token, operation: "getMissionState" });
  assert.equal(diagnostics.snapshot().recentErrors[0].requestId, "[REDACTED]");
});
