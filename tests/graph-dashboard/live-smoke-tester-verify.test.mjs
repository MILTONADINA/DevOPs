// TESTER's independent re-derivation of T11 (scripts/graph-dashboard/server.mjs
// live smoke proof). See tests/graph-dashboard/live-smoke.test.mjs for the
// CODER's own T11 proof suite -- this file does not replace it, it
// complements it: a second, independently-authored implementation of the
// same six named checks, so a bug specific to either single harness (rather
// than to server.mjs itself) has a real chance of being caught by comparing
// the two. Concretely, independent from the coder's file in three ways:
//
//   1. A DIFFERENT malformed-line shape: the coder's fixture is an
//      unterminated JSON object; this file's is a syntactically-complete
//      JSON value followed by trailing garbage ('{"...":1} trailing
//      garbage'), which fails JSON.parse via a different code path
//      ("Unexpected non-whitespace character after JSON" rather than an
//      unexpected-end-of-input). Both must land on readEventsLog's same
//      skippedLines++ branch (server.mjs, T3 section).
//   2. A DIFFERENT SSE client for checks 3/4: Node's own built-in
//      node:http request/response stream (matching the approach
//      tests/graph-dashboard/events-sse.test.mjs already uses for T6),
//      not a spawned `curl -N` child process. Checks 1/2 still use the
//      real `curl` binary, matching T11's own literal wording ("curl /",
//      "curl /api/snapshot").
//   3. Independently-written ephemeral-port probe and fixture content
//      (distinct session/workflow IDs), not copy-pasted.
//
// Never touches the real .workflow/state or real ~/.claude/projects/...
// tree -- everything lives under a fresh mkdtemp().
//
// Run with: node --test tests/graph-dashboard/live-smoke-tester-verify.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: THIS_DIR, encoding: 'utf-8' }).trim();
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');
const REQUIRED_SNAPSHOT_KEYS = ['runs', 'events', 'halt', 'approvals', 'phase'];

let fixtureRoot, journalRoot, stateDir, eventsPath;
let PORT;
let serverProcess;
let serverStderr = '';

function logStep(label, body) {
  console.log(`\n--- ${label} ---`);
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(assigned)));
    });
  });
}

function curl(args) {
  return execFileSync('curl', args, { encoding: 'utf-8' });
}

