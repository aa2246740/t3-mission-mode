import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMissionHudServer } from "../t3-mission/hud/server.mjs";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "t3-mission-qa-"));
const iterations = process.argv.includes("--profile") ? 100 : 1;
let hud;
try {
  hud = await createMissionHudServer({
    missionDir: workspace,
    port: 0,
    notifyUrl: null,
    allowLocalDaemon: false,
  });
  for (const route of ["/", "/healthz", "/readyz"]) {
    const response = await fetch(hud.url + route, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, route);
    await response.text();
  }
  for (let i = 0; i < iterations; i++) {
    const response = await fetch(hud.url + "/api/mission/state", {
      signal: AbortSignal.timeout(5000),
      headers: { "X-Request-ID": "standalone-qa" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Request-ID"), "standalone-qa");
    const snapshot = await response.json();
    assert.equal(snapshot.state.initialized, false);
    assert.deepEqual(snapshot.features, []);
  }
  const settings = await fetch(hud.url + "/api/mission/model-slots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      worker: { providerInstanceId: "codex", model: "gpt-6.1-sol", effort: 4 },
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(settings.status, 200);
  await settings.json();
  const snapshot = await (
    await fetch(hud.url + "/api/mission/state", { signal: AbortSignal.timeout(5000) })
  ).json();
  assert.equal(snapshot.modelSettings.worker.model, "gpt-6.1-sol");
  assert.equal(snapshot.state.activeWorker, null);
  const diagnostics = await (
    await fetch(hud.url + "/api/mission/diagnostics", { signal: AbortSignal.timeout(5000) })
  ).json();
  assert.ok(diagnostics.featureUsage.getMissionState >= iterations);
  const metrics = await (
    await fetch(hud.url + "/metrics", { signal: AbortSignal.timeout(5000) })
  ).text();
  assert.match(metrics, /t3_mission_http_requests_total/);
  assert.deepEqual(
    fs
      .readdirSync(path.join(workspace, ".mission"))
      .filter((name) => /^dispatch-.*\.json$/.test(name)),
    [],
  );
  console.log(
    JSON.stringify({
      ok: true,
      layer: "local-http-and-filesystem",
      authentication: "loopback/no credentials",
      iterations,
      checks: [
        "onboarding",
        "liveness",
        "readiness",
        "state",
        "request-id",
        "model-settings",
        "aggregate-usage",
        "metrics",
      ],
      providerDispatch: false,
    }),
  );
} finally {
  await hud?.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
