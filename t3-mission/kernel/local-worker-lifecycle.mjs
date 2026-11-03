import fs from 'node:fs';
import path from 'node:path';

export function localWorkerRunEnded(current, runId, pid) {
  return (Array.isArray(current.sessions) &&
    current.sessions.some(session => session && session.runId === runId && ['completed', 'failed'].includes(session.status))) ||
    Boolean(current.activeWorker?.runId && current.activeWorker.runId !== runId) ||
    (current.activeWorker?.runId === runId && typeof current.activeWorker.workerPid === 'number' && current.activeWorker.workerPid !== pid);
}

// A daemon started by the standalone process transport has no durable Mission,
// so a missing state.json only means "Mission deleted" after one was observed.
export function inspectLocalWorkerLifetime(statePath, runId, pid, { missingSince = null, seenState = false, nowMs = Date.now() } = {}) {
  const commitPath = path.join(path.dirname(statePath), '.txn', 'commit.json');
  const committing = fs.existsSync(commitPath);
  let bytes;
  try { bytes = fs.readFileSync(statePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || !seenState) return { reason: null, missingSince: null, seenState };
    const since = missingSince ?? nowMs;
    return { reason: nowMs - since >= 250 ? 'mission-missing' : null, missingSince: since, seenState };
  }
  // Only state.json determines lifetime. Do not recover WAL or take a writer
  // lock here; an official transactional reader owns multi-file recovery.
  if (committing || fs.existsSync(commitPath)) return { reason: null, missingSince: null, seenState: true };
  try {
    const current = JSON.parse(bytes);
    return { reason: current && typeof current === 'object' && localWorkerRunEnded(current, runId, pid) ? 'run-ended' : null, missingSince: null, seenState: true };
  } catch { return { reason: null, missingSince: null, seenState: true }; }
}

function openOwnedMarker(file, state, flags) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW);
  try {
    const held = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!held.isFile() || held.nlink !== 1 || held.ino !== named.ino || held.dev !== named.dev) throw new Error('Marker inode changed');
    const owner = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!['pid', 'missionDir', 'repoPath', 'runId', 'featureId'].every(key => owner[key] === state[key])) throw new Error('Marker owner changed');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function isLocalWorkerMarkerOwned(file, state) {
  try { const fd = openOwnedMarker(file, state, fs.constants.O_RDONLY); fs.closeSync(fd); return true; }
  catch { return false; }
}

export function writeLocalWorkerMarker(file, state, { initial = false } = {}) {
  if (!file) return false;
  let fd;
  try {
    fd = initial
      ? fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      : openOwnedMarker(file, state, fs.constants.O_RDWR);
    const bytes = Buffer.from(JSON.stringify(state));
    // Updating the open inode cannot recreate a marker removed by its owner.
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.ftruncateSync(fd, bytes.length);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function removeLocalWorkerMarker(file, state) {
  if (!file) return false;
  let fd;
  try { fd = openOwnedMarker(file, state, fs.constants.O_RDONLY); fs.unlinkSync(file); return true; }
  catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
