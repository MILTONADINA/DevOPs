// Tests for T11 (live smoke proof for scripts/graph-dashboard/server.mjs).
//
// T11's own task text is explicit that a green summary alone is not
// sufficient: it names six concrete, real-world behaviors to actually
// execute and capture (not merely assert past via an extracted/mocked
// slice), using the real `curl` binary for the two plain-HTTP checks it
// names by tool. This file is that proof, persisted so it can be re-run by
// anyone: `node --test tests/graph-dashboard/live-smoke.test.mjs`. Its own
// captured stdout (every `logStep()` block below: the exact command run
// plus the exact real output/exit code/elapsed-ms it produced) is the
// `test_output_path` artifact this task's claim (verification/claim-schema.yml)
// points at -- not just this file's pass/fail lines.
//
// Distinct from tests/graph-dashboard/events-sse.test.mjs (which drives SSE
// via Node's own http client against a long-lived shared fixture across many
// change-detection scenarios): this file drives every check -- including
// SSE -- through a real spawned `curl` child process, matching T11's own
// wording ("curl /", "curl /api/snapshot", "connecting to /events") as
// literally as an automated, persisted, re-runnable test can, and is scoped
// exactly to T11's own six named checks, in T11's own order:
//   1. curl / -> HTTP 200 HTML
//   2. curl /api/snapshot -> HTTP 200 JSON with keys runs/events/halt/approvals/phase
//   3. connecting to /events yields an initial snapshot SSE event within 3s
//   4. appending one well-formed events.jsonl line -> a new SSE snapshot event within 5s
//   5. the pre-planted malformed line is skipped+counted, never crashes -- process still alive/responsive
//   6. a second instance on the same port fails cleanly: non-zero exit, no hang
//
// Fixtures: both GRAPH_DASHBOARD_STATE_DIR and GRAPH_DASHBOARD_JOURNAL_ROOT
// are freshly mkdtemp()'d directories under the OS tmp dir (os.tmpdir()) --
// never this checkout's real .workflow/state and never the real
// ~/.claude/projects/<slug> journal tree, per T11's own hard requirement.
// GRAPH_DASHBOARD_PORT is a genuine OS-assigned ephemeral port (bind to 0,
// read back the assigned port, close, reuse the number), not a guessed
// static range -- matching T11's own "ephemeral" wording exactly.
//
// Run with: node --test tests/graph-dashboard/live-smoke.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: THIS_DIR, encoding: 'utf-8' }).trim();
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

// T11's own required key list, verbatim.
const REQUIRED_SNAPSHOT_KEYS = ['runs', 'events', 'halt', 'approvals', 'phase'];

let fixtureRoot, journalRoot, stateDir, eventsPath;
let PORT;
let serverProcess;
let serverStdout = '';
let serverStderr = '';

