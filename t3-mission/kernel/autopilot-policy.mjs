import { MissionKernelError, dispatchReceiptSources, decideDispatchOutcome, providerFailure } from "./schema.mjs";

const fail = (code, message) => { throw new MissionKernelError(code, message); };
const text = value => typeof value === "string" && value.trim().length > 0;

/** Decode the request suffix, independently of the MCP session prefix. */
export function requestIds(item) {
  const ids = new Set(text(item.clientRequestId) ? [item.clientRequestId] : []);
  for (const [key, value] of Object.entries(item)) {
    if (!/id$/i.test(key) || !text(value)) continue;
    let decoded = value;
    for (let count = 0; count < 3; count++) {
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
    }
    const marker = ":delegate-task:";
    const offset = decoded.indexOf(marker);
    if (offset >= 0 && decoded.slice(offset + marker.length)) ids.add(decoded.slice(offset + marker.length));
  }
  return [...ids];
}

export function recoveryMatches(pages, intent, ownerThreadId) {
  ownerThreadId = intent.recovery?.parentThreadId ?? ownerThreadId;
  const candidates = pages.flatMap(page => Array.isArray(page) ? page : page.tasks ?? page.threads ?? []);
  if (!candidates.every(item => item && typeof item === "object" && !Array.isArray(item))) fail("INVALID_RECOVERY_LIST", "Recovery candidates must be task/thread objects");
  const matches = candidates.filter(item => requestIds(item).includes(intent.clientRequestId) && item.parentThreadId === ownerThreadId);
  return { ownerThreadId, matches };
}

export function recoverTask(pages, intent, ownerThreadId) {
  const recovered = recoveryMatches(pages, intent, ownerThreadId);
  ownerThreadId = recovered.ownerThreadId;
  const matches = recovered.matches;
  if (!ownerThreadId || matches.length !== 1) fail("DISPATCH_RECOVERY_AMBIGUOUS", `Expected exactly one task of owner ${ownerThreadId}; found ${matches.length}. Redispatch is forbidden.`);
  const item = matches[0];
  if (requestIds(item).some(id => id !== intent.clientRequestId)) fail("DISPATCH_INTENT_CONFLICT", "Recovered request IDs conflict");
  const encodedIds = Object.entries(item).filter(([key, value]) => /id$/i.test(key) && text(value) && /^(thread|node):delegated-task:/.test(value)).map(([, value]) => value);
  const suffixes = [...new Set(encodedIds.map(value => value.slice(value.indexOf(":"))))];
  if (suffixes.length > 1) fail("DISPATCH_RECOVERY_AMBIGUOUS", "Recovered task/thread IDs conflict");
  const childThreadId = suffixes.length ? `thread${suffixes[0]}` : item.childThreadId ?? item.threadId;
  const taskId = suffixes.length ? `node${suffixes[0]}` : item.taskId;
  if ((item.taskId && item.taskId !== taskId) || (item.childThreadId && item.childThreadId !== childThreadId)) fail("DISPATCH_RECOVERY_AMBIGUOUS", "Explicit and derived identities conflict");
  return { ...item, taskId, childThreadId, clientRequestId: intent.clientRequestId };
}

export { providerFailure };

export function dispatchFailure(raw, expected = {}) {
  const decision = decideDispatchOutcome(raw, { expectedIdentity: expected });
  switch (decision.outcome) {
    case "ACCEPTED": return null;
    case "NOT_ACCEPTED": return { kind: "not_accepted", message: decision.reason,
      provider: { kind: decision.providerFailureClass, message: decision.reason } };
    case "CONFLICT": return { kind: "conflict", code: decision.errorCode, message: "Dispatch receipt conflicts with the original intent" };
    case "UNKNOWN": return { kind: "acceptance_unknown", message: "Dispatch acceptance is unknown; recover the original task" };
  }
}

export function retryDeadline(value, now, count, policy = {}) {
  const hint = dispatchReceiptSources(value).map(source => {
    const headers = source.headers ?? source.error?.headers ?? {};
    return source.retryAfter ?? source.retryAfterSeconds ?? Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  }).find(value => value !== undefined);
  if (hint !== undefined) {
    const seconds = Number(hint);
    const deadline = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(hint);
    if (Number.isFinite(deadline)) return new Date(Math.max(now, deadline)).toISOString();
  }
  return new Date(now + Math.min(policy.maxDelayMs ?? 1800000, (policy.baseDelayMs ?? 30000) * 2 ** Math.min(30, count - 1))).toISOString();
}

export function latestCompletion(status) {
  if (status.latestTerminalRunId && typeof status.latestTerminalSummary === "string") return {
    ...status, summary: status.latestTerminalSummary,
    status: status.latestTerminalStatus ?? status.status,
    terminalRunId: status.latestTerminalRunId,
  };
  return status;
}
