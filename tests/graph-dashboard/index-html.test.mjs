// Tests for T7 (scripts/graph-dashboard/index.html -- the dashboard's single
// HTML/CSS/JS page).
//
// THREE PARTS, same split rationale as snapshot.test.mjs/events-sse.test.mjs:
//
//   PART 1 (static source checks): regex/string assertions directly on the
//   raw HTML bytes. The single-file / no-external-refs / read-only-forever /
//   exactly-four-node-states constraints are source-SHAPE properties, not
//   runtime behavior, so they are checked the cheap, unambiguous way: grep
//   the actual shipped bytes. A devious implementation could still satisfy
//   every regex here and be behaviorally wrong, which is what PART 2 is for.
//
//   PART 2 (sandboxed client unit tests -- the bulk of this file): the
//   entire inline <script> block is extracted VERBATIM (the exact same
//   "write the extracted source to a temp file and `import()` it" approach
//   every T2-T6 test file already uses for server.mjs -- see reader.test.mjs's
//   own before()) and loaded as a real ES module with document/fetch/
//   EventSource handed to it via a globalThis shadow set immediately before
//   each cache-busted import (see buildSandbox() below for exactly why).
//   This is NOT a reimplementation of the dashboard's logic to test against
//   -- it is the actual shipped IIFE, unmodified, run outside a browser so
//   its behavior can be driven and asserted on deterministically instead of
//   only eyeballed once in a real browser. In particular this is what
//   verifies the task's own explicitly-flagged highest-risk behavior:
//   "if the SSE connection drops, confirm it actually auto-reconnects --
//   don't just assume the browser default does what's needed." A fake
//   EventSource lets this file simulate BOTH the case the browser already
//   handles (readyState stays CONNECTING) and the case it does NOT
//   (readyState reaches CLOSED) and prove the client's manual-reopen code
//   path actually fires -- something no static grep or one-off manual
//   screenshot can establish.
//
//   Every DOM call the real script makes -- getElementById / createElement /
//   appendChild / removeChild / setAttribute / textContent / hidden /
//   className / style.background -- is covered by the harness below; a
//   directly-confirmed exhaustive scan of the source (see the
//   "createElement is only ever called with div/section/span" static test)
//   is why nothing more is needed.
//
//   PART 3 (integration, real process): spawns the REAL `node server.mjs`
//   (same fixture-STATE_DIR/JOURNAL_ROOT convention as every T2-T6 sibling)
//   and confirms GET / serves this exact file byte-for-byte, that the
//   <script> block PART 2 exercises is the SAME text actually served over
//   HTTP (closing the loop between "the code this file tested" and "the
//   code that ships"), and that a real GET /api/snapshot / GET /events
//   payload has the exact shape the client code reads.
//
// Run with: node --test tests/graph-dashboard/index-html.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const INDEX_HTML = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'index.html');
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

// Distinct port range from snapshot.test.mjs (41000-44999) and
// events-sse.test.mjs (48000-51999) -- all three spawn a real integration
// server and may run together in one combined `node --test` invocation
// (one shared process.pid), so a colliding range would EADDRINUSE.
const INTEGRATION_PORT = 45000 + (process.pid % 2000);

// Captured once so PART 2's global document/fetch/EventSource shadow (see
// buildSandbox() below) can be restored in after() -- good hygiene
// regardless of whether `node --test` isolates each file into its own
// process; this file makes the same conservative "maybe not" assumption its
// own INTEGRATION_PORT choice already makes for the same reason.
const ORIGINAL_GLOBALS = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource, setInterval: globalThis.setInterval };

// TEST-HARNESS-ONLY FIX (found and fixed in the tester session that added
// this file's own regression coverage -- not a defect in the shipped
// dashboard): the real script's bottom-of-IIFE `setInterval(fn, 1000)` (the
// ticker that live-updates a running node's elapsed time + the footer's
// "updated Ns ago", see index.html itself) is exactly the correct, intended
// behavior for a real browser tab that stays open indefinitely -- it is
// NOT a bug in index.html/production behavior. But buildSandbox() below
// re-imports that same IIFE fresh (cache-busted) on every single PART-2
// test in this file, and each import unconditionally creates ONE MORE real,
// ref'd Node interval timer that nothing in this harness ever clears --
// with ~20 PART-2 tests, that is ~20 accumulated live timers, and a ref'd
// timer keeps Node's event loop non-empty forever. Confirmed by direct,
// isolated reproduction outside this file (a 20-line throwaway script that
// only imports the real extracted IIFE twice, with the exact same
// document/fetch/EventSource stubs this file installs, and nothing else):
// with no fix, the process still had not exited after 6+ seconds of doing
// nothing; wrapping global setInterval to auto-`.unref()` the handle it
// returns made the same script's `beforeExit` fire and exit 0 in well under
// a second. Left UNfixed, this file (run alone OR combined with any other
// tests/graph-dashboard/*.test.mjs file in one `node --test` invocation)
// never prints a final summary and never exits, at any waiting length --
// this is exactly the failure this comment exists to prevent regressing.
// The fix only wraps the *handle*, not the interval's actual firing
// semantics: a real timer still fires on its normal 1000ms schedule (any
// test that inspects its live-ticking effect still sees it), and a test
// that wants deterministic control already calls
// `t.mock.timers.enable({ apis: [...,'setInterval'] })`, which captures
// "whatever setInterval currently is" (this wrapper) before installing its
// own mock for that test's scope and restores exactly that (this wrapper,
// unharmed) afterward -- so mock-timer tests are unaffected either way.
const REAL_SET_INTERVAL = globalThis.setInterval.bind(globalThis);
globalThis.setInterval = function (...args) {
  const handle = REAL_SET_INTERVAL(...args);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

let rawHtml;
let scriptText;
let sandboxModulePath; // PART 2: scriptText written once, (re-)imported fresh per test -- see buildSandbox()

// PART 3 integration state.
let fixtureRoot;
let integrationProcess;
let integrationStderr = '';

function httpRequest(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`request to ${urlPath} timed out`)));
    req.end();
  });
}

