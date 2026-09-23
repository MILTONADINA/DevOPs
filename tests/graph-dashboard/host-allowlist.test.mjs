// Tests for the Host-header allow-list in scripts/graph-dashboard/server.mjs
// (cycle-6 security finding, TP-warning: a loopback bind alone does not stop
// DNS rebinding -- a page whose hostname is re-pointed at 127.0.0.1 after the
// browser already treats it as same-origin could read /api/snapshot and
// /events. The server now answers only to the loopback names it is
// reachable by and refuses everything else with 403 before routing.)
//
// Integration-style like snapshot.test.mjs PART 3: server.mjs has no exports
// and binds a port at module load, so the REAL process is spawned against
// scratch STATE_DIR/JOURNAL_ROOT fixtures and probed over raw HTTP. The Host
// header is set explicitly per request; Node's http client would otherwise
// fill it in from the connect target, which is exactly the case the
// allow-list must accept.
//
// The repo root is derived from this file's own location, not from a `git`
// subprocess: a toolchain outage must not take the test suite with it
// (specs/graph/R-resilience.md REQ-R12 -- the 2026-09-15 Xcode update made
// every git-spawning test in this directory die together).
//
// Run with: node --test tests/graph-dashboard/host-allowlist.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

// Distinct from every sibling suite's port band so the files can run in one
// `node --test tests/graph-dashboard/` invocation without colliding.
const PORT = 46000 + (process.pid % 4000);

let fixtureRoot;
let serverProcess;
let serverStderr = '';

function request(urlPath, { host, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.Host = host;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request to ${urlPath} timed out`)));
    req.end();
  });
}

// A request with NO Host header at all (HTTP/1.0 style) -- Node's http client
// always adds one, so this goes over a raw socket.
function rawRequestWithoutHost(urlPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('connect', () => socket.write(`GET ${urlPath} HTTP/1.0\r\n\r\n`));
    socket.on('data', (c) => { data += c.toString('utf-8'); });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await request('/');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server on port ${PORT} never became ready: ${lastErr && lastErr.message}\n--- stderr ---\n${serverStderr}`);
}

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-host-allowlist-'));
  const journalRoot = path.join(fixtureRoot, 'journal-root');
  const runDir = path.join(journalRoot, 'sessH', 'subagents', 'workflows', 'wfH');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"kH","agentId":"agentH","label":"planner","phase":"Plan"}\n{"type":"result","key":"kH","agentId":"agentH","result":{"tasks":[]}}\n'
  );
  const stateDir = path.join(fixtureRoot, 'state-dir');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'events.jsonl'), '{"type":"host-evt-1"}\n');

  serverProcess = spawn(process.execPath, [SERVER_MJS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GRAPH_DASHBOARD_PORT: String(PORT),
      GRAPH_DASHBOARD_STATE_DIR: stateDir,
      GRAPH_DASHBOARD_JOURNAL_ROOT: journalRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stderr.on('data', (c) => { serverStderr += c.toString(); });
  serverProcess.stdout.on('data', () => {});
  await waitForReady();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Accepted: every loopback spelling a real browser or curl can produce.
// ---------------------------------------------------------------------------

for (const host of ['127.0.0.1', '127.0.0.1:__PORT__', 'localhost', 'localhost:__PORT__', 'LOCALHOST:__PORT__', ' 127.0.0.1:__PORT__ ']) {
  const value = host.replace('__PORT__', String(PORT));
  test(`allowed Host ${JSON.stringify(value)} -> GET / is 200 text/html`, async () => {
    const res = await request('/', { host: value });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
  });
}

test('allowed Host -> GET /api/snapshot is 200 JSON with the documented key set', async () => {
  const res = await request('/api/snapshot', { host: `127.0.0.1:${PORT}` });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(), ['approvals', 'cycleHistory', 'events', 'halt', 'phase', 'runs']);
});

// ---------------------------------------------------------------------------
// Refused: any other Host, on every route, before routing runs.
// ---------------------------------------------------------------------------

const REBINDING_HOSTS = [
  'evil.example:__PORT__',        // a rebinding attacker's own hostname
  'evil.example',
  '127.0.0.1.nip.io:__PORT__',    // wildcard-DNS services that resolve to loopback
  '10.0.0.5:__PORT__',            // a LAN address (cannot even connect, but never trusted)
  '127.0.0.1:1',                  // right host, wrong port -- not this server's identity
  '127.0.0.1:__PORT__.evil.example',
  '[::1]:__PORT__',               // IPv6 loopback: the server never binds it
  // (An EMPTY Host header cannot be sent through Node's http client -- it
  // substitutes the connect target -- so "present but empty" is not listed
  // here; the raw-socket test below covers the header being absent.)
];

for (const urlPath of ['/', '/api/snapshot', '/events']) {
  for (const host of REBINDING_HOSTS) {
    const value = host.replace('__PORT__', String(PORT));
    test(`refused Host ${JSON.stringify(value)} -> GET ${urlPath} is 403 with no body from the route`, async () => {
      const res = await request(urlPath, { host: value });
      assert.equal(res.statusCode, 403);
      assert.match(res.headers['content-type'], /^text\/plain/);
      assert.match(res.body, /Forbidden/);
      assert.doesNotMatch(res.body, /<!doctype html>|"runs"|event: snapshot/i, 'a refused request must never leak route output');
    });
  }
}

test('no Host header at all (HTTP/1.0 raw socket) -> 403, not a crash and not a 200', async () => {
  const raw = await rawRequestWithoutHost('/api/snapshot');
  assert.match(raw, /^HTTP\/1\.[01] 403 /);
  assert.doesNotMatch(raw, /"runs"/);
});

test('a refused request does not disturb the server: the next allowed request is still 200', async () => {
  await request('/events', { host: 'evil.example' });
  const res = await request('/', { host: `localhost:${PORT}` });
  assert.equal(res.statusCode, 200);
  assert.equal(serverProcess.exitCode, null, `server exited unexpectedly; stderr:\n${serverStderr}`);
});

test('the check runs before routing: an unknown path with a bad Host is 403, not 404', async () => {
  const res = await request('/does-not-exist', { host: 'evil.example' });
  assert.equal(res.statusCode, 403);
  const ok = await request('/does-not-exist', { host: `127.0.0.1:${PORT}` });
  assert.equal(ok.statusCode, 404, 'with an allowed Host the ordinary 404 path is unchanged');
});

// ---------------------------------------------------------------------------
// Static: the allow-list is exactly the loopback names and nothing wider.
// ---------------------------------------------------------------------------

test('static: ALLOWED_HOSTS in server.mjs lists exactly 127.0.0.1 and localhost, with and without the port', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('const ALLOWED_HOSTS = new Set([');
  assert.notEqual(start, -1, 'ALLOWED_HOSTS definition not found');
  const block = src.slice(start, src.indexOf(']);', start));
  const entries = [...block.matchAll(/['`]([^'`]+)['`]/g)].map((m) => m[1]);
  assert.deepEqual(entries, ['127.0.0.1', '127.0.0.1:${PORT}', 'localhost', 'localhost:${PORT}']);
  assert.ok(src.includes('if (!isAllowedHost(req.headers.host))'), 'requestHandler must consult the allow-list');
  assert.ok(src.indexOf('if (!isAllowedHost(req.headers.host))') < src.indexOf("req.method === 'GET' ? routes.get(pathname) : undefined"), 'the Host check must precede route dispatch');
});
