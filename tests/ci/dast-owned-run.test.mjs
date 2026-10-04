// specs/security/local-dast.md REQ1/9, AC11: scoped cleanup and bounded owned children.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/dast/owned-run.mjs');
const RUN = 'mr21-dast-' + 'd'.repeat(32);
const PRIVATE = 'MR21_PRIVATE_CHILD_SENTINEL';
const RESOURCES = [{ id: 'a'.repeat(64), run_id: RUN, role: 'anchor' }, { id: 'b'.repeat(64), run_id: RUN, role: 'zap' }];
async function feature() {
  assert.ok(existsSync(SOURCE), 'FEATURE_ABSENT: scripts/dast/owned-run.mjs is not implemented');
  const module = await import(pathToFileURL(SOURCE).href);
  for (const name of ['runCommand', 'cleanupOwned', 'finalizeSummary']) assert.equal(typeof module[name], 'function', name + ' export prerequisite');
  return module;
}
function cleanupFixture(changes = {}) {
  const events = [];
  return { events, operations: {
    async inspect(id) {
      events.push(['inspect', id]); const resource = RESOURCES.find(item => item.id === id); assert.ok(resource);
      return { Id: id, Config: { Labels: { 'devops.dast.run': resource.run_id, 'devops.dast.role': resource.role } } };
    },
    async drain(resource) { events.push(['drain', resource.id]); return { exit_code: 0, signal: null }; },
    async remove(id) { events.push(['remove', id]); return { exit_code: 0, signal: null }; },
    ...changes,
  } };
}
const gate = (reason = 'ok') => ({ schema_version: 1, run_id: RUN, kind: 'application',
  verdict: reason === 'ok' ? 'PASS' : 'INDETERMINATE', reason, scan_complete: reason !== 'health',
  nuclei: { complete: true, counts: { info: 0, low: 0, medium: 0, high: reason === 'high_finding' ? 1 : 0, critical: 0 }, engine_units: 23, engine_total: 23, observed_http_requests: null },
  zap: { complete: true, alerts: { 0: 0, 1: 0, 2: 0, 3: 0 }, instances: { 0: 0, 1: 0, 2: 0, 3: 0 }, url_count: 5 } });

test('cleanup handles exactly recorded owned IDs, including a partial creation ledger', async () => {
  const { cleanupOwned } = await feature();
  for (const resources of [RESOURCES, RESOURCES.slice(0, 1), []]) {
    const before = JSON.stringify(resources); const f = cleanupFixture();
    const result = await cleanupOwned(resources, f.operations); assert.equal(result.complete, true);
    assert.deepEqual(result.resources.map(item => item.id).sort(), resources.map(item => item.id).sort());
    for (const item of result.resources) assert.deepEqual(item, { id: item.id, removed: true, exit_code: 0, signal: null });
    for (const resource of resources) {
      for (const action of ['inspect', 'drain', 'remove']) assert.equal(f.events.filter(e => e[0] === action && e[1] === resource.id).length, 1);
      assert.ok(f.events.findIndex(e => e[0] === 'inspect' && e[1] === resource.id) < f.events.findIndex(e => e[0] === 'remove' && e[1] === resource.id));
    }
    assert.equal(JSON.stringify(resources), before);
  }
});

test('drain or removal failure cannot skip other owned resources or erase cleanup failure', async () => {
  const { cleanupOwned } = await feature();
  for (const [failure, mode] of [['drain', 'throw'], ['drain', 'status'], ['remove', 'throw'], ['remove', 'status']]) {
    const f = cleanupFixture(); const original = f.operations[failure];
    f.operations[failure] = async value => {
      const id = typeof value === 'string' ? value : value.id;
      if (id === RESOURCES[0].id) {
        f.events.push([failure, id]);
        if (mode === 'status') return { exit_code: 7, signal: null };
        throw new Error(PRIVATE);
      }
      return original(value);
    };
    const result = await cleanupOwned(RESOURCES, f.operations); assert.equal(result.complete, false);
    assert.deepEqual(f.events.filter(e => e[0] === 'remove').map(e => e[1]).sort(), RESOURCES.map(r => r.id).sort());
    assert.equal(result.resources.find(r => r.id === RESOURCES[1].id).removed, true);
    if (failure === 'drain') assert.equal(result.resources.find(r => r.id === RESOURCES[0].id).removed, true);
    else assert.equal(result.resources.find(r => r.id === RESOURCES[0].id).removed, false);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  }
});

test('foreign run, role or inspected ID is never drained or removed', async () => {
  const { cleanupOwned } = await feature();
  for (const fault of ['run', 'role', 'id']) {
    const f = cleanupFixture(); const inspect = f.operations.inspect;
    f.operations.inspect = async id => {
      const item = await inspect(id);
      if (id === RESOURCES[0].id) {
        if (fault === 'id') item.Id = 'c'.repeat(64);
        else item.Config.Labels['devops.dast.' + fault] = 'owned-foreign-fixture';
      }
      return item;
    };
    const result = await cleanupOwned(RESOURCES, f.operations); assert.equal(result.complete, false);
    assert.deepEqual(f.events.filter(e => ['drain', 'remove'].includes(e[0])).map(e => e[1]), [RESOURCES[1].id, RESOURCES[1].id]);
    assert.equal(result.resources.find(r => r.id === RESOURCES[0].id).removed, false);
    assert.equal(result.resources.find(r => r.id === RESOURCES[1].id).removed, true);
  }
});