async function waitForReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await httpRequest(port, '/');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server on port ${port} never became ready: ${lastErr && lastErr.message}`);
}

// Minimal hand-rolled SSE client, trimmed from events-sse.test.mjs's own
// connectSse() (same proven frame-splitting approach: formatSseEvent() in
// server.mjs guarantees one frame is exactly "event: snapshot\ndata:
// <one-line-json>\n\n", so splitting on "\n\n" is sufficient).
function readFirstSseFrame(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET', timeout: 5000 }, (res) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('utf-8');
        const idx = buf.indexOf('\n\n');
        if (idx !== -1) {
          res.off('data', onData);
          res.on('error', () => {}); // destroy() below is expected to surface as an error on res too
          req.destroy();
          const raw = buf.slice(0, idx);
          const eventMatch = /^event: (.+)$/m.exec(raw);
          const dataMatch = /^data: (.+)$/m.exec(raw);
          resolve({ event: eventMatch ? eventMatch[1] : null, data: dataMatch ? dataMatch[1] : null });
        }
      };
      res.on('data', onData);
      res.on('error', () => {});
    });
    req.on('error', (err) => {
      if (!req.destroyed) reject(err);
    });
    req.on('timeout', () => req.destroy(new Error('timed out waiting for first SSE frame')));
    req.end();
  });
}

before(async () => {
  // --- Extract the inline <script>, same way for PART 1 and PART 2 -------
  rawHtml = await readFile(INDEX_HTML, 'utf-8');
  const openTagCount = (rawHtml.match(/<script\b/g) || []).length;
  assert.equal(openTagCount, 1, `expected exactly one <script> tag, found ${openTagCount}`);
  const startIdx = rawHtml.indexOf('<script>');
  assert.notEqual(startIdx, -1, 'expected a bare "<script>" tag (no src/type attributes) -- literal match not found');
  const bodyStart = startIdx + '<script>'.length;
  const endIdx = rawHtml.indexOf('</script>', bodyStart);
  assert.notEqual(endIdx, -1, 'no matching </script> found after the opening tag');
  scriptText = rawHtml.slice(bodyStart, endIdx);
  assert.ok(scriptText.includes('EventSource') && scriptText.includes('renderRuns'), 'sanity: extracted slice does not look like the real dashboard script');

  // --- PART 2: write the extracted script to a real .mjs file once. Each
  // test re-imports THIS SAME file with a distinct cache-busting query
  // string (see buildSandbox()), so the content only needs writing once.
  const sandboxTmpDir = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-index-html-sandbox-'));
  sandboxModulePath = path.join(sandboxTmpDir, 'dashboard-script-under-test.mjs');
  await writeFile(sandboxModulePath, scriptText, 'utf-8');

  // --- PART 3 fixture + real server spawn ---------------------------------
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-index-html-fixtures-'));
  const journalRoot = path.join(fixtureRoot, 'journal-root');
  const runDir = path.join(journalRoot, 'sess1', 'subagents', 'workflows', 'wfA');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"kA","agentId":"agentA","label":"planner","phase":"Plan"}\n{"type":"result","key":"kA","agentId":"agentA","result":{"tasks":[]}}\n{"type":"started","key":"kB","agentId":"agentB","label":"reviewer","phase":"Verify"}\n'
  );

  const stateDir = path.join(fixtureRoot, 'state-dir');
  await mkdir(path.join(stateDir, 'graph-approvals'), { recursive: true });
  await writeFile(path.join(stateDir, 'events.jsonl'), '{"type":"evt-1"}\n{"type":"evt-2"}\nnot-json\n');
  await writeFile(path.join(stateDir, 'graph-approvals', 'c1.deploy'), '');
  // graph-halt deliberately absent -- the normal not-halted state.

  integrationProcess = spawn(
    process.execPath,
    [SERVER_MJS],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GRAPH_DASHBOARD_PORT: String(INTEGRATION_PORT),
        GRAPH_DASHBOARD_STATE_DIR: stateDir,
        GRAPH_DASHBOARD_JOURNAL_ROOT: journalRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  integrationProcess.stderr.on('data', (c) => { integrationStderr += c.toString(); });
  integrationProcess.stdout.on('data', () => {}); // drain, avoid backpressure stalls

  try {
    await waitForReady(INTEGRATION_PORT);
  } catch (err) {
    throw new Error(`${err.message}\n--- integration server stderr ---\n${integrationStderr}`);
  }
});

after(async () => {
  globalThis.document = ORIGINAL_GLOBALS.document;
  globalThis.fetch = ORIGINAL_GLOBALS.fetch;
  globalThis.EventSource = ORIGINAL_GLOBALS.EventSource;
  globalThis.setInterval = ORIGINAL_GLOBALS.setInterval;
  if (integrationProcess && integrationProcess.exitCode === null && integrationProcess.signalCode === null) {
    integrationProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (sandboxModulePath) await rm(path.dirname(sandboxModulePath), { recursive: true, force: true });
});

// =============================================================================
// PART 1 -- static source checks
// =============================================================================

test('static: single inlined <style> and <script>, zero external refs of any kind', () => {
  assert.equal((rawHtml.match(/<style\b/g) || []).length, 1);
  assert.equal((rawHtml.match(/<script\b/g) || []).length, 1);
  // PB-56 (closed 2026-09-15): exactly one <link> is allowed -- the empty
  // data: icon that stops the browser's automatic /favicon.ico request (the
  // one console error every real browser load produced). It fetches nothing,
  // so the offline guarantee this test protects is intact; any other <link>,
  // or an icon that points anywhere but an inline data: URL, still fails.
  const links = rawHtml.match(/<link\b[^>]*>/gi) || [];
  assert.equal(links.length, 1, 'exactly one <link>: the inline data: favicon (no stylesheet/preload/external icon)');
  assert.match(links[0], /\brel\s*=\s*["']icon["']/i, 'the only <link> must be the icon');
  assert.match(links[0], /\bhref\s*=\s*["']data:,["']/i, 'the icon must be the empty inline data: URL, never a fetched resource');
  assert.doesNotMatch(rawHtml, /<script\b[^>]*\bsrc\s*=/i, 'a <script src=...> would break offline rendering');
});

test('static: no external resource reference anywhere (fonts, images, @import) -- true offline rendering', () => {
  assert.doesNotMatch(rawHtml, /@import\b/i);
  assert.doesNotMatch(rawHtml, /url\(\s*['"]?https?:\/\//i);
  assert.doesNotMatch(rawHtml, /url\(\s*['"]?\/\//i, 'a protocol-relative URL would also hit the network');
});

test('static: zero mutating controls anywhere on the page (read-only viewer)', () => {
  assert.doesNotMatch(rawHtml, /<button\b/i);
  assert.doesNotMatch(rawHtml, /<a\s[^>]*\bhref\s*=/i);
  assert.doesNotMatch(rawHtml, /<form\b/i);
  assert.doesNotMatch(rawHtml, /<input\b/i);
  assert.doesNotMatch(rawHtml, /\son[a-z]+\s*=/i, 'no inline event-handler attribute (onclick=, onsubmit=, ...)');
});

test('static: the only network calls are GET /api/snapshot and GET /events (SSE) -- nothing mutating', () => {
  const fetchCalls = scriptText.match(/\bfetch\s*\(/g) || [];
  assert.equal(fetchCalls.length, 1, `expected exactly one fetch() call site, found ${fetchCalls.length}`);
  assert.match(scriptText, /fetch\(\s*['"]\/api\/snapshot['"]\s*\)/);

  const esCalls = scriptText.match(/new\s+EventSource\s*\(/g) || [];
  assert.equal(esCalls.length, 1, `expected exactly one "new EventSource(...)" call site, found ${esCalls.length}`);
  assert.match(scriptText, /new EventSource\(\s*['"]\/events['"]\s*\)/);

  for (const forbidden of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', "'POST'", '"POST"', "'PUT'", '"PUT"', "'DELETE'", '"DELETE"', "'PATCH'", '"PATCH"']) {
    assert.ok(!scriptText.includes(forbidden), `found forbidden/mutating primitive in script: ${forbidden}`);
  }
});

test('static: exactly four node states, nothing else', () => {
  assert.match(scriptText, /var NODE_STATES = \['queued', 'running', 'done', 'errored'\];/);
  // CSS custom properties: the four node-state colors plus exactly one
  // connection-status-only shade (--state-reconnecting) -- never a fifth
  // node color, and never a ".node--reconnecting" rule that would let the
  // connection-only shade leak onto an actual node.
  const stateVars = new Set(rawHtml.match(/--state-[a-z]+/g) || []);
  assert.deepEqual([...stateVars].sort(), ['--state-done', '--state-errored', '--state-queued', '--state-reconnecting', '--state-running'].sort());
  for (const s of ['queued', 'running', 'done', 'errored']) {
    assert.match(rawHtml, new RegExp(`\\.node--${s}\\s*\\{`), `missing .node--${s} rule`);
  }
  assert.doesNotMatch(rawHtml, /\.node--reconnecting/);
});

test('static: createElement is only ever called with div/section/span -- no interactive element type appears anywhere in source', () => {
  const tags = [...scriptText.matchAll(/document\.createElement\(\s*['"]([a-zA-Z0-9-]+)['"]\s*\)/g)].map((m) => m[1].toLowerCase());
  assert.ok(tags.length > 0, 'sanity: at least one createElement call must exist');
  const disallowed = tags.filter((t) => !['div', 'section', 'span'].includes(t));
  assert.deepEqual(disallowed, []);
});

test('static: SSE reconnect is not left to the browser default alone -- explicit CLOSED check + fixed 3s manual reopen', () => {
  assert.match(scriptText, /RECONNECT_DELAY_MS\s*=\s*3000\s*;/);
  assert.match(scriptText, /readyState\s*===\s*EventSource\.CLOSED/);
});

test('static: extracted <script> is syntactically valid JS (node --check)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-script-check-'));
  try {
    const scriptPath = path.join(tmp, 'extracted.js');
    await writeFile(scriptPath, scriptText, 'utf-8');
    execFileSync(process.execPath, ['--check', scriptPath], { stdio: 'pipe' }); // throws on non-zero exit
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('static: T8 panels -- all six element ids present exactly once, and the gate-events list is height-capped with internal scroll (never page-level growth)', () => {
  for (const id of ['recent-runs-empty', 'recent-runs-list', 'gate-events-empty', 'gate-events-list', 'cycle-history-empty', 'cycle-history-list']) {
    const count = (rawHtml.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.equal(count, 1, `expected exactly one id="${id}"`);
  }
  const gateListRuleMatch = /\.gate-events-list\s*\{[^}]*\}/.exec(rawHtml);
  assert.ok(gateListRuleMatch, '.gate-events-list CSS rule not found');
  assert.match(gateListRuleMatch[0], /max-height:\s*480px/);
  assert.match(gateListRuleMatch[0], /overflow-y:\s*auto/);
});

// =============================================================================
// PART 2 -- sandboxed client unit tests
// =============================================================================

const FIXED_IDS = [
  'stat-phase-value', 'stat-approvals-value', 'stat-skipped-value',
  'halt-banner', 'halt-banner-contents',
  'runs-empty', 'runs-container',
  // T8: recent runs (T2) / gate events (T3) / cycle history (T4d) panels.
  'recent-runs-empty', 'recent-runs-list',
  'gate-events-empty', 'gate-events-list',
  'cycle-history-empty', 'cycle-history-list',
  'conn-dot', 'conn-status', 'last-updated',
];

function makeElementStub(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    textContent: '',
    className: '',
    hidden: false,
    style: {},
    attrs: {},
    children: [],
    get firstChild() { return this.children.length ? this.children[0] : null; },
    appendChild(node) { this.children.push(node); return node; },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx === -1) throw new Error('removeChild: node is not a child');
      this.children.splice(idx, 1);
      return node;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
  };
}

// A fully fake EventSource this file drives by hand: readyState is set
// directly by a test (simulating exactly what a real browser would have set
// it to before dispatching 'error'), and _emit() invokes whatever listeners
// the real code registered via addEventListener -- so the actual
// connectEvents()/scheduleReconnect() logic under test never knows it isn't
// talking to a real browser EventSource.
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this._listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }
  _emit(type, arg) {
    for (const fn of this._listeners[type] || []) fn(arg);
  }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;
FakeEventSource.instances = [];

// Executes the REAL, unmodified extracted <script> body -- written once to
// sandboxModulePath in before() -- as an actual ES module, with document/
// fetch/EventSource handed to it via a globalThis shadow set immediately
// before a cache-busted `import()` forces Node to evaluate it completely
// fresh. A real <script> tag resolves an unshadowed bare identifier like
// `document` through the page's global scope, so this mirrors that exactly;
// every test gets its own independent module-scope state (its own `var es`,
// `reconnectTimer`, `runningNodeTimers`, ...), same as a real browser
// reloading the page would. Deliberately not `new Function(...)`: nothing
// here is untrusted/attacker-influenced input (scriptText is this repo's own
// committed dashboard source, read straight off disk in before()), but
// writing it to a real module file both matches the project's own
// established T2-T6 extraction convention (see reader.test.mjs) and sidesteps
// the pattern entirely rather than argue about it.
//
// Everything the script references beyond those three (console/Date/
// setTimeout/setInterval/clearTimeout/JSON/Math/isFinite) resolves through
// the real global scope as-is -- confirmed by direct inspection of the
// extracted text (see the "createElement is only ever called with
// div/section/span" static test's sibling scan above; that same read also
// confirmed no other browser-only global -- window/location/navigator/
// history -- is touched anywhere in the script) -- which is exactly what
// lets a calling test use node:test's own t.mock.timers to control
// setTimeout/setInterval/Date deterministically without this harness having
// to reimplement timers itself.
//
// Every DOM call the real script makes (getElementById/createElement/
// appendChild/removeChild/setAttribute/textContent/hidden/className/
// style.background) is covered by the stubs below -- the same exhaustive
// scan just cited is why nothing more is needed.
let sandboxImportCounter = 0;

async function buildSandbox({ fetchImpl } = {}) {
  const byId = new Map(FIXED_IDS.map((id) => [id, makeElementStub('div')]));
  const createdTags = [];
  const fakeDocument = {
    getElementById(id) {
      if (!byId.has(id)) throw new Error(`unexpected getElementById(${JSON.stringify(id)}) -- not one of the page's known element ids`);
      return byId.get(id);
    },
    createElement(tag) {
      createdTags.push(tag);
      return makeElementStub(tag);
    },
  };
  FakeEventSource.instances = [];
  const fetchCalls = [];
  const fakeFetch = (url) => {
    fetchCalls.push(url);
    return fetchImpl ? fetchImpl(url) : Promise.reject(new Error('buildSandbox(): no fetchImpl provided'));
  };

  globalThis.document = fakeDocument;
  globalThis.fetch = fakeFetch;
  globalThis.EventSource = FakeEventSource;
  sandboxImportCounter += 1;
  await import(`file://${sandboxModulePath}?sandbox=${sandboxImportCounter}`);

  return {
    el: Object.fromEntries(byId),
    createdTags,
    fetchCalls,
    es: () => FakeEventSource.instances,
  };
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function baseSnapshot(overrides = {}) {
  return {
    runs: [],
    events: { events: [], skippedLines: 0 },
    halt: { halted: false, raw: null },
    approvals: [],
    phase: null,
    cycleHistory: [],
    ...overrides,
  };
}

