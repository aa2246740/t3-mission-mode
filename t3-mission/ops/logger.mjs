const secretKey =
  /authorization|api[-_]?key|access[-_]?key|password|token|secret|cookie|prompt|payload|body|receipt|email|username|missionDir|repoPath/i;

/** @param {string} text */
export function scrubText(text) {
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
      "[REDACTED]",
    )
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\/(?:Users|home|private\/tmp|tmp|Volumes)\/[^\s)\]"']+/g, "[LOCAL_PATH]")
    .slice(0, 2048);
}

/** @param {unknown} value @param {number} [depth] @param {WeakSet<object>} [seen] @returns {unknown} */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return scrubText(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 5) return "[DEPTH_LIMIT]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redact(item, depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([key, item]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redact(item, depth + 1, seen),
      ]),
  );
}

/** @param {{write?: (line: string) => void, now?: () => number}} [options] */
export function createLogger({
  write = (line) => {
    process.stderr.write(line);
  },
  now = Date.now,
} = {}) {
  /** @param {'info'|'warn'|'error'} level @param {string} event @param {Record<string, unknown>} [context] */
  return (level, event, context = {}) => {
    const entry = {
      timestamp: new Date(now()).toISOString(),
      level,
      event: scrubText(event),
      context: redact(context),
    };
    // A broken diagnostic destination must not change Mission command behavior.
    try {
      write(JSON.stringify(entry) + "\n");
    } catch {
      /* The caller owns the diagnostic stream. */
    }
    return entry;
  };
}
