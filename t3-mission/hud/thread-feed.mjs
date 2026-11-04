import fs from "node:fs";
import path from "node:path";

const MAX_EVENTS = 50;
const MAX_TAIL_BYTES = 256 * 1024;

function readJson(file) {
  try {
    if (fs.statSync(file).size > MAX_TAIL_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fileTime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function archivedObservation({ file, time }) {
  const record = readJson(file);
  if (!record) return null;
  const event = record.observation ?? record;
  return { ...event, timestamp: event.timestamp || new Date(time).toISOString() };
}

function readJsonLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const { size, mtimeMs } = fs.fstatSync(fd);
    const offset = Math.max(0, size - MAX_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_TAIL_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (offset > 0) lines.shift();
    return lines
      .filter(Boolean)
      .slice(-MAX_EVENTS)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== "object" || Array.isArray(event)) return [];
          return [{ ...event, timestamp: event.timestamp || new Date(mtimeMs).toISOString() }];
        } catch {
          // An external writer may still be appending the final line.
          return [];
        }
      });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function observationFiles(missionDir) {
  const directory = path.join(missionDir, "autopilot", "observations");
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => /^[a-f0-9]+\.json$/.test(name))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

export function readRecentObservations(missionDir) {
  const archived = observationFiles(missionDir)
    .map((file) => ({ file, time: fileTime(file) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_EVENTS)
    .reverse()
    .map(archivedObservation)
    .filter(Boolean);
  return [
    ...archived,
    ...readJsonLines(path.join(missionDir, "observations.jsonl")),
    ...readJsonLines(path.join(missionDir, "autopilot", "observations.jsonl")),
  ]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-MAX_EVENTS);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item.text || "")
    .filter(Boolean)
    .join("\n");
}

function eventText(event) {
  if (typeof event === "string") return event;
  const response = event.response?.structuredContent ?? event.response ?? {};
  return (
    event.message ||
    event.text ||
    event.command ||
    event.summary ||
    contentText(event.content) ||
    response.message ||
    response.lastMessage ||
    response.summary ||
    contentText(response.content) ||
    response.status ||
    ""
  );
}

function feedRole(row, explicitRole) {
  if (!explicitRole && row.type === "reasoning") return "Worker · Thinking";
  if (!explicitRole && row.type === "command_execution") return "Worker · Command";
  return String(row.role || row.source || "Orchestrator");
}

export function normalizeFeedEvent(raw, defaults = {}) {
  const event = typeof raw === "string" ? { message: raw } : raw;
  if (!event || typeof event !== "object" || event.type === "model_slots_updated") return null;
  const message = eventText(event);
  if (!message) return null;
  const row = { ...defaults, ...event };
  return {
    type: String(row.type || "message"),
    role: feedRole(row, event.role),
    message: String(message).slice(0, 6000),
    timestamp: row.timestamp || row.updatedAt || row.createdAt || row.startedAt || null,
    threadId: row.childThreadId || row.threadId || null,
    sessionId: row.sessionId || null,
    runId: row.runId || null,
    featureId: row.featureId || null,
    workerNumber: row.workerNumber ?? null,
  };
}

function sessionFeed(session) {
  const defaults = { ...session, threadId: session.childThreadId || session.threadId };
  return [
    {
      type: "session_status",
      message: `${session.featureTitle || session.title || session.featureId || "Session"}: ${session.status || "pending"}`,
    },
    session.lastMessage,
    session.liveOutput,
    ...(Array.isArray(session.recentEvents) ? session.recentEvents : []),
  ]
    .map((row) => normalizeFeedEvent(row, defaults))
    .filter(Boolean);
}

export function buildThreadFeed(state, observations, progressLog) {
  const sessions = [...(state.sessions || [])];
  if (state.activeWorker) {
    const index = sessions.findIndex((row) => row.runId === state.activeWorker.runId);
    if (index >= 0) sessions.splice(index, 1);
    sessions.push(state.activeWorker);
  }
  const events = [
    ...sessions.flatMap(sessionFeed),
    ...progressLog
      .slice(-MAX_EVENTS)
      .map((row) => normalizeFeedEvent(row, feedIdentity(row, sessions))),
    ...observations.map((row) => normalizeFeedEvent(row, feedIdentity(row, sessions))),
  ].filter(Boolean);
  const unique = new Map(events.map((row) => [JSON.stringify(row), row]));
  return [...unique.values()]
    .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
    .slice(-MAX_EVENTS);
}

function feedIdentity(event, sessions) {
  const session = sessions.findLast((row) => {
    if (event.runId) return row.runId === event.runId;
    if (event.childThreadId || event.threadId)
      return (row.childThreadId || row.threadId) === (event.childThreadId || event.threadId);
    return (
      event.workerNumber != null &&
      event.workerNumber === row.workerNumber &&
      event.featureId === row.featureId
    );
  });
  return session || {};
}

/** A retry has its own identity. Never match a different run through its feature id. */
export function matchesFeedSession(event, session) {
  const threadId = session.childThreadId || session.threadId;
  if (event.runId) return Boolean(session.runId && event.runId === session.runId);
  if (event.threadId) return Boolean(threadId && event.threadId === threadId);
  if (event.sessionId) return event.sessionId === (session.sessionId || session.id);
  return Boolean(event.featureId && event.featureId === session.featureId && !session.runId);
}

function isUserMessage(item) {
  return item?.type === "user_message" || item?.role === "user";
}

function isInitialTaskPrompt(item, index, data) {
  if (index !== 0 || !isUserMessage(item)) return false;
  if (item.position === 0 || item.position === 1) return true;
  const list = data?.items ?? [];
  return (
    item.position == null &&
    data?.hasMoreBefore !== true &&
    !(typeof data?.thread?.itemCount === "number" && data.thread.itemCount > list.length)
  );
}

export function normalizeThreadMessages(response, threadId) {
  const data = response?.structuredContent ?? response;
  const messages = data?.items ?? data?.messages ?? data?.thread?.messages ?? data?.content ?? [];
  const list = Array.isArray(messages) ? messages : [];
  const omitInitialPrompt = Array.isArray(data?.items) && list.some((item) => !isUserMessage(item));
  return list
    .filter((item, index) => !(omitInitialPrompt && isInitialTaskPrompt(item, index, data)))
    .slice(-MAX_EVENTS)
    .map((row) => normalizeFeedEvent(row, { threadId, role: row?.role || "Agent" }))
    .filter(Boolean);
}