function activeRunFixture(overrides = {}) {
  const now = Date.now();
  return {
    sessionId: 'sess-abc',
    workflowId: 'wf-123',
    runDir: '/fake/run/dir',
    active: true,
    firstActivityMs: now - 120000,
    lastActivityMs: now,
    backlogItem: 'Ship the graph dashboard',
    cycleId: null,
    cycleOutcome: null,
    validatorOutcome: null,
    labels: {},
    expectedLabels: ['planner', 'coder:T1', 'tester:T1', 'coder:T2', 'tester:T2', 'reviewer', 'security', 'validator'],
    nodes: [
      { label: 'planner', status: 'done', phase: 'Plan', key: 'k0', agentId: 'a0', result: { tasks: [{ id: 'T1' }, { id: 'T2' }] }, startedAtMs: now - 100000, lastEventAtMs: now - 90000, elapsedMs: 10000 },
      { label: 'coder:T1', status: 'done', phase: 'Build', key: 'k1', agentId: 'a1', result: {}, startedAtMs: now - 90000, lastEventAtMs: now - 80000, elapsedMs: 10000 },
      { label: 'tester:T1', status: 'errored', phase: 'Build', key: 'k2', agentId: 'a2', result: null, startedAtMs: now - 80000, lastEventAtMs: now - 79000, elapsedMs: 1000 },
      { label: 'coder:T2', status: 'running', phase: 'Build', key: 'k3', agentId: 'a3', result: null, startedAtMs: now - 65000, lastEventAtMs: null, elapsedMs: null },
      { label: 'tester:T2', status: 'queued', phase: null, key: null, agentId: null, result: null, startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
      { label: 'reviewer', status: 'queued', phase: null, key: null, agentId: null, result: null, startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
      { label: 'security', status: 'queued', phase: null, key: null, agentId: null, result: null, startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
      { label: 'validator', status: 'queued', phase: null, key: null, agentId: null, result: null, startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
    ],
    ...overrides,
  };
}

function nodeBoxes(chainEl) {
  return chainEl.children.filter((c) => c.className.startsWith('node '));
}

function readNodeBox(box) {
  const hasTask = box.children.length === 4;
  return {
    className: box.className,
    dataStatus: box.attrs['data-status'],
    role: box.children[0].textContent,
    taskId: hasTask ? box.children[1].textContent : null,
    statusLabel: box.children[hasTask ? 2 : 1].textContent,
    time: box.children[hasTask ? 3 : 2].textContent,
  };
}

// --- Load/connect ordering ---------------------------------------------------

test('client: on load, fetches /api/snapshot exactly once and opens exactly one EventSource at /events', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) }); // never resolves -- only call shape matters here
  assert.deepEqual(sbx.fetchCalls, ['/api/snapshot']);
  assert.equal(sbx.es().length, 1);
  assert.equal(sbx.es()[0].url, '/events');
});

