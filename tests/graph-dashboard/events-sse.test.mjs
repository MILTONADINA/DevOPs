// Tests for T6 (GET /events SSE broadcast in scripts/graph-dashboard/server.mjs).
//
// None of the other tests/graph-dashboard/*.test.mjs files make an actual
// request to /events or exercise the dual fs.watch+poll change-detection
// machinery -- reader.test.mjs/events-reader.test.mjs/state-readers.test.mjs/
// snapshot.test.mjs only assert (statically) that the routes Map literal
// contains an '/events' entry pointing at serveEvents. This file closes that
// gap: it spawns the REAL server.mjs (same convention as snapshot.test.mjs's
// own PART 3 -- env-var-pointed at a fixture STATE_DIR/JOURNAL_ROOT, per
// server.mjs's own documented config-resolution comment) and drives real SSE
// connections against it with a minimal hand-rolled SSE frame reader (no
// EventSource global in Node, and this project takes no runtime deps -- see
// server.mjs's own built-ins-only convention).
//
// Run with: node --test tests/graph-dashboard/events-sse.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: THIS_DIR, encoding: 'utf-8' }).trim();
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

const REQUIRED_SNAPSHOT_KEYS = ['approvals', 'cycleHistory', 'events', 'halt', 'phase', 'runs'];

// Distinct base range from snapshot.test.mjs's own INTEGRATION_PORT
// (41000 + pid%4000) so the two files' spawned servers can never collide
// even when node's test runner runs multiple test files concurrently (each
// in its own child process, differentiated here by that same process' pid).
const PORT = 48000 + (process.pid % 4000);

let fixtureRoot, journalRoot, stateDir, eventsPath, haltPath, approvalsDir;
let finishedRunJournalPath, finishedRunJournalContents, activeRunJournalPath;
let serverProcess;
let serverStderr = '';

function httpGetOnce(urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request to ${urlPath} timed out`)));
    req.end();
  });
}

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await httpGetOnce('/');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on port ${PORT} never became ready: ${lastErr && lastErr.message}\n--- server stderr ---\n${serverStderr}`);
}

function parseSseFrame(raw) {
  let event = null;
  let data = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) data = line.slice('data: '.length);
  }
  assert.ok(data !== null, `SSE frame had no "data:" line -- raw was: ${JSON.stringify(raw)}`);
  return { event, raw, json: JSON.parse(data) };
}