test('successful cleanup preserves the original verdict, reason and measured counts', async () => {
  const { finalizeSummary } = await feature(); const cleanup = { complete: true, resources: [] };
  for (const reason of ['ok', 'terminal', 'health', 'high_finding']) {
    const original = gate(reason); const before = JSON.stringify(original);
    assert.deepEqual(finalizeSummary(original, cleanup), { ...original, cleanup });
    assert.equal(JSON.stringify(original), before);
  }
});

test('cleanup failure overrides PASS while retaining the original scan reason and counts', async () => {
  const { finalizeSummary } = await feature(); const cleanup = { complete: false, resources: [{ id: RESOURCES[0].id, removed: false, exit_code: 1, signal: null }] };
  for (const reason of ['ok', 'high_finding']) {
    const original = gate(reason); const before = JSON.stringify(original);
    assert.deepEqual(finalizeSummary(original, cleanup), { ...original, cleanup, verdict: 'INDETERMINATE', reason: 'cleanup', scan_reason: reason });
    assert.equal(JSON.stringify(original), before);
  }
});

async function childFixture(run) {
  const module = await feature(); const parent = path.join(ROOT, '.workflow/state'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'dast-child-')); const script = path.join(root, 'child.mjs');
  writeFileSync(script, `import { writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode,...args] = process.argv.slice(2);
if(mode==='echo') writeSync(1,JSON.stringify({args,env:process.env}));
else if(mode==='nonzero') process.exitCode=7;
else if(mode==='overflow') writeSync(1,Buffer.alloc(16384,88));
else if(mode==='parent') { const child=spawn(process.execPath,[process.argv[1],'hold'],{stdio:'inherit'}); child.once('spawn',()=>process.exit(0)); }
else if(mode==='hold') { process.on('SIGTERM',()=>{}); writeSync(1,'DESCENDANT_READY\\n'); setTimeout(()=>{writeSync(1,'INDEPENDENT_DEADMAN\\n');process.exit(99)},5000); }
else process.exitCode=98;
`);
  const options = { cwd: root, env: { PATH: '', HOME: root, LANG: 'C' }, timeoutMs: 2000, maxBytes: 1024 };
  try { await run({ ...module, root, script, options }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function terminal(result) {
  assert.ok(Buffer.isBuffer(result.stdout)); assert.ok(Buffer.isBuffer(result.stderr));
  assert.ok(Number.isFinite(Date.parse(result.started_at))); assert.ok(Number.isFinite(Date.parse(result.finished_at)));
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at));
  assert.equal(typeof result.timed_out, 'boolean'); assert.equal(typeof result.output_overflow, 'boolean');
}

test('bounded child keeps literal argv and exactly the supplied environment', async () => childFixture(async f => {
  const args = ['space separated', '$(printf inert)', ';inert', PRIVATE];
  const result = await f.runCommand(process.execPath, [f.script, 'echo', ...args], f.options); terminal(result);
  assert.equal(result.exit_code, 0); assert.equal(result.signal, null); assert.equal(result.timed_out, false); assert.equal(result.output_overflow, false);
  assert.deepEqual(JSON.parse(result.stdout), { args, env: f.options.env }); assert.equal(result.stderr.length, 0);
}));

test('bounded child preserves a genuine nonzero terminal status', async () => childFixture(async f => {
  const result = await f.runCommand(process.execPath, [f.script, 'nonzero'], f.options); terminal(result);
  assert.equal(result.exit_code, 7); assert.equal(result.signal, null); assert.equal(result.timed_out, false); assert.equal(result.output_overflow, false);
}));

test('deadline ends a descendant-held pipe after its direct parent has exited', { timeout: 8000 }, async () => childFixture(async f => {
  const result = await f.runCommand(process.execPath, [f.script, 'parent'], { ...f.options, timeoutMs: 1500 }); terminal(result);
  assert.equal(result.timed_out, true); assert.equal(result.output_overflow, false);
  assert.match(result.stdout.toString('utf8'), /DESCENDANT_READY/);
  assert.doesNotMatch(result.stdout.toString('utf8'), /INDEPENDENT_DEADMAN/);
}));

test('output beyond the per-stream cap is retained bounded and never accepted', async () => childFixture(async f => {
  const result = await f.runCommand(process.execPath, [f.script, 'overflow'], f.options); terminal(result);
  assert.equal(result.output_overflow, true); assert.equal(result.timed_out, false);
  assert.ok(result.stdout.length <= f.options.maxBytes); assert.ok(result.stderr.length <= f.options.maxBytes);
  assert.ok(result.stdout.length > 0); assert.ok(result.stdout.every(value => value === 88));
}));

test('spawn failure returns fixed fields without native path or error diagnostics', async () => childFixture(async f => {
  const result = await f.runCommand(path.join(f.root, PRIVATE), [], f.options); terminal(result);
  assert.equal(result.exit_code, null); assert.equal(result.signal, null); assert.equal(result.timed_out, false); assert.equal(result.output_overflow, false);
  assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  if (result.error !== undefined) assert.equal(result.error, 'spawn');
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
}));
