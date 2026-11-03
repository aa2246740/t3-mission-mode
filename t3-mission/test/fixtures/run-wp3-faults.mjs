import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || fs.existsSync(root)) throw new Error('Pass a new owned evidence directory; existing evidence is never overwritten');
fs.mkdirSync(root, { recursive: true });
const actor = fileURLToPath(new URL('./wp3-actor.mjs', import.meta.url));
function run(operation, dir, input, output) {
  fs.mkdirSync(output, { recursive: true });
  const argv = [actor, operation, dir, JSON.stringify(input ?? {})];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 10000, maxBuffer: 16000000 });
  fs.writeFileSync(path.join(output, 'stdout.log'), r.stdout ?? '');
  fs.writeFileSync(path.join(output, 'stderr.log'), r.stderr ?? '');
  fs.writeFileSync(path.join(output, 'run.json'), JSON.stringify({ argv: [process.execPath, ...argv], status: r.status, signal: r.signal, error: r.error?.message }, null, 2) + '\n');
  return { ...r, result: r.status === 0 ? JSON.parse(r.stdout).result : null, events: r.status === 0 ? JSON.parse(r.stdout).events : [] };
}
const template = path.join(root, 'template'); fs.mkdirSync(template);
assert.equal(run('init', template, {}, path.join(template, 'init')).status, 0);
const before = run('read', template, {}, path.join(template, 'before')).result;
const payload = { commandId: 'wp3-boundary-update', addFeatures: [{ id: 'after-fault', milestoneId: 'm1' }], modelSettings: { worker: { providerInstanceId: 'codex', model: 'wp3-fault-model' } } };
function fixture(name) { const dir = path.join(root, name); fs.mkdirSync(dir); fs.cpSync(path.join(template, '.mission'), path.join(dir, '.mission'), { recursive: true }); return dir; }
function shape(snapshot) {
  return {
    revision: snapshot.state.revision,
    added: snapshot.featuresDoc.features.some(row => row.id === 'after-fault'),
    model: snapshot.modelSettings.worker.model,
    events: snapshot.progressLog.length,
    lastSeq: snapshot.progressLog.at(-1).seq,
  };
}
const golden = fixture('trace');
const traced = run('update', golden, { payload, trace: true }, path.join(golden, 'update')); assert.equal(traced.status, 0, traced.stderr);
const after = run('read', golden, {}, path.join(golden, 'after')).result;
const expected = [shape(before), shape(after)];
const matrix = [];
fs.writeFileSync(path.join(root, 'boundaries.json'), JSON.stringify(traced.events, null, 2) + '\n');
for (const fault of ['EIO', 'ENOSPC', 'SIGKILL']) for (const event of traced.events) {
  const name = `${fault}-${event.ordinal}-${event.role.replaceAll('/', '_')}-${event.operation}-${event.boundary}`;
  const dir = fixture(name);
  const failed = run('update', dir, { payload, fault: { kind: fault, ordinal: event.ordinal } }, path.join(dir, 'injected'));
  const row = { name, fault, event, failureStatus: failed.status, failureSignal: failed.signal };
  try {
    if (fault === 'SIGKILL') assert.equal(failed.signal, 'SIGKILL', failed.stderr);
    else { assert.equal(failed.status, 1, failed.stderr); assert.match(failed.stderr, new RegExp(fault)); }
    const recovered = run('read', dir, {}, path.join(dir, 'recovery-1')); assert.equal(recovered.status, 0, recovered.stderr);
    row.recovered = shape(recovered.result);
    assert.ok(expected.some(value => JSON.stringify(value) === JSON.stringify(row.recovered)), 'Recovery exposed a mixed commit: ' + JSON.stringify(row.recovered));
    const again = run('read', dir, {}, path.join(dir, 'recovery-2')); assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.result, recovered.result);
    const retried = run('update', dir, { payload }, path.join(dir, 'retry')); assert.equal(retried.status, 0, retried.stderr);
    const final = run('read', dir, {}, path.join(dir, 'final')); assert.equal(final.status, 0, final.stderr);
    assert.deepEqual(shape(final.result), shape(after));
    const files = ['state.json', 'features.json', 'model-settings.json', 'progress_log.jsonl'];
    const saved = files.map(name => ({ name, bytes: fs.readFileSync(path.join(dir, '.mission', name), 'utf8'), mtime: fs.statSync(path.join(dir, '.mission', name)).mtimeMs }));
    assert.equal(run('update', dir, { payload }, path.join(dir, 'duplicate')).status, 0);
    for (const item of saved) { assert.equal(fs.readFileSync(path.join(dir, '.mission', item.name), 'utf8'), item.bytes); assert.equal(fs.statSync(path.join(dir, '.mission', item.name)).mtimeMs, item.mtime); }
    row.pass = true;
  } catch (error) { row.pass = false; row.error = error.stack; }
  matrix.push(row);
  fs.writeFileSync(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
}
const summary = { boundaries: traced.events.length, cases: matrix.length, passed: matrix.filter(row => row.pass).length, failed: matrix.filter(row => !row.pass).length, before: shape(before), after: shape(after) };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (summary.failed) process.exitCode = 1;
