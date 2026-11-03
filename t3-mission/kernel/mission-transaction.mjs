import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const active = new Map();
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const require = createRequire(import.meta.url);
let backend;
let testHook;
export const transactionHash = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const hashBytes = bytes => bytes === null ? null : transactionHash(bytes);
const json = (bytes, name) => {
  try { return JSON.parse(bytes); } catch (cause) { throw Object.assign(new Error(`Invalid JSON in ${name}`, { cause }), { code: 'TX_CORRUPT' }); }
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export function resolveMissionBaseDir(missionDir) {
  if (typeof missionDir !== 'string' || !missionDir.trim()) fail('INVALID_MISSION_DIR', 'missionDir must be a non-empty string path');
  const abs = path.resolve(missionDir);
  if (path.basename(abs) === '.mission') return abs;
  const dot = path.join(abs, '.mission');
  if (fs.existsSync(dot)) return dot;
  return ['state.json', 'features.json', 'model-settings.json', 'progress_log.jsonl'].some(n => fs.existsSync(path.join(abs, n))) ? abs : dot;
}
function realBase(missionDir, exact) {
  const base = exact ? path.resolve(missionDir) : resolveMissionBaseDir(missionDir);
  try { return fs.realpathSync(base); }
  catch (error) { if (error.code === 'ENOENT') return base; throw error; }
}
function allowed(name) {
  return /^(state\.json|features\.json|model-settings\.json|progress_log\.jsonl|dispatch-[a-f0-9]+\.json|autopilot\/controller\.json|autopilot\/observations\/[a-f0-9]+\.json|\.txn\/(commands|receipts|effects)\/[a-f0-9]+\.json)$/.test(name);
}
function step(event, operation) {
  testHook?.({ ...event, boundary: 'before' });
  const result = operation();
  testHook?.({ ...event, boundary: 'after' });
  return result;
}
export function setTransactionTestHook(hook) { testHook = hook; }
export function hasActiveMissionTransaction() { return active.size > 0; }
export function afterMissionCommit(callback) {
  const tx = active.values().next().value;
  if (tx) tx.afterCommit.push(callback);
  else callback();
}
function syncDir(dir, role) {
  const fd = fs.openSync(dir, 'r');
  try { step({ operation: 'fsync-dir', role }, () => fs.fsyncSync(fd)); } finally { fs.closeSync(fd); }
}
function mkdir(dir, role) {
  if (fs.existsSync(dir)) {
    if (!fs.lstatSync(dir).isDirectory()) fail('TX_FOREIGN_PATH', `Expected an owned directory: ${dir}`);
    return;
  }
  mkdir(path.dirname(dir), role);
  step({ operation: 'mkdir', role }, () => fs.mkdirSync(dir));
  syncDir(path.dirname(dir), role + ':parent');
}
function durableAtomic(file, bytes, role) {
  mkdir(path.dirname(file), role);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = step({ operation: 'open', role }, () => fs.openSync(temporary, 'wx', 0o600));
    step({ operation: 'write', role }, () => fs.writeFileSync(fd, bytes));
    step({ operation: 'fsync-file', role }, () => fs.fsyncSync(fd));
    fs.closeSync(fd); fd = undefined;
    step({ operation: 'rename', role }, () => fs.renameSync(temporary, file));
    syncDir(path.dirname(file), role);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // A durable commit is never removed by failure cleanup. Unpublished temporary
    // files carry no authority and are retained for diagnosis.
  }
}
function readDisk(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail('TX_FOREIGN_PATH', `Mission file must be a regular, unlinked file: ${file}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function loadBackend() {
  if (backend) return backend;
  const file = fileURLToPath(new URL(`../native/mission-lock-${process.platform}-${process.arch}.node`, import.meta.url));
  try { backend = require(file); }
  catch (cause) { throw Object.assign(new Error(`TX_LOCK_BACKEND_UNAVAILABLE: build ${file} with node t3-mission/native/build.mjs <local-node-headers>`, { cause }), { code: 'TX_LOCK_BACKEND_UNAVAILABLE' }); }
  return backend;
}
function acquire(base, timeoutMs, create = true) {
  const native = loadBackend();
  const dir = path.join(base, '.txn');
  if (create) mkdir(dir, 'lock-directory');
  else {
    try { if (!fs.lstatSync(dir).isDirectory()) fail('TX_FOREIGN_PATH', `Expected an owned directory: ${dir}`); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const file = path.join(dir, 'writer.lock');
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fail('TX_FOREIGN_LOCK', 'Mission lock path is not a regular file');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDWR | (create ? fs.constants.O_CREAT : 0) | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
  const deadline = Date.now() + timeoutMs;
  try {
    while (!native.acquire(fd)) {
      if (Date.now() >= deadline) fail('TX_BUSY', `Mission transaction is busy: ${base}`);
      Atomics.wait(waitCell, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
    const held = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!held.isFile() || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino) fail('TX_FOREIGN_LOCK', 'The locked inode differs from the Mission lock path');
    return { fd, native, file, dev: held.dev, ino: held.ino };
  } catch (error) { fs.closeSync(fd); if (!create && error.code === 'ENOENT') return null; throw error; }
}
function verifyLock(tx) {
  if (!tx.lock) {
    // Official writers create this permanent lock before changing any projection.
    if (fs.existsSync(path.join(tx.base, '.txn', 'writer.lock')) || fs.existsSync(path.join(tx.base, '.txn', 'commit.json')))
      fail('TX_BUSY', 'A writer started during a legacy Mission read; retry the read');
    return;
  }
  const held = fs.fstatSync(tx.lock.fd), named = fs.lstatSync(tx.lock.file);
  if (held.nlink !== 1 || held.dev !== tx.lock.dev || held.ino !== tx.lock.ino || held.dev !== named.dev || held.ino !== named.ino) fail('TX_FOREIGN_LOCK', 'Mission lock was replaced while held');
}
function identity(base) { const stat = fs.statSync(base); return { path: base, dev: stat.dev, ino: stat.ino }; }
function validateBatch(tx, batch, marker) {
  if (batch?.version !== 1 || marker?.version !== 1) fail('TX_WAL_VERSION', 'Unknown Mission WAL version');
  if (transactionHash(JSON.stringify(batch.payload)) !== batch.sha256 || marker.sha256 !== batch.sha256 || marker.id !== batch.payload?.id) fail('TX_WAL_CORRUPT', 'Mission WAL checksum or commit identity differs');
  const p = batch.payload;
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1 || marker.sequence !== p.sequence) fail('TX_WAL_CORRUPT', 'Invalid Mission commit sequence');
  if (JSON.stringify(p.identity) !== JSON.stringify(identity(tx.base))) fail('TX_FOREIGN_MISSION', 'Mission WAL belongs to another directory');
  if (!Array.isArray(p.files) || !p.files.length || new Set(p.files.map(f => f.name)).size !== p.files.length) fail('TX_WAL_CORRUPT', 'Invalid Mission WAL file list');
  for (const file of p.files) {
    if (!allowed(file.name) || typeof file.after !== 'string' || file.sha256 !== transactionHash(file.after) || file.bytes !== Buffer.byteLength(file.after) || !(file.before === null || /^[a-f0-9]{64}$/.test(file.before))) fail('TX_WAL_CORRUPT', 'Invalid Mission WAL after-image');
  }
  const state = readDisk(path.join(tx.base, 'state.json'));
  const id = state === null ? null : json(state, 'state.json').missionId ?? null;
  if (id !== p.beforeMissionId && id !== p.afterMissionId) fail('TX_FOREIGN_MISSION', 'Mission identity differs from the committed WAL');
}
function remove(file, role) {
  step({ operation: 'unlink', role }, () => fs.unlinkSync(file));
  syncDir(path.dirname(file), role);
}
function applyBatch(tx, batch, marker) {
  validateBatch(tx, batch, marker);
  verifyLock(tx);
  // Validate every preimage before touching any public file.
  for (const file of batch.payload.files) {
    const current = hashBytes(readDisk(path.join(tx.base, file.name)));
    if (current !== file.before && current !== file.sha256) fail('EXTERNAL_MISSION_WRITE', `File changed outside the committed Mission batch: ${file.name}`);
  }
  for (const file of batch.payload.files) {
    const target = path.join(tx.base, file.name);
    if (hashBytes(readDisk(target)) !== file.sha256) durableAtomic(target, file.after, 'projection:' + file.name);
    else {
      const fd = fs.openSync(target, 'r');
      try { step({ operation: 'fsync-file', role: 'replay:' + file.name }, () => fs.fsyncSync(fd)); } finally { fs.closeSync(fd); }
      syncDir(path.dirname(target), 'replay:' + file.name);
    }
  }
  durableAtomic(path.join(tx.base, '.txn', 'applied.json'), encode(marker), 'checkpoint');
  remove(path.join(tx.base, '.txn', 'commit.json'), 'commit-cleanup');
  remove(path.join(tx.base, '.txn', 'prepare.json'), 'prepare-cleanup');
}
function recover(tx) {
  const prepareFile = path.join(tx.base, '.txn', 'prepare.json');
  const commitFile = path.join(tx.base, '.txn', 'commit.json');
  const appliedBytes = readDisk(path.join(tx.base, '.txn', 'applied.json'));
  const applied = appliedBytes === null ? null : json(appliedBytes, 'applied checkpoint');
  if (applied && (applied.version !== 1 || !Number.isSafeInteger(applied.sequence) || applied.sequence < 1 || typeof applied.id !== 'string' || !/^[a-f0-9]{64}$/.test(applied.sha256))) fail('TX_CHECKPOINT_CORRUPT', 'Mission applied checkpoint is corrupt or has an unknown version');
  tx.sequence = applied?.sequence ?? 0;
  const prepared = readDisk(prepareFile), committed = readDisk(commitFile);
  if (committed !== null) {
    if (prepared === null) fail('TX_WAL_CORRUPT', 'Committed Mission WAL has no after-images');
    const marker = json(committed, commitFile);
    if (applied && (marker.sequence < applied.sequence || (marker.sequence === applied.sequence && (marker.id !== applied.id || marker.sha256 !== applied.sha256)))) fail('TX_WAL_ORDER', 'Committed WAL is older than the applied checkpoint');
    applyBatch(tx, json(prepared, prepareFile), marker);
    tx.sequence = marker.sequence;
  } else if (prepared !== null) {
    const batch = json(prepared, prepareFile);
    if (batch?.version !== 1 || transactionHash(JSON.stringify(batch.payload)) !== batch.sha256) fail('TX_WAL_CORRUPT', 'Uncommitted Mission WAL is corrupt');
    if (JSON.stringify(batch.payload.identity) !== JSON.stringify(identity(tx.base))) fail('TX_FOREIGN_MISSION', 'Uncommitted WAL belongs to another Mission');
    remove(prepareFile, 'uncommitted-cleanup');
  }
}
function commit(tx) {
  verifyLock(tx);
  if (!tx.lock && tx.writes.size) {
    // A legacy read may compose a mutation. Upgrade before any disk write;
    // commit's preimage checks still reject a writer that changed its inputs.
    if (!fs.existsSync(path.join(tx.base, 'state.json'))) fail('MISSION_NOT_FOUND', 'Mission was deleted before the mutation');
    tx.lock = acquire(tx.base, tx.lockTimeoutMs);
    recover(tx);
  }
  const files = [...tx.writes].map(([name, after]) => ({ name, after, before: hashBytes(tx.reads.get(name)), sha256: transactionHash(after), bytes: Buffer.byteLength(after) })).filter(f => f.before !== f.sha256);
  if (!files.length) return;
  for (const [name, before] of tx.reads) if (hashBytes(readDisk(path.join(tx.base, name))) !== hashBytes(before)) fail('EXTERNAL_MISSION_WRITE', `Mission file changed outside the transaction: ${name}`);
  const oldState = tx.reads.get('state.json') ?? readDisk(path.join(tx.base, 'state.json'));
  const nextState = tx.writes.get('state.json') ?? oldState;
  const payload = { id: crypto.randomUUID(), sequence: (tx.sequence ?? 0) + 1, identity: identity(tx.base), beforeMissionId: oldState === null ? null : json(oldState, 'state.json').missionId ?? null, afterMissionId: nextState === null ? null : json(nextState, 'state.json').missionId ?? null, files };
  const batch = { version: 1, payload, sha256: transactionHash(JSON.stringify(payload)) };
  const marker = { version: 1, id: payload.id, sequence: payload.sequence, sha256: batch.sha256 };
  durableAtomic(path.join(tx.base, '.txn', 'prepare.json'), encode(batch), 'wal-prepare');
  durableAtomic(path.join(tx.base, '.txn', 'commit.json'), encode(marker), 'wal-commit');
  applyBatch(tx, batch, marker);
}
export function withMissionTransaction(missionDir, reducer, { join = false, create = true, exactBase = false, lockTimeoutMs = 2000 } = {}) {
  let base = realBase(missionDir, exactBase);
  if (active.has(base)) {
    if (!join) fail('TX_REENTRANT', 'Pass internal composition through the existing Mission transaction');
    const value = reducer(active.get(base));
    if (value?.then) fail('TX_ASYNC_REDUCER', 'Mission transactions cannot await external work');
    return value;
  }
  if (active.size) fail('TX_CROSS_MISSION', 'A local reducer cannot hold transactions for different Missions');
  const exists = () => fs.existsSync(path.join(base, 'state.json')) || fs.existsSync(path.join(base, '.txn', 'commit.json'));
  if (!create && !exists()) return reducer(null);
  if (!fs.existsSync(base)) {
    if (!create) return reducer(null);
    loadBackend();
    mkdir(base, 'mission-directory'); base = fs.realpathSync(base);
  }
  // A committed batch retains A1 recovery semantics even if its lock was lost.
  const lock = acquire(base, lockTimeoutMs, create || fs.existsSync(path.join(base, '.txn', 'commit.json')));
  if (!create && !exists()) {
    if (lock) try { lock.native.release(lock.fd); } finally { fs.closeSync(lock.fd); }
    return reducer(null);
  }
  const tx = { base, lock, lockTimeoutMs, reads: new Map(), writes: new Map(), afterCommit: [] };
  active.set(base, tx);
  let value;
  try {
    if (tx.lock) recover(tx);
    else if (fs.existsSync(path.join(base, '.txn', 'commit.json')) || fs.existsSync(path.join(base, '.txn', 'prepare.json')))
      fail('TX_FOREIGN_LOCK', 'Mission WAL has no writer lock; retain it for recovery');
    value = reducer(tx);
    if (value?.then) fail('TX_ASYNC_REDUCER', 'Mission transactions cannot await external work');
    commit(tx);
  } finally {
    active.delete(base);
    if (tx.lock) try { tx.lock.native.release(tx.lock.fd); } finally { fs.closeSync(tx.lock.fd); }
  }
  for (const callback of tx.afterCommit) callback();
  return value;
}
export const missionTransaction = (dir, fn, options = {}) => withMissionTransaction(dir, fn, { ...options, join: true });
function fileLocation(file) {
  const abs = path.resolve(file);
  const match = abs.match(/^(.*)\/(state\.json|features\.json|model-settings\.json|progress_log\.jsonl|dispatch-[a-f0-9]+\.json|autopilot\/.*|\.txn\/(?:commands|receipts|effects)\/.*)$/);
  if (!match || !allowed(match[2])) fail('TX_PATH_NOT_ALLOWED', `Not a Mission transaction file: ${file}`);
  return { base: realBase(match[1], true), name: match[2] };
}
export function readTransactionFile(file) {
  const { base, name } = fileLocation(file);
  return missionTransaction(base, tx => {
    if (!tx) return null;
    if (tx.writes.has(name)) return tx.writes.get(name);
    if (!tx.reads.has(name)) tx.reads.set(name, readDisk(path.join(base, name)));
    return tx.reads.get(name);
  }, { exactBase: true, create: false });
}
export function writeTransactionFile(file, bytes) {
  const { base, name } = fileLocation(file);
  return missionTransaction(base, tx => {
    if (!tx.reads.has(name)) tx.reads.set(name, readDisk(path.join(base, name)));
    tx.writes.set(name, String(bytes));
  }, { exactBase: true });
}
export function listTransactionFiles(directory) {
  const dir = path.resolve(directory);
  const names = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  for (const tx of active.values()) for (const name of tx.writes.keys()) {
    const file = path.join(tx.base, name);
    if (path.dirname(file) === dir) names.add(path.basename(file));
  }
  return [...names].sort();
}
export function commandTransaction(missionDir, name, payload, reducer, { commandId = payload?.commandId, replayAction } = {}) {
  return missionTransaction(missionDir, () => {
    if (commandId === undefined) return reducer();
    if (typeof commandId !== 'string' || !commandId.trim()) fail('TX_COMMAND_ID_REQUIRED', 'commandId must be a non-empty string');
    const base = realBase(missionDir, false);
    const file = path.join(base, '.txn', 'commands', transactionHash(commandId) + '.json');
    const commandHash = transactionHash(JSON.stringify(canonical({ name, payload })));
    const raw = readTransactionFile(file);
    if (raw !== null) {
      const saved = json(raw, file);
      if (saved.version !== 1 || saved.commandHash !== commandHash) fail('TX_COMMAND_ID_CONFLICT', 'commandId was already committed with a different payload');
      if (saved.resultHash !== transactionHash(JSON.stringify(saved.result))) fail('TX_COMMAND_RESULT_CORRUPT', 'Committed command result checksum differs');
      return replayAction ? replayAction(saved.result) : structuredClone(saved.result);
    }
    const result = reducer();
    writeTransactionFile(file, encode({ version: 1, commandId, commandHash, resultHash: transactionHash(JSON.stringify(result)), result }));
    return result;
  }, { create: name === 'proposeMission' });
}
export async function runMissionSteps(missionDir, iterator, { create = false } = {}) {
  let method = 'next', value;
  while (true) {
    const next = missionTransaction(missionDir, () => iterator[method](value), { create });
    if (next.done) return next.value;
    try { value = await next.value(); method = 'next'; }
    catch (error) { value = error; method = 'throw'; }
  }
}

export async function runClaimedEffect(missionDir, effectId, invoke, { validate } = {}) {
  const file = path.join(realBase(missionDir, false), '.txn', 'effects', transactionHash(effectId) + '.json');
  const prior = missionTransaction(missionDir, () => {
    const raw = readTransactionFile(file);
    if (raw !== null) return json(raw, file);
    if (validate?.()?.then) fail('TX_ASYNC_REDUCER', 'Effect claim validation cannot await external work');
    writeTransactionFile(file, encode({ version: 1, effectId, phase: 'requested' }));
    return null;
  });
  if (prior) {
    if (prior.version !== 1 || prior.effectId !== effectId) fail('TX_EFFECT_CONFLICT', 'External effect identity differs');
    if (prior.phase === 'returned') {
      if (prior.responseHash !== transactionHash(JSON.stringify({ responseDefined: prior.responseDefined, response: prior.response }))) fail('TX_EFFECT_CORRUPT', 'External return checksum differs');
      return prior.responseDefined ? prior.response : undefined;
    }
    fail('TX_EFFECT_OUTCOME_UNKNOWN', 'Reconcile the original external operation before attempting it again');
  }
  let response;
  try { response = await invoke(); }
  catch (error) {
    missionTransaction(missionDir, () => writeTransactionFile(file, encode({ version: 1, effectId, phase: 'unknown', error: { message: error.message, code: error.code } })));
    throw error;
  }
  missionTransaction(missionDir, () => writeTransactionFile(file, encode({ version: 1, effectId, phase: 'returned', responseHash: transactionHash(JSON.stringify({ responseDefined: response !== undefined, response })), responseDefined: response !== undefined, response })));
  return response;
}