// Minimal hand-rolled SSE client. formatSseEvent() in server.mjs guarantees
// each frame is exactly "event: snapshot\ndata: <one-line-json>\n\n" (JSON's
// own \n-escaping keeps "data:" to one line), so splitting the accumulated
// byte stream on the "\n\n" frame terminator is sufficient -- no real SSE
// spec parser (multi-line data:, id:, retry:) is needed for this server's
// own fixed output shape.
function connectSse() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/events', method: 'GET' }, (res) => {
      let buf = '';
      const queue = [];
      const waiters = [];
      res.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(raw);
          if (waiters.length) {
            const waiter = waiters.shift();
            clearTimeout(waiter.timer);
            waiter.resolveFrame(frame);
          } else {
            queue.push(frame);
          }
        }
      });
      res.on('error', () => {});
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        nextFrame(timeoutMs = 4000) {
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((resolveFrame, rejectFrame) => {
            const waiter = { resolveFrame, timer: null };
            waiter.timer = setTimeout(() => {
              const idx = waiters.indexOf(waiter);
              if (idx !== -1) waiters.splice(idx, 1);
              rejectFrame(new Error('timed out waiting for an SSE frame'));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        async waitForFrameMatching(predicate, timeoutMs = 4000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('timed out waiting for a matching SSE frame');
            const frame = await this.nextFrame(remaining);
            if (predicate(frame.json)) return frame;
          }
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-sse-fixtures-'));

  // Two run directories present at BOOT: one already finished (planner
  // started+result -> active:false) and one still active (planner started,
  // no result yet -> active:true per buildRunModel()'s own definition). The
  // active one lets tests below exercise "each currently-active run's own
  // directory" dynamic fs.watch coverage from the very first connection,
  // without needing to wait for a brand-new run to appear first.
  journalRoot = path.join(fixtureRoot, 'journal-root');
  const finishedRunDir = path.join(journalRoot, 'sessFinished', 'subagents', 'workflows', 'wfFinished');
  const activeRunDir = path.join(journalRoot, 'sessActive', 'subagents', 'workflows', 'wfActive');
  await mkdir(finishedRunDir, { recursive: true });
  await mkdir(activeRunDir, { recursive: true });
  finishedRunJournalPath = path.join(finishedRunDir, 'journal.jsonl');
  finishedRunJournalContents =
    '{"type":"started","key":"kF","agentId":"agentF","label":"planner","phase":"Plan"}\n{"type":"result","key":"kF","agentId":"agentF","result":{"tasks":[]}}\n';
  await writeFile(finishedRunJournalPath, finishedRunJournalContents);
  activeRunJournalPath = path.join(activeRunDir, 'journal.jsonl');
  await writeFile(activeRunJournalPath, '{"type":"started","key":"kA","agentId":"agentA","label":"planner","phase":"Plan"}\n');

  stateDir = path.join(fixtureRoot, 'state-dir');
  await mkdir(stateDir, { recursive: true });
  eventsPath = path.join(stateDir, 'events.jsonl');
  await writeFile(eventsPath, '{"type":"seed-evt-1"}\n');
  approvalsDir = path.join(stateDir, 'graph-approvals');
  await mkdir(approvalsDir, { recursive: true });
  // graph-halt deliberately NOT created -- present dir/files exist at boot
  // (fixed fs.watch can attach immediately); this ABSENT one covers the
  // "fs.watch can't watch a path that doesn't exist yet -- the poll is the
  // correctness guarantee" branch server.mjs's own T6 comment calls out.
  haltPath = path.join(stateDir, 'graph-halt');

  serverProcess = spawn(
    process.execPath,
    [SERVER_MJS],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GRAPH_DASHBOARD_PORT: String(PORT),
        GRAPH_DASHBOARD_STATE_DIR: stateDir,
        GRAPH_DASHBOARD_JOURNAL_ROOT: journalRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  serverProcess.stderr.on('data', (c) => { serverStderr += c.toString(); });
  serverProcess.stdout.on('data', () => {}); // drain, avoid backpressure stalls

  await waitForReady();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// Initial connect: headers, immediate snapshot event, matches T5's own
// GET /api/snapshot exactly (proving T6 reuses assembleSnapshot(), not a
// re-derived shape of its own).
// =============================================================================

test('GET /events -- 200 text/event-stream, first frame is "event: snapshot" whose JSON exactly matches a concurrent GET /api/snapshot', async () => {
  const client = await connectSse();
  try {
    assert.strictEqual(client.statusCode, 200);
    assert.match(client.headers['content-type'], /text\/event-stream/);
    assert.match(client.headers['cache-control'], /no-cache/);

    const frame = await client.nextFrame();
    assert.strictEqual(frame.event, 'snapshot');
    assert.deepStrictEqual(Object.keys(frame.json).sort(), REQUIRED_SNAPSHOT_KEYS);

    const apiRes = await httpGetOnce('/api/snapshot');
    assert.strictEqual(apiRes.statusCode, 200);
    assert.deepStrictEqual(frame.json, JSON.parse(apiRes.body), 'the SSE snapshot event must carry exactly assembleSnapshot()\'s JSON, same as /api/snapshot -- no reshaping of its own');
  } finally {
    client.close();
  }
});

test('GET /events -- initial snapshot reflects the fixture: 2 runs (exactly 1 active), halt absent, approvals empty, 1 seed event', async () => {
  const client = await connectSse();
  try {
    const frame = await client.nextFrame();
    assert.strictEqual(frame.json.runs.length, 2);
    const activeCount = frame.json.runs.filter((r) => r.active).length;
    assert.strictEqual(activeCount, 1, 'exactly one fixture run (sessActive/wfActive) must be active');
    assert.deepStrictEqual(frame.json.halt, { halted: false, raw: null });
    assert.deepStrictEqual(frame.json.approvals, []);
    assert.strictEqual(frame.json.events.events.length, 1);
  } finally {
    client.close();
  }
});

// =============================================================================
// Multi-client broadcast fan-out.
// =============================================================================

test('GET /events -- 3 concurrent clients all get an identical initial snapshot, and all 3 get a fresh broadcast after the same change', async () => {
  const clients = await Promise.all([connectSse(), connectSse(), connectSse()]);
  try {
    const initialFrames = await Promise.all(clients.map((c) => c.nextFrame()));
    assert.deepStrictEqual(initialFrames[0].json, initialFrames[1].json);
    assert.deepStrictEqual(initialFrames[1].json, initialFrames[2].json);

    await appendFile(eventsPath, '{"type":"evt-fanout"}\n'); // events.jsonl: 1 -> 2 lines

    const updated = await Promise.all(clients.map((c) => c.waitForFrameMatching((snap) => snap.events.events.length === 2, 3000)));
    for (const frame of updated) {
      assert.strictEqual(frame.json.events.events.length, 2);
    }
  } finally {
    for (const c of clients) c.close();
  }
});

// =============================================================================
// Differential latency pair, proving fs.watch is a REAL, functioning latency
// optimization distinct from the 2s poll (not merely "the poll happened to
// catch it eventually" for every source): a source already watched since
// boot updates fast; a source fs.watch could not have attached to yet (didn't
// exist at boot) only ever updates on the poll's cadence. Run in isolation
// (no other mutating test overlaps these two) so the only plausible trigger
// for each is the mechanism under test.
// =============================================================================

test('GET /events -- fs.watch-driven: editing the already-watched events.jsonl broadcasts well under one 2s poll interval', async () => {
  const client = await connectSse();
  try {
    await client.nextFrame(); // drain initial
    const t0 = Date.now();
    await appendFile(eventsPath, '{"type":"evt-fast-1"}\n'); // events.jsonl: 2 -> 3 lines
    const frame = await client.waitForFrameMatching((snap) => snap.events.events.length === 3, 3000);
    const latencyMs = Date.now() - t0;
    assert.strictEqual(frame.json.events.events.length, 3);
    assert.ok(latencyMs < 1000, `expected fs.watch-driven broadcast well under the 2000ms poll interval, took ${latencyMs}ms`);
  } finally {
    client.close();
  }
});

test('GET /events -- fs.watch-driven: a new marker appearing in the already-watched graph-approvals/ directory broadcasts fast', async () => {
  const client = await connectSse();
  try {
    await client.nextFrame(); // drain initial
    const t0 = Date.now();
    await writeFile(path.join(approvalsDir, 'cyc-sse-1.deploy'), '');
    const frame = await client.waitForFrameMatching((snap) => snap.approvals.includes('cyc-sse-1.deploy'), 3000);
    const latencyMs = Date.now() - t0;
    assert.deepStrictEqual(frame.json.approvals, ['cyc-sse-1.deploy']);
    assert.ok(latencyMs < 1000, `expected fs.watch-driven broadcast well under the 2000ms poll interval, took ${latencyMs}ms`);
  } finally {
    client.close();
  }
});

test('GET /events -- poll-driven: graph-halt did not exist at boot (fs.watch could not attach to it), so its appearance is only caught by the unconditional poll', async () => {
  const client = await connectSse();
  try {
    await client.nextFrame(); // drain initial (halt: absent)
    const t0 = Date.now();
    await writeFile(haltPath, '{"haltedBy":"sse-test"}');
    const frame = await client.waitForFrameMatching((snap) => snap.halt.halted === true, 4000);
    const latencyMs = Date.now() - t0;
    assert.deepStrictEqual(frame.json.halt, { halted: true, raw: '{"haltedBy":"sse-test"}' });
    assert.ok(latencyMs < 3200, `expected the unconditional 2s poll to catch this within one cycle + margin, took ${latencyMs}ms`);
  } finally {
    client.close();
  }
});

// =============================================================================
// "Each currently-active run's own directory" dynamic watching (T2's `active`
// definition), and a brand-new run directory appearing after boot.
// =============================================================================

test('GET /events -- fs.watch-driven: a change inside the already-active run\'s own directory (marking it done) broadcasts fast and flips that run\'s active flag', async () => {
  const client = await connectSse();
  try {
    const initial = await client.nextFrame();
    const before_ = initial.json.runs.find((r) => r.sessionId === 'sessActive');
    assert.ok(before_ && before_.active, 'precondition: sessActive/wfActive must still be active at the start of this test');

    const t0 = Date.now();
    await appendFile(activeRunJournalPath, '{"type":"result","key":"kA","agentId":"agentA","result":{"tasks":[]}}\n');
    const frame = await client.waitForFrameMatching(
      (snap) => {
        const run = snap.runs.find((r) => r.sessionId === 'sessActive');
        return run && run.active === false;
      },
      3000
    );
    const latencyMs = Date.now() - t0;
    assert.ok(latencyMs < 1000, `expected fs.watch on the active run's own directory to broadcast fast, took ${latencyMs}ms`);
  } finally {
    client.close();
  }
});

test('GET /events -- a brand-new run directory created after boot (not present in any fixed watch list) is eventually reflected', async () => {
  const client = await connectSse();
  try {
    await client.nextFrame(); // drain initial (2 runs)
    const newRunDir = path.join(journalRoot, 'sessNew', 'subagents', 'workflows', 'wfNew');
    await mkdir(newRunDir, { recursive: true });
    await writeFile(path.join(newRunDir, 'journal.jsonl'), '{"type":"started","key":"kN","agentId":"agentN","label":"planner","phase":"Plan"}\n');

    const frame = await client.waitForFrameMatching((snap) => snap.runs.some((r) => r.sessionId === 'sessNew'), 3500);
    const newRun = frame.json.runs.find((r) => r.sessionId === 'sessNew');
    assert.ok(newRun.active, 'the newly-appeared run should be active (started, no result yet)');
    assert.strictEqual(frame.json.runs.length, 3, 'run count should now include the new run alongside the 2 fixture runs');
  } finally {
    client.close();
  }
});

// =============================================================================
// Disconnect handling: a graceful client close must not disturb broadcasting
// to remaining clients; an abrupt/hard client-side connection reset (RST,
// simulating a dropped network / killed browser tab -- not a clean FIN) must
// not crash the server process.
// =============================================================================

test('GET /events -- disconnecting one client (graceful) does not disturb broadcasting to a second, still-connected client', async () => {
  const clientD = await connectSse();
  const clientE = await connectSse();
  try {
    await clientD.nextFrame();
    const beforeCount = (await clientE.nextFrame()).json.events.events.length;

    clientD.close();
    await new Promise((r) => setTimeout(r, 150)); // let the server's req.on('close') run

    await appendFile(eventsPath, '{"type":"evt-after-disconnect"}\n');
    const frame = await clientE.waitForFrameMatching((snap) => snap.events.events.length === beforeCount + 1, 3000);
    assert.strictEqual(frame.json.events.events.length, beforeCount + 1);

    // Server must still be healthy after the disconnect.
    const health = await httpGetOnce('/api/snapshot');
    assert.strictEqual(health.statusCode, 200);
  } finally {
    clientE.close();
  }
});

test('GET /events -- an abrupt hard-reset disconnect (TCP RST, no clean FIN) never crashes the server process (3 trials)', async () => {
  for (let trial = 0; trial < 3; trial++) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(PORT, '127.0.0.1', () => {
        socket.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
      });
      let settled = false;
      const finish = (err) => { if (!settled) { settled = true; err ? reject(err) : resolve(); } };
      socket.on('data', () => {
        // Got the initial snapshot bytes -- now hard-kill the connection as
        // abruptly as a real client can: a TCP RST, not a graceful close().
        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
        else socket.destroy();
        finish();
      });
      socket.on('error', () => finish()); // local ECONNRESET echo is expected and irrelevant here
      setTimeout(() => finish(new Error('never received initial SSE bytes')), 3000);
    });

    // Immediately force a broadcast right after the reset, maximizing the
    // chance of the server attempting client.write() on the now-dead socket
    // before its req.on('close') cleanup has run.
    await appendFile(eventsPath, `{"type":"evt-hard-reset-${trial}"}\n`);
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(serverProcess.exitCode, null, `server process must still be running after hard-reset trial ${trial} (exitCode was ${serverProcess.exitCode})`);
    assert.strictEqual(serverProcess.signalCode, null, `server process must not have been killed by a signal after hard-reset trial ${trial}`);

    const health = await httpGetOnce('/api/snapshot');
    assert.strictEqual(health.statusCode, 200, `server must still answer GET /api/snapshot correctly after hard-reset trial ${trial}`);
  }
});

test('GET /events -- POST /events is 404 (route is GET-only, like every other route in this file)', async () => {
  const res = await httpGetOnce('/events', 'POST');
  assert.strictEqual(res.statusCode, 404);
});

// =============================================================================
// Static + functional "never writes to a watched path" checks.
// =============================================================================

test('static: the "SSE broadcast (T6)" section never calls a filesystem-mutating function (only fs.watch\'s own read-only listener API + assembleSnapshot()\'s reads)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('// --- SSE broadcast (T6)');
  const end = src.indexOf('// Exact-path GET routes. T2+ add more entries here');
  assert.notEqual(start, -1, 'could not find the "SSE broadcast (T6)" section marker -- has it been reworded/removed?');
  assert.notEqual(end, -1, 'could not find the routes-Map marker');
  assert.ok(start < end, 'markers found out of order');
  const section = src.slice(start, end);
  const codeOnly = section.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const mutators = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmdir|rmdirSync|\brm\b|rmSync|mkdir|mkdirSync|rename|renameSync|truncate|truncateSync|chmod|chmodSync|chown|chownSync|createWriteStream|copyFile|copyFileSync)\s*\(/;
  assert.ok(!mutators.test(codeOnly), 'the SSE broadcast (T6) section must not call any filesystem-mutating function');
});

test('static: SSE_FIXED_WATCH_PATHS contains exactly the 6 documented fixed sources', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const match = src.match(/const SSE_FIXED_WATCH_PATHS = \[([\s\S]*?)\];/);
  assert.ok(match, 'could not find the SSE_FIXED_WATCH_PATHS array literal');
  const body = match[1];
  for (const expected of [
    'JOURNAL_ROOT,',
    "path.join(STATE_DIR, 'events.jsonl'),",
    "path.join(STATE_DIR, 'graph-halt'),",
    "path.join(STATE_DIR, 'graph-approvals'),",
    "path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'autonomy-config.yml'),",
    "path.join(GIT_TOP_LEVEL, 'governance', 'graph', 'stability-dashboard.md'),",
  ]) {
    assert.ok(body.includes(expected), `SSE_FIXED_WATCH_PATHS is missing expected entry: ${expected}`);
  }
  // NOTE: counting by top-level commas would overcount -- each entry is
  // itself a path.join(a, b, ...) call containing its own internal commas.
  // Each entry occupies its own source line (confirmed against the file's
  // actual current formatting), so count non-blank lines instead.
  const entryCount = body.split('\n').map((s) => s.trim()).filter(Boolean).length;
  assert.strictEqual(entryCount, 6, `expected exactly 6 fixed watch paths, found ${entryCount}`);
});

test('static: serveEvents() never ends the response once the 200 SSE stream is opened (the connection must stay open until client disconnect)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('async function serveEvents(');
  assert.notEqual(start, -1, 'could not find serveEvents() in server.mjs');
  const end = src.indexOf('\n}', start) + 2;
  const body = src.slice(start, end);
  const successPathStart = body.indexOf('res.writeHead(200,');
  assert.notEqual(successPathStart, -1, 'could not find the 200 writeHead call inside serveEvents()');
  const successPath = body.slice(successPathStart);
  assert.ok(!successPath.includes('.end('), 'serveEvents() must never call .end() on the response after opening the 200 SSE stream');
  assert.ok(successPath.includes("sseClients.add(res)"), 'serveEvents() must register the client for broadcast');
  assert.ok(successPath.includes("req.on('close'"), 'serveEvents() must clean up on client disconnect');
});

test('functional: over the whole run of this file, the server never wrote to a path it only ever reads/watches (the never-touched finished run\'s journal.jsonl is byte-identical to what this test wrote)', async () => {
  const current = await readFile(finishedRunJournalPath, 'utf-8');
  assert.strictEqual(current, finishedRunJournalContents, 'scripts/graph-dashboard/server.mjs must never write to a file it only reads/watches');
});
