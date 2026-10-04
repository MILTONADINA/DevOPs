// specs/security/local-dast.md: fixed owned supervisor protocol; no real workloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/dast/proxy.mjs');
const RUN = 'mr21-dast-' + 'a'.repeat(32);
const PRIVATE = 'MR21_PRIVATE_CONTROL_SENTINEL';
const PHASES = ['initial', 'nuclei_before', 'nuclei', 'nuclei_after', 'zap_before', 'zap_after'];
const frame = (phase, overrides = {}) => Buffer.from(JSON.stringify({ schema_version: 1, run_id: RUN, phase, ...overrides }) + '\n');

async function feature() {
  assert.ok(existsSync(SOURCE), 'FEATURE_ABSENT: scripts/dast/proxy.mjs is not implemented');
  const module = await import(pathToFileURL(SOURCE).href);
  assert.equal(typeof module.createPhaseController, 'function', 'missing fixed controller export is a prerequisite failure');
  assert.equal(typeof module.serveControl, 'function', 'missing fixed Unix server export is a prerequisite failure');
  return module;
}
function recorder(module, changes = {}) {
  const calls = [];
  const actions = {
    async perform(phase) { calls.push(phase); return { observed: phase }; },
    async drain() { calls.push('drain'); return { drained: true }; },
    ...changes,
  };
  return { calls, control: module.createPhaseController(RUN, actions) };
}
function accepted(reply, phase, sequence, result) {
  assert.deepEqual(reply, { schema_version: 1, run_id: RUN, phase, sequence, ok: true, result });
}
function refused(reply, phase, sequence, reason) {
  assert.deepEqual(reply, { schema_version: 1, run_id: RUN, phase, sequence, ok: false, reason });
  const text = JSON.stringify(reply);
  assert.equal(text.includes(PRIVATE), false); assert.equal(text.includes('\u001b'), false);
}
async function advance(fixture, through) {
  for (const phase of PHASES.slice(0, through)) {
    accepted(await fixture.control.handle(frame(phase)), phase, PHASES.indexOf(phase) + 1, { observed: phase });
  }
}

test('supervisor admits the fixed sequence exactly once and drains last', async () => {
  const f = recorder(await feature()); await advance(f, 6);
  accepted(await f.control.handle(frame('drain')), 'drain', 7, { drained: true });
  refused(await f.control.handle(frame('initial')), 'initial', 7, 'phase_order');
  refused(await f.control.handle(frame('drain')), 'drain', 7, 'phase_order');
  assert.deepEqual(f.calls, [...PHASES, 'drain']);
});

test('supervisor rejects malformed complete frames before invoking actions', async () => {
  const module = await feature();
  const invalid = [Buffer.alloc(0), Buffer.from('{'), Buffer.from('null\n'), Buffer.from('[]\n'),
    Buffer.concat([frame('initial'), frame('initial')]), Buffer.from([0xff, 0x0a]),
    Buffer.alloc(1025, 32), Buffer.from(JSON.stringify({ schema_version: 1, run_id: RUN, phase: 'initial' }))];
  for (const bytes of invalid) {
    const f = recorder(module); const reply = await f.control.handle(bytes);
    assert.equal(reply.ok, false); assert.equal(reply.reason, 'protocol'); assert.equal(reply.sequence, 0);
    assert.deepEqual(f.calls, []);
    accepted(await f.control.handle(frame('initial')), 'initial', 1, { observed: 'initial' });
  }
  const padded = size => Buffer.concat([frame('initial').subarray(0, -1), Buffer.alloc(size - frame('initial').length, 32), Buffer.from('\n')]);
  const inclusive = recorder(module);
  accepted(await inclusive.control.handle(padded(1024)), 'initial', 1, { observed: 'initial' });
  const excessive = recorder(module); const reply = await excessive.control.handle(padded(1025));
  assert.equal(reply.ok, false); assert.equal(reply.reason, 'protocol'); assert.deepEqual(excessive.calls, []);
});

test('supervisor refuses unknown keys, identifiers and phases without echoing input', async () => {
  const module = await feature();
  for (const bytes of [frame('initial', { extra: PRIVATE }), frame('initial', { run_id: PRIVATE }),
    frame('initial', { schema_version: 2 }), frame(PRIVATE + '\u001b[31m')]) {
    const f = recorder(module); const reply = await f.control.handle(bytes);
    assert.equal(reply.ok, false); assert.equal(reply.reason, 'protocol'); assert.equal(reply.sequence, 0);
    assert.equal(JSON.stringify(reply).includes(PRIVATE), false); assert.deepEqual(f.calls, []);
  }
});

test('duplicate and out-of-order phases refuse without consuming the next phase', async () => {
  const f = recorder(await feature());
  refused(await f.control.handle(frame('nuclei')), 'nuclei', 0, 'phase_order');
  await advance(f, 1);
  refused(await f.control.handle(frame('initial')), 'initial', 1, 'phase_order');
  refused(await f.control.handle(frame('zap_before')), 'zap_before', 1, 'phase_order');
  accepted(await f.control.handle(frame('nuclei_before')), 'nuclei_before', 2, { observed: 'nuclei_before' });
  assert.deepEqual(f.calls, ['initial', 'nuclei_before']);
});