// Every value logged here is freshly captured from a real command that just
// ran -- never a canned/assumed string -- so the persisted `node --test`
// log this file produces shows actual command output, not just green
// checkmarks. See this file's own header comment.
function logStep(label, body) {
  console.log(`\n--- ${label} ---`);
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

// A genuine OS-assigned ephemeral port: bind to port 0, read back whatever
// the kernel handed out, close immediately, hand the number to the real
// server process a moment later. Small inherent TOCTOU window between close()
// and server.mjs's own bind() -- standard, accepted practice for ephemeral-
// port allocation in tests; not worth the complexity of holding the probe
// socket open across a child-process spawn.
function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Real curl binary, real subprocess, real captured stdout -- per T11's own
// explicit wording. Never passes -f, so curl's own exit code (execFileSync
// throws on non-zero) reflects a genuine connection-level failure only; an
// HTTP-level 4xx/5xx still exits 0 with the status visible via -w, exactly
// like a human running this by hand would see.
function curl(args) {
  return execFileSync('curl', args, { encoding: 'utf-8' });
}

async function waitForReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      curl(['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', url]);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on ${url} never became ready within ${timeoutMs}ms: ${lastErr && lastErr.message}\n--- server stderr so far ---\n${serverStderr}`);
}

// Minimal SSE frame reader over a REAL `curl -N` child process (not Node's
// http client -- see this file's own header comment on why). formatSseEvent()
// in server.mjs guarantees each frame is exactly
// "event: snapshot\ndata: <one-line-json>\n\n" (JSON escapes every literal
// newline inside a string value as \n), so splitting curl's accumulated
// stdout on the "\n\n" frame terminator is sufficient -- no real SSE-spec
// parser needed for this server's own fixed output shape.
function connectSseViaCurl(urlPath) {
  const url = `http://127.0.0.1:${PORT}${urlPath}`;
  const proc = spawn('curl', ['-N', '-s', '-H', 'Accept: text/event-stream', url]);
  let buf = '';
  let stderr = '';
  const queue = [];
  const waiters = [];
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
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
      if (data === null) continue; // stray bytes -- not a real frame
      const frame = { event, raw, json: JSON.parse(data) };
      if (waiters.length) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.resolve(frame);
      } else {
        queue.push(frame);
      }
    }
  });
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  return {
    command: `curl -N -s -H 'Accept: text/event-stream' ${url}`,
    nextFrame(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const w = { resolve, timer: null };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for an SSE frame on ${urlPath} after ${timeoutMs}ms (curl stderr so far: ${stderr})`));
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
      proc.kill('SIGTERM');
    },
  };
}

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-t11-live-smoke-'));

  // --- Journal root: one fake run directory shaped like a real one -------
  journalRoot = path.join(fixtureRoot, 'journal-root');
  const runDir = path.join(journalRoot, 'sessT11Smoke', 'subagents', 'workflows', 'wfT11Smoke');
  await mkdir(runDir, { recursive: true });
  // Exact per-type field set server.mjs's own T2 header comment documents:
  // started: {type,key,agentId,label,phase}; result: {type,key,agentId,result}
  // -- label/phase deliberately NOT repeated on result, matching real data.
  const journalLines = [
    { type: 'started', key: 'k1', agentId: 'agentT11a', label: 'planner', phase: 'Plan' },
    { type: 'result', key: 'k1', agentId: 'agentT11a', result: { tasks: [{ id: 'T11' }] } },
    { type: 'started', key: 'k2', agentId: 'agentT11b', label: 'coder:T11', phase: 'Build' },
    { type: 'result', key: 'k2', agentId: 'agentT11b', result: { summary: 'T11 live-smoke fixture run -- not a real cycle' } },
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), journalLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // --- State dir: events.jsonl seeded with 1 well-formed line + 1 --------
  // deliberately malformed line appended, per T11's own requirement.
  stateDir = path.join(fixtureRoot, 'state-dir');
  await mkdir(stateDir, { recursive: true });
  eventsPath = path.join(stateDir, 'events.jsonl');
  const seedLine = JSON.stringify({ ts: Math.floor(Date.now() / 1000), event: 't11_smoke_seed', note: 'well-formed baseline line' });
  // One physical line (no embedded newline), an unterminated JSON object --
  // guaranteed to throw in JSON.parse() and therefore be counted by
  // readEventsLog()'s skippedLines (server.mjs's T3 section), never crash it.
  const malformedLine = '{"ts": 0, "event": "t11_smoke_malformed", "note": "intentionally truncated JSON -- no closing brace';
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
  serverProcess.stdout.on('data', (c) => { serverStdout += c.toString(); });
  serverProcess.stderr.on('data', (c) => { serverStderr += c.toString(); });

  await waitForReady(`http://127.0.0.1:${PORT}/`);
  logStep('boot: real server, scratch fixtures, ephemeral port', {
    port: PORT,
    stateDir,
    journalRoot,
    eventsPathSeeded: eventsPath,
    fakeRunDir: runDir,
    serverStdoutSoFar: serverStdout.trim(),
    realStateDirIsNotTouched: stateDir !== path.join(REPO_ROOT, '.workflow', 'state'),
    realJournalRootIsNotTouched: journalRoot !== path.join(os.homedir(), '.claude', 'projects', REPO_ROOT.replaceAll('/', '-')),
  });
});

