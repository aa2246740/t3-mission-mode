/** @typedef {{method: 'GET'|'POST', path: string, operationId: string, summary: string, kind: 'read'|'write'|'stream'}} HudRoute */
/** @type {readonly HudRoute[]} */
export const HUD_ROUTES = Object.freeze([
  {
    method: "GET",
    path: "/",
    operationId: "openHud",
    summary: "Open the Mission HUD",
    kind: "read",
  },
  {
    method: "GET",
    path: "/index.html",
    operationId: "openHud",
    summary: "Open the Mission HUD",
    kind: "read",
  },
  {
    method: "GET",
    path: "/app.js",
    operationId: "getScript",
    summary: "Load the HUD script",
    kind: "read",
  },
  {
    method: "GET",
    path: "/styles.css",
    operationId: "getStyles",
    summary: "Load HUD styles",
    kind: "read",
  },
  {
    method: "GET",
    path: "/style.css",
    operationId: "getStyles",
    summary: "Load HUD styles",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/mission/state",
    operationId: "getMissionState",
    summary: "Read a consistent Mission snapshot",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/mission/thread-feed",
    operationId: "getThreadFeed",
    summary: "Read recent Mission observations and bound session thread messages",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/mission/stream",
    operationId: "streamMission",
    summary: "Subscribe to Mission snapshots",
    kind: "stream",
  },
  {
    method: "GET",
    path: "/api/mission/events",
    operationId: "streamMission",
    summary: "Subscribe to Mission snapshots",
    kind: "stream",
  },
  {
    method: "POST",
    path: "/api/mission/approve",
    operationId: "approveMission",
    summary: "Approve the current plan",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/mission/reject",
    operationId: "rejectMission",
    summary: "Request plan changes",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/mission/model-slots",
    operationId: "updateModelSlots",
    summary: "Update model settings",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/mission/pause",
    operationId: "pauseMission",
    summary: "Commit the Pause gate and request runtime control",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/mission/resume",
    operationId: "resumeMission",
    summary: "Preflight and resume the bound run",
    kind: "write",
  },
  {
    method: "POST",
    path: "/api/mission/steer",
    operationId: "steerSession",
    summary: "Send a steering instruction to a bound Mission thread or record it locally",
    kind: "write",
  },
  {
    method: "GET",
    path: "/healthz",
    operationId: "getHealth",
    summary: "Check HTTP process liveness",
    kind: "read",
  },
  {
    method: "GET",
    path: "/readyz",
    operationId: "getReadiness",
    summary: "Check whether a Mission snapshot can be read",
    kind: "read",
  },
  {
    method: "GET",
    path: "/metrics",
    operationId: "getMetrics",
    summary: "Read local aggregate Prometheus metrics",
    kind: "read",
  },
  {
    method: "GET",
    path: "/api/mission/diagnostics",
    operationId: "getDiagnostics",
    summary: "Read aggregate usage and recent redacted errors",
    kind: "read",
  },
]);

/** @param {string} method @param {string} pathname */
export function findHudRoute(method, pathname) {
  return HUD_ROUTES.find((route) => route.method === method && route.path === pathname);
}