test('an action exception is private and sticky while drain remains available', async () => {
  const module = await feature(); const calls = [];
  const control = module.createPhaseController(RUN, {
    async perform(phase) { calls.push(phase); throw new Error(PRIVATE + '\n::error::synthetic'); },
    async drain() { calls.push('drain'); return { drained: true }; },
  });
  refused(await control.handle(frame('initial')), 'initial', 0, 'internal');
  refused(await control.handle(frame('initial')), 'initial', 0, 'internal');
  accepted(await control.handle(frame('drain')), 'drain', 1, { drained: true });
  assert.deepEqual(calls, ['initial', 'drain']);
});

test('oversized action output refuses without advancing or leaking content', async () => {
  const module = await feature(); let performed = 0;
  const control = module.createPhaseController(RUN, {
    async perform() { performed++; return { data: PRIVATE.repeat(5000) }; },
    async drain() { return {}; },
  });
  refused(await control.handle(frame('initial')), 'initial', 0, 'output_limit');
  refused(await control.handle(frame('initial')), 'initial', 0, 'output_limit');
  assert.equal(performed, 1);
});

test('drain interrupts a busy phase and a concurrent command cannot replay it', { timeout: 3000 }, async () => {
  const module = await feature(); const calls = [];
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const control = module.createPhaseController(RUN, {
    async perform(phase, { signal }) {
      calls.push(phase); entered();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(PRIVATE)), { once: true }));
    },
    async drain() { calls.push('drain'); return { drained: true }; },
  });
  const active = control.handle(frame('initial')); await started;
  refused(await control.handle(frame('initial')), 'initial', 0, 'busy');
  const draining = control.handle(frame('drain'));
  refused(await active, 'initial', 0, 'shutdown');
  accepted(await draining, 'drain', 1, { drained: true });
  assert.deepEqual(calls, ['initial', 'drain']);
});

async function withSocket(run, changes = {}) {
  const module = await feature();
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const dir = mkdtempSync(path.join(state, 'ds-')); const socket = path.join(dir, 's');
  const f = recorder(module, changes); const dispatched = []; let server;
  try {
    assert.ok(Buffer.byteLength(socket) < 104, 'owned socket path must fit the platform Unix-domain limit');
    server = await module.serveControl(socket, { handle(bytes) {
      const active = f.control.handle(bytes); dispatched.push(active); return active;
    } });
    assert.equal(statSync(socket).mode & 0o777, 0o600);
    await run({ ...f, socket, server, dispatched });
  } finally {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
function exchange(socket, bytes, options = {}) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket); const chunks = []; let size = 0;
    connection.setTimeout(options.leaveOpen ? 3500 : 2500, () => {
      options.deadman?.(); connection.destroy(new Error('Owned socket response deadline'));
    });
    connection.once('connect', () => {
      if (options.leaveOpen) connection.write(bytes);
      else if (options.afterFirst) {
        connection.write(bytes);
        options.afterFirst().then(() => connection.end(options.second), error => connection.destroy(error));
      } else connection.end(bytes);
    });
    connection.on('data', chunk => { size += chunk.length; if (size > 65536) connection.destroy(new Error('Owned reply exceeds bound')); else chunks.push(chunk); });
    connection.once('error', reject);
    connection.once('end', () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        assert.ok(text.endsWith('\n')); assert.equal(text.slice(0, -1).includes('\n'), false);
        resolve(JSON.parse(text));
      } catch (error) { reject(error); }
    });
  });
}

test('owned Unix socket preserves its response side after client write EOF', { timeout: 5000 }, async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  await withSocket(async f => {
    const reply = exchange(f.socket, frame('initial')); await started; release();
    accepted(await reply, 'initial', 1, { observed: 'initial' });
  }, { async perform() { entered(); await pending; return { observed: 'initial' }; } });
});

test('owned Unix socket rejects a valid prefix followed by a second frame', { timeout: 5000 }, async () => {
  await withSocket(async f => {
    let seen; const arrived = new Promise(resolve => { seen = resolve; });
    f.server.once('connection', peer => peer.once('data', seen));
    const reply = await exchange(f.socket, frame('initial'), { second: frame('initial'), async afterFirst() {
      await arrived; await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.calls, [], 'a complete line must not dispatch before write EOF');
    } });
    assert.equal(reply.ok, false); assert.equal(reply.reason, 'protocol'); assert.deepEqual(f.calls, []);
    accepted(await exchange(f.socket, frame('initial')), 'initial', 1, { observed: 'initial' });
    assert.deepEqual(f.calls, ['initial']);
  });
});

test('an incomplete socket frame times out before the independent deadman', { timeout: 5000 }, async () => {
  await withSocket(async f => {
    let deadman = false;
    const reply = await exchange(f.socket, Buffer.from('{'), { leaveOpen: true, deadman() { deadman = true; } });
    refused(reply, null, 0, 'deadline'); assert.equal(deadman, false); assert.deepEqual(f.calls, []);
    accepted(await exchange(f.socket, frame('initial')), 'initial', 1, { observed: 'initial' });
  });
});

test('a lost reply cannot authorize replay of an already dispatched phase', { timeout: 5000 }, async () => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  let performed = 0;
  await withSocket(async f => {
    const connection = createConnection(f.socket); connection.on('error', () => {});
    connection.once('connect', () => connection.end(frame('initial')));
    await started; connection.destroy(); finish();
    // Await the original dispatch promise, never a new request or a timing guess.
    accepted(await f.dispatched[0], 'initial', 1, { observed: 'initial' });
    refused(await exchange(f.socket, frame('initial')), 'initial', 1, 'phase_order');
    assert.equal(performed, 1);
  }, { async perform() { performed++; entered(); await pending; return { observed: 'initial' }; } });
});
