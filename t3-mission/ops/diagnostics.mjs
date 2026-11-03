import { randomUUID } from "node:crypto";
import { createLogger, scrubText } from "./logger.mjs";
/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {{requestId: string, operation: string}} RequestContext */
/** @typedef {{timestamp: string, requestId: string, operation: string, code: string, message: string, stack: string}} ErrorRecord */
const featureOperations = new Set([
  "openHud",
  "getMissionState",
  "approveMission",
  "rejectMission",
  "updateModelSlots",
  "pauseMission",
  "resumeMission",
]);

/** @param {{write?: (line: string) => void, now?: () => number}} [options] */
export function createDiagnostics(options = {}) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const log = createLogger(options);
  /** @type {Map<string, {operation: string, status: number, count: number, durationMs: number}>} */
  const requests = new Map();
  /** @type {Map<string, number>} */
  const usage = new Map();
  /** @type {ErrorRecord[]} */
  const errors = [];

  /** @param {unknown} error @param {RequestContext} context */
  function recordError(error, context) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "INTERNAL_ERROR";
    const record = {
      timestamp: new Date(now()).toISOString(),
      requestId: scrubText(context.requestId),
      operation: context.operation,
      code: scrubText(code),
      message: scrubText(error instanceof Error ? error.message : String(error)),
      stack: scrubText(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    };
    errors.push(record);
    if (errors.length > 20) errors.shift();
    log("error", "http_error", record);
    return record;
  }

  /** @param {IncomingMessage} req @param {ServerResponse} res @param {string} operation @returns {RequestContext} */
  function beginRequest(req, res, operation) {
    const suppliedId = req.headers["x-request-id"];
    const requestId =
      typeof suppliedId === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(suppliedId)
        ? suppliedId
        : randomUUID();
    const start = now();
    res.setHeader("X-Request-ID", requestId);
    res.once("finish", () => {
      const key = `${operation}:${res.statusCode}`;
      const row = requests.get(key) ?? {
        operation,
        status: res.statusCode,
        count: 0,
        durationMs: 0,
      };
      row.count++;
      row.durationMs += Math.max(0, now() - start);
      requests.set(key, row);
      if (res.statusCode >= 200 && res.statusCode < 300 && featureOperations.has(operation))
        usage.set(operation, (usage.get(operation) ?? 0) + 1);
      if (res.statusCode >= 500)
        log("error", "http_failure", { requestId, operation, status: res.statusCode });
    });
    return { requestId, operation };
  }

  function snapshot() {
    return {
      uptimeSeconds: Math.max(0, now() - startedAt) / 1000,
      requests: [...requests.values()].map((row) => ({ ...row })),
      featureUsage: Object.fromEntries(usage),
      recentErrors: structuredClone(errors),
    };
  }

  function metrics() {
    const lines = [
      "# HELP t3_mission_http_requests_total Completed HTTP requests by fixed operation and status.",
      "# TYPE t3_mission_http_requests_total counter",
    ];
    for (const row of requests.values())
      lines.push(
        `t3_mission_http_requests_total{operation="${row.operation}",status="${row.status}"} ${row.count}`,
      );
    lines.push(
      "# HELP t3_mission_http_duration_seconds_sum Total HTTP request duration.",
      "# TYPE t3_mission_http_duration_seconds_sum counter",
    );
    for (const row of requests.values())
      lines.push(
        `t3_mission_http_duration_seconds_sum{operation="${row.operation}",status="${row.status}"} ${row.durationMs / 1000}`,
      );
    lines.push(
      "# HELP t3_mission_feature_uses_total Successful local feature interactions.",
      "# TYPE t3_mission_feature_uses_total counter",
    );
    for (const [operation, count] of usage)
      lines.push(`t3_mission_feature_uses_total{operation="${operation}"} ${count}`);
    lines.push(
      "# HELP t3_mission_uptime_seconds HTTP process uptime.",
      "# TYPE t3_mission_uptime_seconds gauge",
      `t3_mission_uptime_seconds ${Math.max(0, now() - startedAt) / 1000}`,
    );
    return lines.join("\n") + "\n";
  }

  return { beginRequest, recordError, snapshot, metrics };
}
