import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createMissionHudServer } from "../hud/server.mjs";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-security-"));
  const logs = [];
  const hud = await createMissionHudServer({
    missionDir: dir,
    port: 0,
    allowLocalDaemon: false,
    notifyUrl: null,
    diagnosticWriter: (line) => {
      logs.push(line);
    },
  });
  t.after(async () => {
    await hud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { hud, dir, logs };
}
const options = { signal: AbortSignal.timeout(5000) };

test("real HTTP health/state requests expose security headers and fixed local metrics", async (t) => {
  const { hud, dir } = await fixture(t);
  const state = await fetch(hud.url + "/api/mission/state", {
    ...options,
    headers: { "X-Request-ID": "qa-request-17" },
  });
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("X-Request-ID"), "qa-request-17");
  assert.equal(state.headers.get("access-control-allow-origin"), null);
  assert.equal(state.headers.get("x-content-type-options"), "nosniff");
  assert.equal(state.headers.get("x-frame-options"), "DENY");
  assert.match(state.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await state.json()).state.initialized, false);
  for (const route of ["/healthz", "/readyz"]) {
    const response = await fetch(hud.url + route, options);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const diagnostic = await (await fetch(hud.url + "/api/mission/diagnostics", options)).json();
  assert.equal(diagnostic.featureUsage.getMissionState, 1);
  const metrics = await (await fetch(hud.url + "/metrics", options)).text();
  assert.match(
    metrics,
    /t3_mission_http_requests_total\{operation="getMissionState",status="200"\} 1/,
  );
  assert.match(metrics, /t3_mission_feature_uses_total\{operation="getMissionState"\} 1/);
  assert.equal(metrics.includes(dir), false);
  assert.equal(fs.existsSync(path.join(dir, ".mission")), false);
});

for (const method of ["GET", "POST", "OPTIONS"])
  test(`cross-origin ${method} is refused before any Mission write`, async (t) => {
    const { hud, dir } = await fixture(t);
    const response = await fetch(
      hud.url + (method === "GET" ? "/api/mission/state" : "/api/mission/pause"),
      {
        ...options,
        method,
        headers: { Origin: "https://attacker.example" },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "CROSS_ORIGIN_REQUEST");
    assert.equal(fs.existsSync(path.join(dir, ".mission")), false);
  });

test("matching Origin works while cross-site fetch metadata remains blocked", async (t) => {
  const { hud } = await fixture(t);
  const good = await fetch(hud.url + "/healthz", { ...options, headers: { Origin: hud.url } });
  assert.equal(good.status, 200);
  await good.text();
  const blocked = await fetch(hud.url + "/healthz", {
    ...options,
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(blocked.status, 403);
  await blocked.text();
});

test("foreign Host headers are refused against a running loopback service", async (t) => {
  const { hud, dir } = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const request = http.get(
      hud.url + "/api/mission/state",
      { headers: { Host: `attacker.example:${hud.port}` } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("HTTP test timed out")));
    request.on("error", reject);
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "UNTRUSTED_HOST");
  assert.equal(fs.existsSync(path.join(dir, ".mission")), false);
});

for (const body of ['{"token":"private-value",', "null", "[]", "17", '"text"'])
  test(`invalid JSON command shape is rejected: ${body.slice(0, 16)}`, async (t) => {
    const { hud } = await fixture(t);
    const response = await fetch(hud.url + "/api/mission/model-slots", {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, "INVALID_JSON_BODY");
    assert.equal(JSON.stringify(result).includes("private-value"), false);
  });

test("oversized command bodies receive 413 and do not update model settings", async (t) => {
  const { hud, dir } = await fixture(t);
  const response = await fetch(hud.url + "/api/mission/model-slots", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "x".repeat(1024 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "BODY_TOO_LARGE");
  assert.equal(fs.existsSync(path.join(dir, ".mission", "model-settings.json")), false);
});

test("unknown URLs cannot become unbounded metric labels or leak local paths", async (t) => {
  const { hud, dir } = await fixture(t);
  const response = await fetch(hud.url + "/private-user-content-123", options);
  assert.equal(response.status, 404);
  await response.text();
  const diagnostics = await (await fetch(hud.url + "/api/mission/diagnostics", options)).json();
  assert.equal(
    diagnostics.requests.some((row) => row.operation === "unknown" && row.status === 404),
    true,
  );
  assert.equal(JSON.stringify(diagnostics).includes("private-user-content-123"), false);
  assert.equal(JSON.stringify(diagnostics).includes(dir), false);
});
