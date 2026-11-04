/** Start one active interval without resetting time already being measured. */
export function startElapsedClock(state, now = new Date().toISOString()) {
  if (!state.lastStartedAt) state.lastStartedAt = now;
}

/** Close an interval once, including clock rollback and damaged legacy timestamps. */
export function stopElapsedClock(state, now = Date.now()) {
  const started = Date.parse(state.lastStartedAt);
  if (Number.isFinite(started)) {
    state.elapsedMs = (state.elapsedMs || 0) + Math.max(0, now - started);
  }
  state.lastStartedAt = null;
}