test('client: a failed initial fetch is non-fatal -- the page still self-heals via the first SSE snapshot event', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => Promise.reject(new Error('network down')) });
  await flushMicrotasks();
  const es = sbx.es()[0];
  assert.ok(es, 'connectEvents() must still run even though the initial fetch rejected');
  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ phase: 2 })) });
  await flushMicrotasks();
  assert.equal(sbx.el['stat-phase-value'].textContent, '2 — Low-risk merge-to-main may loosen');
});

// --- Top bar + halt banner ---------------------------------------------------

test('client: initial GET /api/snapshot paints the top bar and halt banner', async () => {
  const fixture = baseSnapshot({
    phase: 1,
    approvals: ['c1.deploy', 'c1.billing-1'],
    events: { events: [], skippedLines: 4 },
    halt: { halted: true, raw: 'HALTED: manual test\nsecond line' },
  });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();

  assert.equal(sbx.el['stat-phase-value'].textContent, '1 — Autonomous inner loop — deploy/billing still gated');
  assert.equal(sbx.el['stat-approvals-value'].textContent, '2');
  assert.equal(sbx.el['stat-skipped-value'].textContent, '4');
  assert.equal(sbx.el['halt-banner'].hidden, false);
  assert.equal(sbx.el['halt-banner-contents'].textContent, 'HALTED: manual test\nsecond line');
});

test('client: halt.halted=false hides the banner and clears its contents', async () => {
  const fixture = baseSnapshot({ halt: { halted: false, raw: null } });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  assert.equal(sbx.el['halt-banner'].hidden, true);
  assert.equal(sbx.el['halt-banner-contents'].textContent, '');
});

test('client: halt present but the file is empty falls back to a placeholder, never blank', async () => {
  const fixture = baseSnapshot({ halt: { halted: true, raw: '' } });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  assert.equal(sbx.el['halt-banner'].hidden, false);
  assert.equal(sbx.el['halt-banner-contents'].textContent, '(halt file present, but empty)');
});

test('client: autonomy phase label mapping -- known values, an unrecognized integer, and null', async () => {
  const cases = [
    [0, '0 — Pilot — full human gate on every step'],
    [2, '2 — Low-risk merge-to-main may loosen'],
    [7, '7'],
    [null, 'Unknown'],
  ];
  for (const [phase, expected] of cases) {
    const fixture = baseSnapshot({ phase });
    const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
    await flushMicrotasks();
    assert.equal(sbx.el['stat-phase-value'].textContent, expected, `phase=${phase}`);
  }
});

// --- Runs area: empty state, multi-run, node rendering -----------------------

test('client: zero active runs renders the empty state, not a blank page', async () => {
  const fixture = baseSnapshot({ runs: [activeRunFixture({ active: false })] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  assert.equal(sbx.el['runs-empty'].hidden, false);
  assert.equal(sbx.el['runs-container'].hidden, true);
  assert.equal(sbx.el['runs-container'].children.length, 0);
});

test('client: renders one card per ACTIVE run only, side by side; inactive runs excluded', async () => {
  const runActive1 = activeRunFixture({ workflowId: 'wf-A' });
  const runActive2 = activeRunFixture({ workflowId: 'wf-B', sessionId: 'sess-2', backlogItem: 'Second run' });
  const runInactive = activeRunFixture({ workflowId: 'wf-C', active: false });
  const fixture = baseSnapshot({ runs: [runActive1, runInactive, runActive2] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  assert.equal(sbx.el['runs-empty'].hidden, true);
  assert.equal(sbx.el['runs-container'].hidden, false);
  assert.equal(sbx.el['runs-container'].children.length, 2);
  const titles = sbx.el['runs-container'].children.map((c) => c.children[0].children[1].textContent);
  assert.deepEqual(titles, ['sess-abc / wf-A', 'sess-2 / wf-B'], 'excludes the inactive run; preserves snapshot order for the rest');
});

test('client: run card renders nodes in server order with correct 4-state classes/labels/elapsed, and a "first non-done wins" phase-strip frontier', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const now = Date.now();
  const run = activeRunFixture({
    nodes: [
      { label: 'planner', status: 'done', phase: 'Plan', elapsedMs: 10000, startedAtMs: now - 100000 },
      { label: 'coder:T1', status: 'done', phase: 'Build', elapsedMs: 10000, startedAtMs: now - 90000 },
      { label: 'tester:T1', status: 'errored', phase: 'Build', elapsedMs: 1000, startedAtMs: now - 80000 },
      { label: 'coder:T2', status: 'running', phase: 'Build', elapsedMs: null, startedAtMs: now - 65000 },
      { label: 'tester:T2', status: 'queued', phase: null, elapsedMs: null, startedAtMs: null },
      { label: 'reviewer', status: 'queued', phase: null, elapsedMs: null, startedAtMs: null },
      { label: 'security', status: 'queued', phase: null, elapsedMs: null, startedAtMs: null },
      { label: 'validator', status: 'queued', phase: null, elapsedMs: null, startedAtMs: null },
    ],
  });
  const fixture = baseSnapshot({ runs: [run] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();

  const card = sbx.el['runs-container'].children[0];
  const [header, phaseStrip, chain] = card.children;
  assert.equal(header.children[0].textContent, 'Ship the graph dashboard');
  assert.equal(header.children[1].textContent, 'sess-abc / wf-123');

  // Build must be current: tester:T1 (errored) is the first non-done node in
  // chain order, even though coder:T2 further along is actively running.
  // Highlighting off the running node instead of the true frontier is
  // exactly the kind of subtle bug this assertion exists to catch.
  const steps = phaseStrip.children.map((s) => ({ text: s.textContent, current: s.className.includes('phase-step--current') }));
  assert.deepEqual(steps, [
    { text: 'Plan', current: false },
    { text: 'Build', current: true },
    { text: 'Verify', current: false },
    { text: 'Release', current: false },
  ]);

  assert.equal(chain.children.length, 15, '8 nodes + 7 "->" connectors, strictly alternating');
  const boxes = nodeBoxes(chain).map(readNodeBox);
  assert.equal(boxes.length, 8);

  assert.deepEqual(boxes[0], { className: 'node node--done', dataStatus: 'done', role: 'planner', taskId: null, statusLabel: 'Done', time: '10s' });
  assert.deepEqual(boxes[1], { className: 'node node--done', dataStatus: 'done', role: 'coder', taskId: 'T1', statusLabel: 'Done', time: '10s' });
  assert.deepEqual(boxes[2], { className: 'node node--errored', dataStatus: 'errored', role: 'tester', taskId: 'T1', statusLabel: 'Errored', time: '1s' });
  assert.equal(boxes[3].className, 'node node--running');
  assert.equal(boxes[3].statusLabel, 'Running');
  assert.equal(boxes[3].time, '1m 05s', 'running node computes live elapsed from startedAtMs at render time (65s ago)');
  assert.deepEqual(boxes[4], { className: 'node node--queued', dataStatus: 'queued', role: 'tester', taskId: 'T2', statusLabel: 'Queued', time: '' });
  assert.equal(boxes[5].time, '', 'queued nodes never show a time');
  assert.equal(boxes[6].time, '');
  assert.equal(boxes[7].time, '');

  // Live ticking: advance the fake clock 5s (letting the script's own 1s
  // setInterval ticker fire) and confirm the SAME dom node updates on its
  // own -- not merely computed once at render time.
  const runningTimeEl = nodeBoxes(chain)[3].children[3];
  t.mock.timers.tick(5000);
  assert.equal(runningTimeEl.textContent, '1m 10s', 'ticked forward 5s with no new snapshot event');
});

test('client: phase strip highlights Release once every chain node is done', async () => {
  const run = activeRunFixture({
    nodes: [
      { label: 'planner', status: 'done', phase: 'Plan', elapsedMs: 1000 },
      { label: 'reviewer', status: 'done', phase: 'Verify', elapsedMs: 1000 },
      { label: 'security', status: 'done', phase: 'Verify', elapsedMs: 1000 },
      { label: 'validator', status: 'done', phase: 'Verify', elapsedMs: 1000 },
    ],
  });
  const fixture = baseSnapshot({ runs: [run] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const phaseStrip = sbx.el['runs-container'].children[0].children[1];
  const current = phaseStrip.children.filter((s) => s.className.includes('current')).map((s) => s.textContent);
  assert.deepEqual(current, ['Release']);
});

test('client: a run with no derivable chain (e.g. a non-sprint-cycle run) gets no fabricated phase highlight', async () => {
  const run = activeRunFixture({
    backlogItem: null,
    expectedLabels: [],
    nodes: [{ label: 'refute:something', status: 'running', phase: null, elapsedMs: null, startedAtMs: Date.now() - 1000 }],
  });
  const fixture = baseSnapshot({ runs: [run] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const card = sbx.el['runs-container'].children[0];
  const [header, phaseStrip, chain] = card.children;
  assert.equal(header.children[0].textContent, 'Run wf-123', 'null backlogItem falls back to "Run <workflowId>"');
  const current = phaseStrip.children.filter((s) => s.className.includes('current'));
  assert.deepEqual(current, [], 'no step is ever highlighted for a non-derivable chain');
  const boxes = nodeBoxes(chain).map(readNodeBox);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].role, 'refute', 'label is split on ":" exactly like a real coder:/tester: label -- not treated specially');
  assert.equal(boxes[0].taskId, 'something');
});

test('client: an unrecognized node status degrades to queued-colored + blank time, raw status/label preserved verbatim, never throws', async () => {
  const run = activeRunFixture({ nodes: [{ label: 'planner', status: 'cancelled', phase: null, elapsedMs: 5000, startedAtMs: null }] });
  const fixture = baseSnapshot({ runs: [run] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const boxes = nodeBoxes(sbx.el['runs-container'].children[0].children[2]).map(readNodeBox);
  assert.equal(boxes[0].className, 'node node--queued', 'an unrecognized status is never left uncolored -- falls back to queued');
  assert.equal(boxes[0].dataStatus, 'cancelled', 'the raw status is still preserved on data-status even though the class coerced');
  assert.equal(boxes[0].statusLabel, 'cancelled', 'unrecognized status text passed through verbatim, never fabricated into a known label');
  assert.equal(boxes[0].time, '', 'no elapsed time is shown for a status the client does not recognize as running/done/errored');
});

test('client: never creates a button/link/form/input element at runtime, across a realistic multi-state render', async () => {
  const fixture = baseSnapshot({
    phase: 0,
    approvals: ['x'],
    events: { events: [], skippedLines: 1 },
    halt: { halted: true, raw: 'x' },
    runs: [activeRunFixture()],
  });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const forbidden = sbx.createdTags.map((t) => t.toLowerCase()).filter((t) => ['button', 'a', 'form', 'input', 'select', 'textarea'].includes(t));
  assert.deepEqual(forbidden, []);
  assert.ok(sbx.createdTags.length > 0, 'sanity: the render actually created elements');
});

// --- Re-render on every SSE snapshot event ------------------------------------

test('client: each server-pushed "snapshot" SSE event re-renders the page, not just the first', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) }); // fetch never resolves -- SSE only
  const es = sbx.es()[0];
  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ phase: 5 })) });
  await flushMicrotasks();
  assert.equal(sbx.el['stat-phase-value'].textContent, '5');
  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ phase: 6, approvals: ['a', 'b', 'c'] })) });
  await flushMicrotasks();
  assert.equal(sbx.el['stat-phase-value'].textContent, '6');
  assert.equal(sbx.el['stat-approvals-value'].textContent, '3');
});