after(async () => {
  logStep('cleanup', { killingPid: serverProcess && serverProcess.pid, removingFixtureRoot: fixtureRoot });
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// 1/6 -- curl / -> HTTP 200 HTML
// =============================================================================

test('T11 (1/6): curl / -- real HTTP 200, text/html, real HTML body', async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  const bodyFile = path.join(fixtureRoot, 'curl-root-body.html');
  const headerFile = path.join(fixtureRoot, 'curl-root-headers.txt');
  const args = ['-s', '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}', url];
  const httpCode = curl(args);
  const headers = await readFile(headerFile, 'utf-8');
  const body = await readFile(bodyFile, 'utf-8');
  logStep('curl / (real command + real output)', {
    command: `curl ${args.join(' ')}`,
    httpCode,
    responseHeaders: headers.trim(),
    bodyByteLength: Buffer.byteLength(body),
    bodyFirst120Chars: body.slice(0, 120),
  });

  assert.strictEqual(httpCode, '200', `expected HTTP 200 from GET /, curl reported ${httpCode}`);
  assert.match(headers, /content-type:\s*text\/html/i, 'Content-Type header must say text/html');
  assert.match(body, /<!doctype html/i, 'body must actually be HTML, not just a 200 with the wrong content');
});

// =============================================================================
// 2/6 -- curl /api/snapshot -> HTTP 200 JSON with keys runs/events/halt/approvals/phase
// =============================================================================

test('T11 (2/6): curl /api/snapshot -- real HTTP 200, JSON containing keys runs/events/halt/approvals/phase', async () => {
  const url = `http://127.0.0.1:${PORT}/api/snapshot`;
  const bodyFile = path.join(fixtureRoot, 'curl-snapshot-body.json');
  const args = ['-s', '-o', bodyFile, '-w', '%{http_code}', url];
  const httpCode = curl(args);
  const body = await readFile(bodyFile, 'utf-8');
  const snapshot = JSON.parse(body); // throws (failing this test) if curl didn't actually get real JSON back
  logStep('curl /api/snapshot (real command + real output)', {
    command: `curl ${args.join(' ')}`,
    httpCode,
    keys: Object.keys(snapshot),
    runsCount: snapshot.runs.length,
    eventsCount: snapshot.events.events.length,
    skippedLines: snapshot.events.skippedLines,
    halt: snapshot.halt,
    approvals: snapshot.approvals,
    phase: snapshot.phase,
  });

  assert.strictEqual(httpCode, '200', `expected HTTP 200 from GET /api/snapshot, curl reported ${httpCode}`);
  for (const key of REQUIRED_SNAPSHOT_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(snapshot, key), `snapshot is missing required key "${key}"`);
  }
  assert.strictEqual(snapshot.runs.length, 1, 'expected exactly the 1 fake fixture run directory');
  assert.strictEqual(snapshot.events.skippedLines, 1, 'expected exactly the 1 pre-planted malformed line to be skipped and counted');
});

// =============================================================================
// 3/6 -- connecting to /events yields an initial snapshot SSE event within 3s
// =============================================================================

test('T11 (3/6): connecting to /events (real curl -N) yields an initial snapshot SSE event within 3 seconds', async () => {
  const t0 = Date.now();
  const client = connectSseViaCurl('/events');
  try {
    // Hard ceiling above the 3s spec threshold so a late-but-real response
    // fails with a clean, measured assertion message instead of an opaque
    // "timed out" exception.
    const frame = await client.nextFrame(6000);
    const elapsedMs = Date.now() - t0;
    logStep('curl -N /events -- initial frame (real command + real output)', {
      command: client.command,
      elapsedMs,
      sseEventName: frame.event,
      keys: Object.keys(frame.json),
      rawFrame: frame.raw,
    });

    assert.strictEqual(frame.event, 'snapshot');
    for (const key of REQUIRED_SNAPSHOT_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(frame.json, key), `initial SSE snapshot is missing required key "${key}"`);
    }
    assert.ok(elapsedMs < 3000, `expected the initial SSE snapshot within 3000ms, took ${elapsedMs}ms`);
  } finally {
    client.close();
  }
});

// =============================================================================
// 4/6 -- appending one well-formed line -> a new SSE snapshot event within 5s
// =============================================================================

test('T11 (4/6): appending one well-formed line to the scratch events.jsonl produces a new SSE snapshot event within 5 seconds', async () => {
  const client = connectSseViaCurl('/events');
  try {
    const initial = await client.nextFrame(6000);
    const baselineCount = initial.json.events.events.length;
    assert.strictEqual(baselineCount, 1, 'precondition: exactly the 1 well-formed seed line before appending');

    const newLine = JSON.stringify({ ts: Math.floor(Date.now() / 1000), event: 't11_smoke_appended', note: 'appended live by the T11 smoke test' });
    const t0 = Date.now();
    await appendFile(eventsPath, newLine + '\n');

    const frame = await client.waitForFrameMatching((snap) => snap.events.events.length === baselineCount + 1, 8000);
    const elapsedMs = Date.now() - t0;
    logStep('append well-formed line -> new SSE snapshot (real output)', {
      appendedLine: newLine,
      elapsedMs,
      newEventsCount: frame.json.events.events.length,
      skippedLinesStillJust1: frame.json.events.skippedLines,
    });

    assert.strictEqual(frame.json.events.events.length, baselineCount + 1);
    assert.strictEqual(frame.json.events.skippedLines, 1, 'the pre-planted malformed line must still be the only skipped line -- never re-counted, never fabricated');
    assert.ok(elapsedMs < 5000, `expected a new SSE snapshot within 5000ms of appending, took ${elapsedMs}ms`);
  } finally {
    client.close();
  }
});

