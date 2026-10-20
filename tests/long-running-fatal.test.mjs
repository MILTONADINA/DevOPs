// specs/ops/script-entrypoints.md REQ-3: long-running scripts close and exit non-zero on an unhandled rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const DASHBOARD = join(ROOT, 'scripts/graph-dashboard/server.mjs');
const DAST = join(ROOT, 'scripts/dast/proxy.mjs');
const HOOK = { NODE_ENV: 'test', DEVOPS_TEST_UNHANDLED_REJECTION: '1' };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}
function canBind(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
function run(args, env) {
  const child = spawn(process.execPath, args, { env: { ...process.env, NODE_ENV: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', d => { out.stdout += d; });
  child.stderr.on('data', d => { out.stderr += d; });
  // Bounded: a handler that leaves the server alive fails the test instead of hanging it, and the child is always reaped.
  const closed = new Promise((resolve, reject) => {
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child did not exit within 20s')); }, 20000);
    child.on('close', (code, signal) => { clearTimeout(guard); resolve({ code, signal, ...out }); });
  });
  const until = (pattern, ms = 10000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(timer); child.kill('SIGKILL'); reject(new Error('timeout waiting for ' + pattern)); }, ms);
    const timer = setInterval(() => { if (pattern.test(out.stdout)) { clearTimeout(t); clearInterval(timer); resolve(); } }, 20);
  });
  return { child, closed, until };
}
const dashboardEnv = (dir, port) => ({
  GRAPH_DASHBOARD_PORT: String(port), GRAPH_DASHBOARD_STATE_DIR: join(dir, 'state'), GRAPH_DASHBOARD_JOURNAL_ROOT: join(dir, 'journal'),
});

test('graph dashboard: unhandled rejection logs one line, exits 1 and frees the port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fatal-dash-'));
  try {
    const port = await freePort();
    const p = run([DASHBOARD], { ...dashboardEnv(dir, port), ...HOOK });
    const result = await p.closed;
    assert.equal(result.code, 1, result.stderr);
    const lines = result.stderr.split('\n').filter(l => l.includes('fatal'));
    assert.deepEqual(lines, ['graph-dashboard: fatal unhandledRejection; closing server and exiting']);
    assert.ok(!result.stderr.includes('test-only rejection'), 'error text must not be logged');
    assert.equal(await canBind(port), true, 'port must be released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('graph dashboard: the test hook is inert without NODE_ENV=test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fatal-dash-inert-'));
  try {
    const port = await freePort();
    const p = run([DASHBOARD], { ...dashboardEnv(dir, port), NODE_ENV: 'production', DEVOPS_TEST_UNHANDLED_REJECTION: '1' });
    await p.until(/listening on/);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(p.child.exitCode, null, 'server must still be running');
    p.child.kill('SIGTERM');
    await p.closed;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dast control server: unhandled rejection closes the socket and exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fatal-dast-'));
  try {
    const socket = join(dir, 'c.sock');
    const script = join(dir, 'child.mjs');
    writeFileSync(script, `
import { serveControl, installFatalHandlers } from ${JSON.stringify(pathToFileURL(DAST).href)};
const server = await serveControl(${JSON.stringify(socket)}, { handle: async () => ({}) });
installFatalHandlers(async () => { await new Promise(r => server.close(r)); });
console.log('ready');
if (process.env.NODE_ENV === 'test' && process.env.DEVOPS_TEST_UNHANDLED_REJECTION === '1') void Promise.reject(new Error('secret-token'));
else setInterval(() => {}, 1000);
`);
    const p = run([script], HOOK);
    const result = await p.closed;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr.trim(), 'dast-control: fatal unhandledRejection');
    await new Promise(resolve => {
      const peer = createConnection(socket);
      peer.once('error', error => { assert.match(error.code, /ENOENT|ECONNREFUSED/); resolve(); });
      peer.once('connect', () => { peer.destroy(); assert.fail('socket still accepting'); });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