test('client: a malformed SSE snapshot payload is caught, never throws, and never wedges later renders', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  const es = sbx.es()[0];
  assert.doesNotThrow(() => es._emit('snapshot', { data: '{not json' }));
  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ phase: 3 })) });
  await flushMicrotasks();
  assert.equal(sbx.el['stat-phase-value'].textContent, '3');
});

// --- SSE reconnect: the task's own explicitly-flagged risk --------------------

test('client: SSE error while readyState is still CONNECTING -- browser default trusted, no redundant manual reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  const es1 = sbx.es()[0];
  es1.readyState = FakeEventSource.CONNECTING;
  es1._emit('error');
  t.mock.timers.tick(10000); // well past RECONNECT_DELAY_MS
  assert.equal(sbx.es().length, 1, 'no second EventSource constructed -- the browser is already retrying es1 on its own');
});

test('client: SSE error with readyState CLOSED -- the browser default would NOT retry, so the client manually reopens after ~3s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  const es1 = sbx.es()[0];
  es1.readyState = FakeEventSource.CLOSED;
  es1._emit('error');

  assert.equal(sbx.es().length, 1, 'must not reconnect synchronously/instantly');
  t.mock.timers.tick(2999);
  assert.equal(sbx.es().length, 1, 'must not reconnect before RECONNECT_DELAY_MS has elapsed');

  t.mock.timers.tick(1);
  assert.equal(sbx.es().length, 2, 'a fresh EventSource must be opened once the delay elapses');
  assert.equal(sbx.es()[1].url, '/events');
  assert.equal(es1.closed, true, 'the dead connection is explicitly closed, not just abandoned');

  // Prove the NEW connection, not the dead one, is what the page now listens
  // to.
  sbx.es()[1]._emit('snapshot', { data: JSON.stringify(baseSnapshot({ phase: 9 })) });
  await flushMicrotasks();
  assert.equal(sbx.el['stat-phase-value'].textContent, '9');
});

test('client: repeated CLOSED errors before the reconnect timer fires do not schedule duplicate reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  const es1 = sbx.es()[0];
  es1.readyState = FakeEventSource.CLOSED;
  es1._emit('error');
  es1._emit('error'); // redundant errors before the 3s timer fires
  es1._emit('error');
  t.mock.timers.tick(3000);
  assert.equal(sbx.es().length, 2, 'exactly one reconnect happens -- never a pile-up of timers/connections');
});

test('client: connection status text reflects connecting -> live -> reconnecting -> live across a real drop-and-recover cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  assert.equal(sbx.el['conn-status'].textContent, 'Connecting…');

  const es1 = sbx.es()[0];
  es1._emit('open');
  assert.equal(sbx.el['conn-status'].textContent, 'Live');

  // Establish a real snapshot first, so lastSnapshotAtMs gets set -- the
  // real code's own "connecting" (never yet seen data) vs "reconnecting"
  // (lost a connection that HAD delivered data) distinction can only be
  // exercised once at least one snapshot has actually landed.
  es1._emit('snapshot', { data: JSON.stringify(baseSnapshot()) });
  assert.equal(sbx.el['conn-status'].textContent, 'Live');

  es1.readyState = FakeEventSource.CLOSED;
  es1._emit('error');
  assert.equal(sbx.el['conn-status'].textContent, 'Reconnecting…');

  t.mock.timers.tick(3000);
  assert.equal(sbx.es().length, 2);
  assert.equal(sbx.el['conn-status'].textContent, 'Reconnecting…', 'still reconnecting until the new connection actually opens');
  sbx.es()[1]._emit('open');
  assert.equal(sbx.el['conn-status'].textContent, 'Live');
});

// --- T8: recent runs (T2) / gate events (T3) / cycle history (T4d) panels ---
//
// All three panels are populated from fields the SAME snapshot object above
// already carries (runs, events.events, cycleHistory) -- driven through a
// real buildSandbox() render exactly like every other PART 2 test, never a
// reimplementation of the panels' own rendering logic.

function recentRunFixture(overrides = {}) {
  return {
    sessionId: 'sess-x',
    workflowId: 'wf-x',
    runDir: '/fake/run/dir',
    active: false,
    firstActivityMs: null,
    lastActivityMs: Date.now(),
    backlogItem: null,
    cycleId: null,
    cycleOutcome: null,
    validatorOutcome: null,
    labels: {},
    expectedLabels: [],
    nodes: [],
    ...overrides,
  };
}