async function waitForReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      curl(['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', url]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on ${url} never became ready within ${timeoutMs}ms\n--- server stderr so far ---\n${serverStderr}`);
}

// A minimal SSE reader over Node's own native http client (not curl -- see
// this file's own header comment). Same "\n\n" frame-terminator logic as
// the coder's file (forced by server.mjs's own formatSseEvent output
// shape), but built on a different transport stack end to end.
function connectSseViaNodeHttp(urlPath) {
  let buf = '';
  const queue = [];
  const waiters = [];
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: urlPath, headers: { Accept: 'text/event-stream' } },
    (res) => {
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = null;
          let data = null;
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice('event: '.length);
            else if (line.startsWith('data: ')) data = line.slice('data: '.length);
          }
          if (data === null) continue;
          const frame = { event, json: JSON.parse(data) };
          if (waiters.length) {
            const w = waiters.shift();
            clearTimeout(w.timer);
            w.resolve(frame);
          } else {
            queue.push(frame);
          }
        }
      });
    },
  );
  req.on('error', () => {}); // swallowed on deliberate close below
  req.end();
  return {
    command: `node:http GET http://127.0.0.1:${PORT}${urlPath} (Accept: text/event-stream)`,
    nextFrame(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const w = { resolve, timer: null };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for an SSE frame on ${urlPath} after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    async waitForFrameMatching(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for a matching SSE frame on ${urlPath} after ${timeoutMs}ms`);
        const frame = await this.nextFrame(remaining);
        if (predicate(frame.json)) return frame;
      }
    },
    close() {
      req.destroy();
    },
  };
}

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-t11-tester-verify-'));

  journalRoot = path.join(fixtureRoot, 'journal-root');
  const runDir = path.join(journalRoot, 'sessTesterVerify', 'subagents', 'workflows', 'wfTesterVerify');
  await mkdir(runDir, { recursive: true });
  const journalLines = [
    { type: 'started', key: 'tv1', agentId: 'agentTesterVerifyA', label: 'planner', phase: 'Plan' },
    { type: 'result', key: 'tv1', agentId: 'agentTesterVerifyA', result: { tasks: [{ id: 'T11' }] } },
    { type: 'started', key: 'tv2', agentId: 'agentTesterVerifyB', label: 'tester:T11', phase: 'Build' },
    { type: 'result', key: 'tv2', agentId: 'agentTesterVerifyB', result: { summary: 'tester independent-verify fixture run -- not a real cycle' } },
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), journalLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  stateDir = path.join(fixtureRoot, 'state-dir');
  await mkdir(stateDir, { recursive: true });
  eventsPath = path.join(stateDir, 'events.jsonl');
  const seedLine = JSON.stringify({ ts: Math.floor(Date.now() / 1000), event: 'tester_verify_seed', note: 'well-formed baseline line' });
  // Different malformed shape than the coder's fixture: syntactically-complete
  // JSON followed by trailing garbage, not an unterminated object.
  const malformedLine = '{"ts": 0, "event": "tester_verify_malformed"} this trailing text makes JSON.parse throw a different way';
  await writeFile(eventsPath, `${seedLine}\n${malformedLine}\n`);

  PORT = await getEphemeralPort();

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

  await waitForReady(`http://127.0.0.1:${PORT}/`);
  logStep('boot (tester-independent fixtures, own ephemeral port)', {
    port: PORT,
    stateDir,
    journalRoot,
    realStateDirIsNotTouched: stateDir !== path.join(REPO_ROOT, '.workflow', 'state'),
    realJournalRootIsNotTouched: journalRoot !== path.join(os.homedir(), '.claude', 'projects', REPO_ROOT.replaceAll('/', '-')),
  });
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test('T11 tester-verify (1/6): curl / -- real HTTP 200, text/html, real HTML body', async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  const headerFile = path.join(fixtureRoot, 'curl-root-headers.txt');
  const bodyFile = path.join(fixtureRoot, 'curl-root-body.html');
  const httpCode = curl(['-s', '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}', url]);
  const headers = await readFile(headerFile, 'utf-8');
  const body = await readFile(bodyFile, 'utf-8');
  logStep('curl /', { httpCode, headers: headers.trim(), bodyBytes: Buffer.byteLength(body) });
  assert.strictEqual(httpCode, '200');
  assert.match(headers, /content-type:\s*text\/html/i);
  assert.match(body, /<!doctype html/i);
});

test('T11 tester-verify (2/6): curl /api/snapshot -- real HTTP 200, JSON with required keys', async () => {
  const url = `http://127.0.0.1:${PORT}/api/snapshot`;
  const bodyFile = path.join(fixtureRoot, 'curl-snapshot-body.json');
  const httpCode = curl(['-s', '-o', bodyFile, '-w', '%{http_code}', url]);
  const snapshot = JSON.parse(await readFile(bodyFile, 'utf-8'));
  logStep('curl /api/snapshot', {
    httpCode,
    keys: Object.keys(snapshot),
    runsCount: snapshot.runs.length,
    skippedLines: snapshot.events.skippedLines,
  });
  assert.strictEqual(httpCode, '200');
  for (const key of REQUIRED_SNAPSHOT_KEYS) assert.ok(key in snapshot, `missing key ${key}`);
  assert.strictEqual(snapshot.runs.length, 1);
  assert.strictEqual(snapshot.events.skippedLines, 1);
});

test('T11 tester-verify (3/6): connecting to /events (node:http, not curl) yields an initial snapshot SSE event within 3 seconds', async () => {
  const t0 = Date.now();
  const client = connectSseViaNodeHttp('/events');
  try {
    const frame = await client.nextFrame(6000);
    const elapsedMs = Date.now() - t0;
    logStep('node:http /events -- initial frame', { command: client.command, elapsedMs, event: frame.event, keys: Object.keys(frame.json) });
    assert.strictEqual(frame.event, 'snapshot');
    for (const key of REQUIRED_SNAPSHOT_KEYS) assert.ok(key in frame.json, `missing key ${key}`);
    assert.ok(elapsedMs < 3000, `took ${elapsedMs}ms`);
  } finally {
    client.close();
  }
});

test('T11 tester-verify (4/6): appending one well-formed line produces a new SSE snapshot event within 5 seconds', async () => {
  const client = connectSseViaNodeHttp('/events');
  try {
    const initial = await client.nextFrame(6000);
    const baseline = initial.json.events.events.length;
    assert.strictEqual(baseline, 1);
    const newLine = JSON.stringify({ ts: Math.floor(Date.now() / 1000), event: 'tester_verify_appended', note: 'appended live' });
    const t0 = Date.now();
    await appendFile(eventsPath, newLine + '\n');
    const frame = await client.waitForFrameMatching((s) => s.events.events.length === baseline + 1, 8000);
    const elapsedMs = Date.now() - t0;
    logStep('append -> new SSE snapshot', { elapsedMs, newCount: frame.json.events.events.length, skippedLines: frame.json.events.skippedLines });
    assert.strictEqual(frame.json.events.skippedLines, 1);
    assert.ok(elapsedMs < 5000, `took ${elapsedMs}ms`);
  } finally {
    client.close();
  }
});

test('T11 tester-verify (5/6): the pre-planted malformed line (trailing-garbage shape) is skipped and counted, never crashes -- process alive, /api/snapshot still correct', async () => {
  assert.strictEqual(serverProcess.exitCode, null);
  assert.strictEqual(serverProcess.signalCode, null);
  const bodyFile = path.join(fixtureRoot, 'curl-snapshot-body-2.json');
  const httpCode = curl(['-s', '-o', bodyFile, '-w', '%{http_code}', `http://127.0.0.1:${PORT}/api/snapshot`]);
  const snapshot = JSON.parse(await readFile(bodyFile, 'utf-8'));
  logStep('post-malformed-line liveness', { httpCode, skippedLines: snapshot.events.skippedLines, eventsCount: snapshot.events.events.length });
  assert.strictEqual(httpCode, '200');
  assert.strictEqual(snapshot.events.skippedLines, 1);
  assert.strictEqual(snapshot.events.events.length, 2);
});

test('T11 tester-verify (6/6): a second instance on the same port fails cleanly -- non-zero exit, no hang', async () => {
  const t0 = Date.now();
  const second = spawn(process.execPath, [SERVER_MJS], {
    cwd: REPO_ROOT,
    env: { ...process.env, GRAPH_DASHBOARD_PORT: String(PORT), GRAPH_DASHBOARD_STATE_DIR: stateDir, GRAPH_DASHBOARD_JOURNAL_ROOT: journalRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let secondStderr = '';
  second.stderr.on('data', (c) => { secondStderr += c.toString(); });
  const HANG_BOUND_MS = 5000;
  const result = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      second.kill('SIGKILL');
      resolve({ hung: true, code: null, signal: null });
    }, HANG_BOUND_MS);
    second.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hung: false, code, signal });
    });
  });
  const elapsedMs = Date.now() - t0;
  logStep('second instance, same port', { elapsedMs, ...result, stderr: secondStderr.trim() });
  assert.strictEqual(result.hung, false);
  assert.strictEqual(result.signal, null);
  assert.notStrictEqual(result.code, 0);
  assert.match(secondStderr, /EADDRINUSE/);
  assert.ok(elapsedMs < HANG_BOUND_MS);

  assert.strictEqual(serverProcess.exitCode, null, 'primary server must still be running');
  const health = curl(['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${PORT}/`]);
  assert.strictEqual(health, '200');
});