// =============================================================================
// 5/6 -- pre-planted malformed line: skipped + counted, never crashes; process
// still alive and responsive afterward.
// =============================================================================

test('T11 (5/6): the pre-planted malformed events.jsonl line is skipped and counted, never crashes the server -- process still alive, /api/snapshot still responsive', async () => {
  assert.strictEqual(serverProcess.exitCode, null, `server process must still be running (exitCode was ${serverProcess.exitCode})`);
  assert.strictEqual(serverProcess.signalCode, null, `server process must not have been killed by a signal (signalCode was ${serverProcess.signalCode})`);

  const url = `http://127.0.0.1:${PORT}/api/snapshot`;
  const bodyFile = path.join(fixtureRoot, 'curl-snapshot-body-2.json');
  const args = ['-s', '-o', bodyFile, '-w', '%{http_code}', url];
  const httpCode = curl(args);
  const snapshot = JSON.parse(await readFile(bodyFile, 'utf-8'));
  logStep('post-malformed-line liveness check: curl /api/snapshot (real command + real output)', {
    command: `curl ${args.join(' ')}`,
    httpCode,
    skippedLines: snapshot.events.skippedLines,
    eventsCount: snapshot.events.events.length,
    serverExitCode: serverProcess.exitCode,
    serverSignalCode: serverProcess.signalCode,
    serverStderrSoFar: serverStderr.trim(),
  });

  assert.strictEqual(httpCode, '200', 'server must still answer GET /api/snapshot correctly after ingesting the malformed line');
  assert.strictEqual(snapshot.events.skippedLines, 1, 'exactly the 1 pre-planted malformed line, skipped and counted -- never crashed, never silently dropped uncounted');
  assert.strictEqual(snapshot.events.events.length, 2, 'both well-formed lines (seed + appended) must have parsed fine around the skipped malformed one');
});

// =============================================================================
// 6/6 -- a second instance on the same port fails cleanly: non-zero exit, no hang
// =============================================================================

test('T11 (6/6): starting a second server instance on the same GRAPH_DASHBOARD_PORT fails cleanly -- non-zero exit, returns promptly, no hang', async () => {
  const t0 = Date.now();
  const secondProcess = spawn(process.execPath, [SERVER_MJS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GRAPH_DASHBOARD_PORT: String(PORT),
      GRAPH_DASHBOARD_STATE_DIR: stateDir,
      GRAPH_DASHBOARD_JOURNAL_ROOT: journalRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondStderr = '';
  secondProcess.stderr.on('data', (c) => { secondStderr += c.toString(); });

  // Never let a second instance run/hang unbounded (this project's own
  // stall discipline): force it down if it hasn't exited by this bound, and
  // report that as a hang rather than letting the test itself hang.
  const HANG_BOUND_MS = 5000;
  const exitResult = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      secondProcess.kill('SIGKILL');
      resolve({ hung: true, code: null, signal: null });
    }, HANG_BOUND_MS);
    secondProcess.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hung: false, code, signal });
    });
  });
  const elapsedMs = Date.now() - t0;
  logStep('second instance, same port (real command + real exit code)', {
    command: `GRAPH_DASHBOARD_PORT=${PORT} GRAPH_DASHBOARD_STATE_DIR=${stateDir} GRAPH_DASHBOARD_JOURNAL_ROOT=${journalRoot} node ${SERVER_MJS}`,
    elapsedMs,
    exitCode: exitResult.code,
    signal: exitResult.signal,
    hung: exitResult.hung,
    stderr: secondStderr.trim(),
  });

  assert.strictEqual(exitResult.hung, false, `second instance did not exit within the ${HANG_BOUND_MS}ms hang bound -- treated as a hang, not a clean failure`);
  assert.strictEqual(exitResult.signal, null, 'second instance must exit voluntarily (process.exit), not be killed by an external signal');
  assert.notStrictEqual(exitResult.code, 0, 'second instance must fail (non-zero exit) when the port is already taken');
  assert.match(secondStderr, /EADDRINUSE/, "second instance's stderr must name the real reason (EADDRINUSE), not fail silently");
  assert.ok(elapsedMs < HANG_BOUND_MS, `expected a prompt failure well under ${HANG_BOUND_MS}ms, took ${elapsedMs}ms`);

  // The FIRST server must be wholly unaffected by the second instance's
  // rejected startup attempt -- still alive, still answering.
  assert.strictEqual(serverProcess.exitCode, null, 'primary server must still be running after a rejected second-instance startup attempt');
  const health = curl(['-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${PORT}/`]);
  assert.strictEqual(health, '200', 'primary server must still answer after a rejected second-instance startup attempt');
});