function readRecentRunRow(row) {
  const [head, timeLine, backlogLine, outcomeLine] = row.children;
  const [idEl, badgeEl] = head.children;
  const backlogValueEl = backlogLine.children[1];
  const outcomeValueEl = outcomeLine.children[1];
  return {
    idText: idEl.textContent,
    badgeText: badgeEl.textContent,
    badgeClass: badgeEl.className,
    timeText: timeLine.textContent,
    backlogText: backlogValueEl.textContent,
    backlogIsPlaceholder: backlogValueEl.className.includes('recent-run-placeholder'),
    outcomeText: outcomeValueEl.textContent,
    outcomeClass: outcomeValueEl.className,
  };
}

function gateEventFixture(overrides = {}) {
  return { event: 'session_start', ts: 1700000000, ...overrides };
}

function readGateEventRow(row) {
  const [badgeEl, timeEl] = row.children[0].children;
  const fieldsEl = row.children[1] || null; // present only when the event carried an extra field
  const fields = fieldsEl ? fieldsEl.children.map((f) => ({ key: f.children[0].textContent, value: f.children[1].textContent })) : null;
  return { badgeText: badgeEl.textContent, badgeClass: badgeEl.className, timeText: timeEl.textContent, fields };
}

function cycleRowFixture(overrides = {}) {
  return {
    cycle: 'phase0-000-fixture',
    date: '2026-01-01',
    backlogItem: 'Some fixture backlog item',
    outcome: 'stable',
    deployBillingGateHit: 'No',
    claimValidatorResult: 'pass',
    changeFailure: 'No',
    environmentFaults: '0; n/a',
    notes: 'Some fixture notes.',
    ...overrides,
  };
}

function readCycleCard(card) {
  const [head, backlogField, outcomeField, gateField, claimField, failureField, environmentField, notesField] = card.children;
  const val = (field) => field.children[1];
  return {
    idText: head.children[0].textContent,
    dateText: head.children[1].textContent,
    backlogLabel: backlogField.children[0].textContent,
    backlogText: val(backlogField).textContent,
    outcomeLabel: outcomeField.children[0].textContent,
    outcomeText: val(outcomeField).textContent,
    gateLabel: gateField.children[0].textContent,
    gateText: val(gateField).textContent,
    claimLabel: claimField.children[0].textContent,
    claimText: val(claimField).textContent,
    failureLabel: failureField.children[0].textContent,
    failureText: val(failureField).textContent,
    environmentLabel: environmentField.children[0].textContent,
    environmentText: val(environmentField).textContent,
    notesLabel: notesField.children[0].textContent,
    notesText: val(notesField).textContent,
    notesValueClass: val(notesField).className,
  };
}

// --- (1) Recent runs ---------------------------------------------------

test('client: recent-runs empty state when there are no runs at all', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => baseSnapshot() }) });
  await flushMicrotasks();
  assert.equal(sbx.el['recent-runs-empty'].hidden, false);
  assert.equal(sbx.el['recent-runs-list'].hidden, true);
  assert.equal(sbx.el['recent-runs-list'].children.length, 0);
});

test('client: recent-runs renders at most 10 rows, taking the FIRST 10 of snapshot.runs verbatim -- sorting newest-first is the server\'s job, not re-done here', async () => {
  const runs = [];
  for (let i = 0; i < 13; i++) runs.push(recentRunFixture({ workflowId: 'wf-' + i }));
  const fixture = baseSnapshot({ runs });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  assert.equal(sbx.el['recent-runs-empty'].hidden, true);
  assert.equal(sbx.el['recent-runs-list'].hidden, false);
  const rows = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
  assert.equal(rows.length, 10, 'never more than the last 10, even with 13 runs in the snapshot');
  assert.deepEqual(rows.map((r) => r.idText.split(' / ')[1]), Array.from({ length: 10 }, (_, i) => 'wf-' + i));
});

