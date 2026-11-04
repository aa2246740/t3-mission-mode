import { callT3McpTool } from "../bridge/t3-adapter.mjs";

function steeringError(message, statusCode = 400, code = "INVALID_STEERING_REQUEST") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function validateSteeringRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw steeringError("A steering request must be a JSON object.");
  if (typeof body.message !== "string" || !body.message.trim())
    throw steeringError("message must be a non-empty string.");
  for (const key of ["sessionId", "runId", "featureId", "childThreadId"]) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || !body[key].trim()))
      throw steeringError(`${key} must be a non-empty string when supplied.`);
  }
  return { ...body, message: body.message.trim() };
}

export function sessionThreadId(session) {
  for (const value of [session.childThreadId, session.threadId, session.threadUri, session.link]) {
    if (typeof value !== "string" || !value) continue;
    const uri = /^t3-thread:\/\/v1\/([^/?#\s]+)(?:[?#].*)?$/.exec(value);
    if (uri) return uri[1];
    if (!/[\s:/?#]/.test(value)) return value;
  }
  return null;
}

function matchesSelectors(session, selectors) {
  return (
    (!selectors.sessionId ||
      [session.sessionId, session.runId, session.id].includes(selectors.sessionId)) &&
    (!selectors.runId || session.runId === selectors.runId) &&
    (!selectors.featureId || session.featureId === selectors.featureId) &&
    (!selectors.childThreadId || sessionThreadId(session) === sessionThreadId(selectors))
  );
}

function featureSessions(features) {
  return features.map((feature) => {
    const handoff = ["running", "paused", "pending"].includes(feature.status)
      ? {}
      : feature.lastHandoff || {};
    return { ...handoff, ...feature, featureId: feature.id, runId: feature.runId || handoff.runId };
  });
}

export function resolveSteeringTarget(state, selectors, features = []) {
  const sessions = [
    ...featureSessions(features),
    ...(state.sessions || []),
    state.activeWorker,
  ].filter(Boolean);
  const hasSelector = ["sessionId", "runId", "featureId", "childThreadId"].some(
    (key) => selectors[key] !== undefined,
  );
  const session = hasSelector
    ? sessions.findLast((row) => matchesSelectors(row, selectors))
    : state.activeWorker;
  if (session) {
    const threadId = sessionThreadId(session);
    if (!threadId)
      throw steeringError("This session has no thread yet.", 409, "THREAD_UNAVAILABLE");
    return { ...session, threadId };
  }
  const owner = sessionThreadId({ childThreadId: state.ownerThreadId });
  const ownerSelected = selectors.childThreadId && sessionThreadId(selectors) === owner;
  const sessionSelected = selectors.sessionId || selectors.runId || selectors.featureId;
  if (owner && !sessionSelected && (!hasSelector || ownerSelected)) return { threadId: owner };
  throw steeringError("No matching thread is bound to this Mission.", 404, "SESSION_NOT_FOUND");
}

/** Provider calls run outside the Mission transaction. Missing transport records locally. */
export async function sendLiveThread(threadId, message, options = { env: process.env }) {
  if (!options.transportClient && !options.env.T3_ACP_MCP_NODE) return "recorded";
  const response = await callT3McpTool("t3_thread_send", { threadId, message }, options);
  if (response?.isError || response?.ok === false || response?.accepted === false)
    throw steeringError("The T3 bridge refused the steering instruction.", 502, "STEERING_FAILED");
  return "sent";
}