test('client: recent-runs id line falls back to "unknown session"/"unknown workflow" rather than a blank when either is missing', async () => {
  const fixture = baseSnapshot({ runs: [recentRunFixture({ sessionId: null, workflowId: undefined })] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [row] = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
  assert.equal(row.idText, 'unknown session / unknown workflow');
});

test('client: recent-runs Active now / Finished badge mirrors run.active', async () => {
  const fixture = baseSnapshot({ runs: [recentRunFixture({ active: true }), recentRunFixture({ active: false })] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [r0, r1] = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
  assert.equal(r0.badgeText, 'Active now');
  assert.ok(r0.badgeClass.includes('recent-run-badge--active'));
  assert.equal(r1.badgeText, 'Finished');
  assert.ok(r1.badgeClass.includes('recent-run-badge--finished'));
});

test('client: recent-runs backlog item shows the recovered text verbatim, or an explicit "not recovered for this run" placeholder -- never a blank', async () => {
  const fixture = baseSnapshot({
    runs: [
      recentRunFixture({ backlogItem: 'Ship the T8 panels' }),
      recentRunFixture({ backlogItem: null }),
      recentRunFixture({ backlogItem: '' }), // T2 hands back null, not '', but the guard covers both the same way
    ],
  });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [r0, r1, r2] = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
  assert.equal(r0.backlogText, 'Ship the T8 panels');
  assert.equal(r0.backlogIsPlaceholder, false);
  for (const r of [r1, r2]) {
    assert.equal(r.backlogText, 'not recovered for this run');
    assert.equal(r.backlogIsPlaceholder, true);
  }
});

test('client: recent-runs last-activity renders a human date, or "not recoverable" when unavailable -- never blank/Invalid Date', async () => {
  const fixture = baseSnapshot({ runs: [recentRunFixture({ lastActivityMs: Date.UTC(2026, 0, 15, 12, 0, 0) }), recentRunFixture({ lastActivityMs: null })] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [r0, r1] = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
  assert.match(r0.timeText, /^Last activity: /);
  assert.doesNotMatch(r0.timeText, /not recoverable|Invalid Date/);
  assert.equal(r1.timeText, 'Last activity: not recoverable');
});

test('client: recent-runs validator-outcome proxy covers signed-off / not-signed-off / unclear / not-yet-available, each labeled and colored, never blank', async () => {
  const cases = [
    [null, 'not yet available', 'outcome-muted'],
    [undefined, 'not yet available', 'outcome-muted'],
    ['a malformed non-object result', 'not yet available', 'outcome-muted'],
    [{}, 'outcome unclear — (no reason recorded)', 'outcome-muted'],
    [{ reason: 'schema drift' }, 'outcome unclear — schema drift', 'outcome-muted'],
    [{ signed_off: true, reason: 'all checks passed' }, 'Signed off — all checks passed', 'outcome-good'],
    [{ signed_off: true }, 'Signed off — (no reason recorded)', 'outcome-good'],
    [{ signed_off: false, reason: 'missing tests' }, 'Not signed off — missing tests', 'outcome-bad'],
  ];
  for (const [validatorOutcome, expectedText, expectedClass] of cases) {
    const fixture = baseSnapshot({ runs: [recentRunFixture({ validatorOutcome })] });
    const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
    await flushMicrotasks();
    const [row] = sbx.el['recent-runs-list'].children.map(readRecentRunRow);
    assert.equal(row.outcomeText, expectedText, `validatorOutcome=${JSON.stringify(validatorOutcome)}`);
    assert.ok(row.outcomeClass.includes(expectedClass), `validatorOutcome=${JSON.stringify(validatorOutcome)} -> class ${row.outcomeClass}`);
  }
});

// --- (2) Gate events -----------------------------------------------------

test('client: gate-events empty state when there are no events', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => baseSnapshot() }) });
  await flushMicrotasks();
  assert.equal(sbx.el['gate-events-empty'].hidden, false);
  assert.equal(sbx.el['gate-events-list'].hidden, true);
  assert.equal(sbx.el['gate-events-list'].children.length, 0);
});

test('client: gate-events renders newest-first -- reverses a COPY of the oldest-first array T3 hands back, never mutates the snapshot in place', async () => {
  const events = [gateEventFixture({ event: 'e-oldest' }), gateEventFixture({ event: 'e-middle' }), gateEventFixture({ event: 'e-newest' })];
  const fixture = baseSnapshot({ events: { events, skippedLines: 0 } });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const rows = sbx.el['gate-events-list'].children.map(readGateEventRow);
  assert.deepEqual(rows.map((r) => r.badgeText), ['e-newest', 'e-middle', 'e-oldest']);
  assert.deepEqual(events.map((e) => e.event), ['e-oldest', 'e-middle', 'e-newest'], "the snapshot's own array must be untouched by rendering");
});

test('client: gate-events badge category covers the real hook-emitted event-type vocabulary -- blocked/approved/warning/info/other, each a distinct color class', async () => {
  const cases = [
    ['deploy_gate_block', 'blocked'], ['sealed_ref_block', 'blocked'], ['rm_blocked', 'blocked'], ['prod_write_blocked', 'blocked'],
    ['boundary_blocked', 'blocked'], ['secret_block', 'blocked'], ['secret_detected', 'blocked'],
    ['external_content.missing_hmac', 'blocked'], ['external_content.hmac_mismatch', 'blocked'],
    ['deploy_gate_approved', 'approved'], ['billing_gate_approved', 'approved'], ['prod_action_approved', 'approved'],
    ['destructive_in_project', 'warning'], ['external_content.no_session_key', 'warning'],
    ['session_start', 'info'], ['session_end', 'info'], ['session_key.rotated', 'info'], ['lr_refined_date_synced', 'info'],
    ['some_future_hook_event_no_one_has_written_yet', 'other'],
  ];
  for (const [eventType, expectedCategory] of cases) {
    const fixture = baseSnapshot({ events: { events: [gateEventFixture({ event: eventType })], skippedLines: 0 } });
    const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
    await flushMicrotasks();
    const [row] = sbx.el['gate-events-list'].children.map(readGateEventRow);
    assert.equal(row.badgeText, eventType);
    assert.equal(row.badgeClass, 'gate-badge gate-badge--' + expectedCategory, `event=${eventType}`);
  }
});

test('client: gate-events with a missing/empty/non-string type renders "(unlabeled event)" in the "other" category, never a blank badge or a crash', async () => {
  const rawEvents = [
    { ts: 1700000000, note: 'no event field at all' },
    { event: '', ts: 1700000001 },
    { event: null, ts: 1700000002 },
    { event: 123, ts: 1700000003 },
  ];
  for (const raw of rawEvents) {
    const fixture = baseSnapshot({ events: { events: [raw], skippedLines: 0 } });
    const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
    await flushMicrotasks();
    const [row] = sbx.el['gate-events-list'].children.map(readGateEventRow);
    assert.equal(row.badgeText, '(unlabeled event)', `raw=${JSON.stringify(raw)}`);
    assert.equal(row.badgeClass, 'gate-badge gate-badge--other', `raw=${JSON.stringify(raw)}`);
  }
});

test('client: gate-events timestamp handles both real on-disk shapes (unix-seconds number, ISO-8601 string) plus missing/unparseable -- never blank or "Invalid Date"', async () => {
  const cases = [
    [1700000000, false], // unix seconds -- most hooks
    ['2026-01-15T12:00:00Z', false], // ISO-8601 -- external-content-boundary.sh's Python branch
    [undefined, true], // missing entirely
    ['not-a-real-date', true], // unparseable string
    [NaN, true], // non-finite number
  ];
  for (const [ts, expectPlaceholder] of cases) {
    const raw = ts === undefined ? { event: 'session_start' } : { event: 'session_start', ts };
    const fixture = baseSnapshot({ events: { events: [raw], skippedLines: 0 } });
    const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
    await flushMicrotasks();
    const [row] = sbx.el['gate-events-list'].children.map(readGateEventRow);
    assert.doesNotMatch(row.timeText, /Invalid Date/, `ts=${JSON.stringify(ts)}`);
    if (expectPlaceholder) {
      assert.equal(row.timeText, 'timestamp not recoverable', `ts=${JSON.stringify(ts)}`);
    } else {
      assert.notEqual(row.timeText, 'timestamp not recoverable', `ts=${JSON.stringify(ts)}`);
      assert.ok(row.timeText.length > 0);
    }
  }
});

test('client: gate-events renders every extra field as a generic key:value line beyond ts/event, in the event\'s own key order, formatted per value type -- and omits the fields block entirely when nothing extra exists', async () => {
  const withExtras = {
    event: 'deploy_gate_block', ts: 1700000000,
    reason: 'sealed ref detected', cycle: 'c42', attempts: 3, approved: false,
    approvers: ['alice', 'bob'], extra: null, blank: '',
  };
  const fixture = baseSnapshot({ events: { events: [withExtras], skippedLines: 0 } });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [row] = sbx.el['gate-events-list'].children.map(readGateEventRow);
  assert.deepEqual(row.fields, [
    { key: 'reason: ', value: 'sealed ref detected' },
    { key: 'cycle: ', value: 'c42' },
    { key: 'attempts: ', value: '3' },
    { key: 'approved: ', value: 'false' },
    { key: 'approvers: ', value: '["alice","bob"]' },
    { key: 'extra: ', value: '(none)' },
    { key: 'blank: ', value: '(empty)' },
  ]);

  const noExtras = { event: 'session_start', ts: 1700000000 };
  const fixture2 = baseSnapshot({ events: { events: [noExtras], skippedLines: 0 } });
  const sbx2 = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture2 }) });
  await flushMicrotasks();
  const [row2] = sbx2.el['gate-events-list'].children.map(readGateEventRow);
  assert.equal(row2.fields, null, 'no fields block is appended at all when the event has nothing beyond ts/event');
  assert.equal(sbx2.el['gate-events-list'].children[0].children.length, 1, 'only the head -- no second (fields) child');
});

test('client: a bare (non-object) event value -- the real shape found in this repo\'s own events.jsonl -- degrades to a plain "other" badge with no crash and no extra-fields block', async () => {
  const fixture = baseSnapshot({ events: { events: ['just a raw orphaned string fragment, not an event object'], skippedLines: 0 } });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [row] = sbx.el['gate-events-list'].children.map(readGateEventRow);
  assert.equal(row.badgeText, '(unlabeled event)');
  assert.equal(row.badgeClass, 'gate-badge gate-badge--other');
  assert.equal(row.fields, null, 'a string has no enumerable own keys to render, and must never have its characters iterated as fake object keys');
});

// --- (3) Cycle history -----------------------------------------------------

test('client: cycle-history empty state when there is no history', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => baseSnapshot() }) });
  await flushMicrotasks();
  assert.equal(sbx.el['cycle-history-empty'].hidden, false);
  assert.equal(sbx.el['cycle-history-list'].hidden, true);
  assert.equal(sbx.el['cycle-history-list'].children.length, 0);
});

test('client: cycle-history renders one card per row in the SOURCE document\'s own top-to-bottom order -- never reversed, never resorted (unlike gate-events)', async () => {
  const rows = [cycleRowFixture({ cycle: 'C1' }), cycleRowFixture({ cycle: 'C2' }), cycleRowFixture({ cycle: 'C3' })];
  const fixture = baseSnapshot({ cycleHistory: rows });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const cards = sbx.el['cycle-history-list'].children.map(readCycleCard);
  assert.deepEqual(cards.map((c) => c.idText), ['C1', 'C2', 'C3']);
});

test('client: cycle-history renders every column under its own human label, with real values verbatim', async () => {
  const row = cycleRowFixture({
    cycle: 'phase0-006-t8-dashboard', date: '2026-09-15', backlogItem: 'T8: extend the dashboard',
    outcome: 'Ready for PR', deployBillingGateHit: 'Not triggered', claimValidatorResult: '104/130',
    changeFailure: 'No', environmentFaults: '3: api 2, environment 1; resume time unrecorded', notes: 'A long-form paragraph of notes, exactly as the real stability-dashboard.md carries.',
  });
  const fixture = baseSnapshot({ cycleHistory: [row] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [card] = sbx.el['cycle-history-list'].children.map(readCycleCard);
  assert.equal(card.idText, 'phase0-006-t8-dashboard');
  assert.equal(card.dateText, '2026-09-15');
  assert.equal(card.backlogLabel, 'Backlog item');
  assert.equal(card.backlogText, 'T8: extend the dashboard');
  assert.equal(card.outcomeLabel, 'Outcome');
  assert.equal(card.outcomeText, 'Ready for PR');
  assert.equal(card.gateLabel, 'Deploy/billing gate hit?');
  assert.equal(card.gateText, 'Not triggered');
  assert.equal(card.claimLabel, 'Claim-validator result');
  assert.equal(card.claimText, '104/130');
  assert.equal(card.failureLabel, 'Change-failure?');
  assert.equal(card.failureText, 'No');
  assert.equal(card.environmentLabel, 'Environment faults');
  assert.equal(card.environmentText, row.environmentFaults);
  assert.equal(card.notesLabel, 'Notes');
  assert.equal(card.notesText, row.notes);
  assert.ok(card.notesValueClass.includes('cycle-field-notes'));
});

test('client: cycle-history states "not recoverable" (with cycle/date\'s own distinct wording) for every blank cell -- never an empty line, and never confused with recent-runs\' own placeholder text', async () => {
  const blankRow = cycleRowFixture({ cycle: '', date: '', backlogItem: '', outcome: '', deployBillingGateHit: '', claimValidatorResult: '', changeFailure: '', environmentFaults: '', notes: '' });
  const fixture = baseSnapshot({ cycleHistory: [blankRow] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [card] = sbx.el['cycle-history-list'].children.map(readCycleCard);
  assert.equal(card.idText, '(cycle id not recoverable)', 'the cycle-id placeholder has its own distinct wording');
  assert.equal(card.dateText, 'date not recoverable', 'the date placeholder has its own distinct wording');
  assert.equal(card.backlogText, 'not recoverable');
  assert.equal(card.outcomeText, 'not recoverable');
  assert.equal(card.gateText, 'not recoverable');
  assert.equal(card.claimText, 'not recoverable');
  assert.equal(card.failureText, 'not recoverable');
  assert.equal(card.environmentText, 'not recoverable');
  assert.equal(card.notesText, 'not recoverable', "even the Notes field, its own long-form styling notwithstanding, never renders blank");
});

test('client: cycle-history preserves a very long Notes value verbatim (real stability-dashboard.md rows run past 3000 characters) -- never truncated', async () => {
  const longNotes = 'N'.repeat(3288) + ' -- end of a realistically long notes paragraph.';
  const fixture = baseSnapshot({ cycleHistory: [cycleRowFixture({ notes: longNotes })] });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const [card] = sbx.el['cycle-history-list'].children.map(readCycleCard);
  assert.equal(card.notesText, longNotes);
  assert.equal(card.notesText.length, longNotes.length);
});

// --- Cross-cutting ---------------------------------------------------------

test('client: a realistic combined render (multiple recent runs, every gate-event category, and cycle-history rows) never creates a button/link/form/input at runtime', async () => {
  const fixture = baseSnapshot({
    runs: [recentRunFixture({ active: true }), recentRunFixture({ validatorOutcome: { signed_off: false, reason: 'x' } })],
    events: { events: [gateEventFixture({ event: 'deploy_gate_block' }), gateEventFixture({ event: 'unknown_thing' }), { note: 'no type' }], skippedLines: 2 },
    cycleHistory: [cycleRowFixture(), cycleRowFixture({ notes: '' })],
  });
  const sbx = await buildSandbox({ fetchImpl: () => Promise.resolve({ ok: true, json: async () => fixture }) });
  await flushMicrotasks();
  const forbidden = sbx.createdTags.map((t) => t.toLowerCase()).filter((t) => ['button', 'a', 'form', 'input', 'select', 'textarea'].includes(t));
  assert.deepEqual(forbidden, []);
  assert.ok(sbx.el['recent-runs-list'].children.length > 0);
  assert.ok(sbx.el['gate-events-list'].children.length > 0);
  assert.ok(sbx.el['cycle-history-list'].children.length > 0);
});

test('client: recent-runs / gate-events / cycle-history all clear and rebuild (never accumulate duplicates) on every subsequent snapshot event', async () => {
  const sbx = await buildSandbox({ fetchImpl: () => new Promise(() => {}) });
  const es = sbx.es()[0];
  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ runs: [recentRunFixture()], events: { events: [gateEventFixture()], skippedLines: 0 }, cycleHistory: [cycleRowFixture()] })) });
  await flushMicrotasks();
  assert.equal(sbx.el['recent-runs-list'].children.length, 1);
  assert.equal(sbx.el['gate-events-list'].children.length, 1);
  assert.equal(sbx.el['cycle-history-list'].children.length, 1);

  es._emit('snapshot', { data: JSON.stringify(baseSnapshot({ runs: [recentRunFixture(), recentRunFixture()], events: { events: [gateEventFixture(), gateEventFixture()], skippedLines: 0 }, cycleHistory: [] })) });
  await flushMicrotasks();
  assert.equal(sbx.el['recent-runs-list'].children.length, 2, 'rebuilt, not appended to the previous 1');
  assert.equal(sbx.el['gate-events-list'].children.length, 2);
  assert.equal(sbx.el['cycle-history-list'].children.length, 0, 'cycleHistory going back to empty must show the empty state again, not stale leftover cards');
  assert.equal(sbx.el['cycle-history-empty'].hidden, false);
});

// =============================================================================
// PART 3 -- integration (real server.mjs process)
// =============================================================================

test('integration: GET / serves this exact file, byte-for-byte, as text/html', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.body, rawHtml, 'served bytes must equal the file on disk -- no server-side templating/mutation');
});

test('integration: the <script> block PART 2 sandboxed is the exact text actually served over HTTP', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/');
  const startIdx = res.body.indexOf('<script>') + '<script>'.length;
  const endIdx = res.body.indexOf('</script>', startIdx);
  const servedScript = res.body.slice(startIdx, endIdx);
  assert.equal(servedScript, scriptText, 'PART 2 must have exercised the same code this server actually serves');
});

test('integration: GET /api/snapshot has the exact key/type shape index.html reads, against a real spawned run', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  const snap = JSON.parse(res.body);
  assert.deepEqual(Object.keys(snap).sort(), ['approvals', 'cycleHistory', 'events', 'halt', 'phase', 'runs']);
  assert.ok(Array.isArray(snap.runs) && snap.runs.length === 1);
  assert.equal(snap.runs[0].active, true, 'the fixture run has a started-but-not-finished label -- must read as active');
  assert.ok(Array.isArray(snap.runs[0].nodes) && snap.runs[0].nodes.length > 0);
  for (const node of snap.runs[0].nodes) {
    assert.ok(['queued', 'running', 'done', 'errored'].includes(node.status), `unexpected node status from the real server: ${node.status}`);
  }
  assert.equal(typeof snap.events.skippedLines, 'number');
  assert.equal(snap.events.skippedLines, 1, 'fixture events.jsonl has exactly one malformed line');
  assert.equal(typeof snap.halt.halted, 'boolean');
  assert.equal(snap.halt.halted, false, 'fixture deliberately has no graph-halt file');
  assert.ok(Array.isArray(snap.approvals) && snap.approvals.length === 1);
});

test('integration: GET /events streams a "snapshot" SSE frame the client can JSON.parse', async () => {
  const frame = await readFirstSseFrame(INTEGRATION_PORT);
  assert.equal(frame.event, 'snapshot');
  assert.ok(frame.data, 'frame carried no data: line');
  const parsed = JSON.parse(frame.data); // must not throw -- proves the client's JSON.parse(ev.data) path is fed valid JSON
  assert.deepEqual(Object.keys(parsed).sort(), ['approvals', 'cycleHistory', 'events', 'halt', 'phase', 'runs']);
});
