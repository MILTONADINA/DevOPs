// Tests for T5 (snapshot assembly + GET /api/snapshot in
// scripts/graph-dashboard/server.mjs).
//
// Same reasoning as tests/graph-dashboard/reader.test.mjs (T2),
// events-reader.test.mjs (T3), and state-readers.test.mjs (T4): server.mjs
// cannot be `import`-ed directly in a test process -- it has no exports, and
// unconditionally binds a real TCP port (process.exit(1) on EADDRINUSE) as a
// module-load side effect. This file combines BOTH strategies already
// established by those three files, because T5 itself has two genuinely
// different things to verify:
//
//   PART 1 (unit-style, marker-extracted): assembleSnapshot()/serveSnapshot()
//   pulled VERBATIM out of the real source into a fixture-backed importable
//   module, exactly like T2/T3/T4's own test files do for their readers --
//   proves the assembly logic itself (exact key set, unreshaped passthrough
//   of each of T2/T3/T4's six readers) in isolation, fast and deterministic.
//
//   PART 3 (integration, real process): T5's actual job was to wire a real
//   HTTP route, and no marker-extraction can prove real route dispatch,
//   real header/status codes, or real JSON.stringify-over-the-wire behavior
//   -- extraction has always deliberately excluded requestHandler/the routes
//   Map/http bootstrap (see every prior file's own exclude-list). So this
//   part spawns the REAL `node server.mjs` (env-var-pointed at fixture
//   STATE_DIR/JOURNAL_ROOT, exactly as documented in server.mjs's own header
//   comment) and makes real HTTP requests against it.
//
// A single top-level before()/after() pair does ALL setup for both parts
// (unit fixtures + extraction, AND integration fixtures + server spawn) --
// deliberately NOT split into multiple top-level before() calls. See
// reader.test.mjs's own before() comment: this Node version does not
// reliably run multiple top-level before() hooks with the sequential/
// mutually-visible semantics a later one would need to see state set by an
// earlier one (confirmed empirically there). One hook, sequential steps.
//
// Run with: node --test tests/graph-dashboard/snapshot.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');

// A required, exact set -- this task's own spec text: "The object must
// contain at least the keys runs, events, halt, approvals, and phase (this
// exact key set is what verification asserts on), plus whatever else the UI
// needs (T3's skipped-event count, T4d's cycle-history rows)." So the
// verified set is these five PLUS cycleHistory -- never fewer, and (per
// "one shared assembly function", no other ad hoc top-level key) never more.
const REQUIRED_SNAPSHOT_KEYS = ['approvals', 'cycleHistory', 'events', 'halt', 'phase', 'runs'];

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

let reader; // the extracted PART-1 module (assembleSnapshot/serveSnapshot/readers)
let fixtureRoot;

// PART 3 (integration) state.
const INTEGRATION_PORT = 41000 + (process.pid % 4000);
let integrationProcess;
let integrationStderr = '';
let integrationJournalRoot;
let integrationStateDir;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-snapshot-fixtures-'));

  // ---------------------------------------------------------------------
  // PART 1 setup: marker-extract T2+T3+T4's readers AND T5's own
  // assembleSnapshot/serveSnapshot/serveIndexHtml into one importable
  // module -- everything between T2's own section-start marker (reused
  // verbatim from reader.test.mjs) and the routes-Map comment that starts
  // right after serveSnapshot's closing brace, i.e. every function
  // assembleSnapshot() can reach plus assembleSnapshot/serveSnapshot
  // themselves, stopping short of the routes Map / requestHandler / http
  // bootstrap (excluded here exactly like every prior file excludes it --
  // PART 3 below exercises that real dispatch instead).
  // ---------------------------------------------------------------------
  const src = await readFile(SERVER_MJS, 'utf-8');
  const startNeedle = '// Run model reader (T2)';
  const endNeedle = '// Exact-path GET routes. T2+ add more entries here';
  const startIdx = src.indexOf(startNeedle);
  const endIdx = src.indexOf(endNeedle);
  assert.notEqual(startIdx, -1, 'could not find T2 reader-section start marker in server.mjs -- has the comment been reworded/removed?');
  assert.notEqual(endIdx, -1, 'could not find the routes-Map marker in server.mjs -- has that comment been reworded/removed?');
  assert.ok(startIdx < endIdx, 'markers found out of order');

  const sectionStart = src.lastIndexOf('\n', startIdx) + 1;
  const section = src.slice(sectionStart, endIdx);

  // Self-diagnosing: fail loudly (not silently test nothing) if an expected
  // symbol isn't in the slice, and equally fail loudly if it accidentally
  // pulled in the routes Map / request dispatcher / HTTP bootstrap instead
  // of (or in addition to) the pure library code.
  for (const expected of [
    'async function readGraphRuns(',
    'async function readEventsLog(',
    'async function readKillSwitch(',
    'async function readPendingApprovals(',
    'async function readAutonomyPhase(',
    'async function readCycleHistory(',
    'async function assembleSnapshot(',
    'async function serveSnapshot(',
    'async function serveIndexHtml(',
  ]) {
    assert.ok(section.includes(expected), `extracted section is missing expected declaration: ${expected}`);
  }
  for (const unexpected of ['http.createServer', 'server.listen', 'async function requestHandler(', 'const routes = new Map(']) {
    assert.ok(!section.includes(unexpected), `extracted section unexpectedly includes routing/bootstrap code: ${unexpected}`);
  }

  // Unit fixtures: one run, a couple of events (one malformed), a present
  // halt marker, two approval markers, a governance config with a
  // top-level `phase:` plus deliberately-similar decoys, and a two-row
  // cycle-history table -- enough for every one of assembleSnapshot()'s six
  // inputs to carry real, independently-known data in this same call.
  const journalRoot = path.join(fixtureRoot, 'unit', 'journal-root');
  const runDir = path.join(journalRoot, 'sess1', 'subagents', 'workflows', 'wfA');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'journal.jsonl'),
    [
      '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}',
      '{"type":"result","key":"k1","agentId":"a1","result":{"tasks":[]}}',
    ].join('\n') + '\n'
  );

  const stateDir = path.join(fixtureRoot, 'unit', 'state-dir');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'events.jsonl'), ['{"type":"evt-a"}', 'garbage-not-json', '{"type":"evt-b"}'].join('\n') + '\n');
  await writeFile(path.join(stateDir, 'graph-halt'), '{"haltedBy":"unit-test"}');
  const approvalsDir = path.join(stateDir, 'graph-approvals');
  await mkdir(approvalsDir, { recursive: true });
  await writeFile(path.join(approvalsDir, 'cyc9.deploy'), '');
  await writeFile(path.join(approvalsDir, 'cyc1.billing-2'), '');

  const gitTopLevel = path.join(fixtureRoot, 'unit', 'git-top-level');
  await mkdir(path.join(gitTopLevel, 'governance', 'graph'), { recursive: true });
  await writeFile(
    path.join(gitTopLevel, 'governance', 'graph', 'autonomy-config.yml'),
    [
      'meta:',
      '  note: decoy',
      'gates:',
      '  merge_to_main:',
      '    phase_0:',
      '      require_human: true',
      '    phase_1:',
      '      require_human: false',
      'phase: 2  # unit-test fixture value -- must win over the indented/differently-named decoys above/below',
      'loosens_in_phase_2:',
      '  something: true',
      '',
    ].join('\n')
  );
  await writeFile(
    path.join(gitTopLevel, 'governance', 'graph', 'stability-dashboard.md'),
    [
      '# Stability Dashboard (fixture)',
      '',
      'Some prose before the table.',
      '',
      '| Cycle | Date | Backlog item | Outcome | Deploy/billing gate hit? | Claim-validator result | Change-failure? | Notes |',
      '|---|---|---|---|---|---|---|---|',
      '| cyc-unit-1 | 2026-01-01 | unit fixture item one | pass | no | pass | no | first row |',
      '| cyc-unit-2 | 2026-01-02 | unit fixture item two | pass | yes | pass | no | second row |',
      '',
      'Some trailing prose after the table.',
      '',
    ].join('\n')
  );

  const indexHtmlDir = path.join(fixtureRoot, 'unit', 'index-html-dir');
  await mkdir(indexHtmlDir, { recursive: true });
  const indexHtmlPath = path.join(indexHtmlDir, 'index.html');
  await writeFile(indexHtmlPath, '<!doctype html><title>fixture index</title>\n');

  const header = [
    "import { readFile, readdir, stat } from 'node:fs/promises';",
    "import * as path from 'node:path';",
    '',
    `const STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const JOURNAL_ROOT = ${JSON.stringify(journalRoot)};`,
    `const GIT_TOP_LEVEL = ${JSON.stringify(gitTopLevel)};`,
    `const INDEX_HTML_PATH = ${JSON.stringify(indexHtmlPath)};`,
    '',
    '',
  ].join('\n');
  const footer =
    '\n\nexport { assembleSnapshot, serveSnapshot, serveIndexHtml, readGraphRuns, readEventsLog, readKillSwitch, readPendingApprovals, readAutonomyPhase, readCycleHistory };\n';

  const extractedModulePath = path.join(fixtureRoot, 'snapshot-under-test.mjs');
  await writeFile(extractedModulePath, header + section + footer);
  reader = await import('file://' + extractedModulePath);

  // ---------------------------------------------------------------------
  // PART 3 setup: spawn the REAL server.mjs against its own, separate
  // fixture tree (deliberately different counts from PART 1's fixtures
  // above, and deliberately leaves graph-halt ABSENT this time -- so
  // between the two parts, both the present and absent halt-file branches
  // get exercised against real data). GIT_TOP_LEVEL itself has no env-var
  // override in server.mjs (see its own header comment -- only PORT,
  // STATE_DIR, and JOURNAL_ROOT are), so phase/cycleHistory here will
  // reflect this actual checkout's real governance docs, not a fixture --
  // the integration tests below assert their SHAPE, not fixed values,
  // for exactly those two keys; PART 1 above already pins exact values
  // for every key against fixture data it fully controls.
  // ---------------------------------------------------------------------
  integrationJournalRoot = path.join(fixtureRoot, 'integration', 'journal-root');
  const runDirA = path.join(integrationJournalRoot, 'sessA', 'subagents', 'workflows', 'wfA');
  const runDirB = path.join(integrationJournalRoot, 'sessB', 'subagents', 'workflows', 'wfB');
  await mkdir(runDirA, { recursive: true });
  await mkdir(runDirB, { recursive: true });
  await writeFile(
    path.join(runDirA, 'journal.jsonl'),
    '{"type":"started","key":"kA","agentId":"agentA","label":"planner","phase":"Plan"}\n{"type":"result","key":"kA","agentId":"agentA","result":{"tasks":[]}}\n'
  );
  await writeFile(
    path.join(runDirB, 'journal.jsonl'),
    '{"type":"started","key":"kB","agentId":"agentB","label":"planner","phase":"Plan"}\n{"type":"result","key":"kB","agentId":"agentB","result":{"tasks":[]}}\n'
  );

  integrationStateDir = path.join(fixtureRoot, 'integration', 'state-dir');
  await mkdir(integrationStateDir, { recursive: true });
  await writeFile(
    path.join(integrationStateDir, 'events.jsonl'),
    ['{"type":"int-evt-1"}', '{"type":"int-evt-2"}', '{"type":"int-evt-3"}', 'bad-1', 'bad-2'].join('\n') + '\n'
  );
  // graph-halt deliberately NOT created -- covers the absent/not-halted branch.
  const integrationApprovalsDir = path.join(integrationStateDir, 'graph-approvals');
  await mkdir(integrationApprovalsDir, { recursive: true });
  await writeFile(path.join(integrationApprovalsDir, 'only.deploy'), '');

  integrationProcess = spawn(
    process.execPath,
    [SERVER_MJS],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GRAPH_DASHBOARD_PORT: String(INTEGRATION_PORT),
        GRAPH_DASHBOARD_STATE_DIR: integrationStateDir,
        GRAPH_DASHBOARD_JOURNAL_ROOT: integrationJournalRoot,
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
  if (integrationProcess && integrationProcess.exitCode === null && integrationProcess.signalCode === null) {
    integrationProcess.kill('SIGTERM');
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// PART 1 -- assembleSnapshot()/serveSnapshot(), marker-extracted, against
// fully fixture-controlled data. Every assertion below either pins a
// concrete, hand-known expected value (so a broken reader/broken assembly
// would actually fail it, not just agree with itself) or cross-checks
// against that SAME reader called directly (proving assembleSnapshot does
// no reshaping of its own).
// =============================================================================

test('assembleSnapshot() top-level key set is exactly {runs, events, halt, approvals, phase, cycleHistory} -- this exact set is what verification asserts on', async () => {
  const snap = await reader.assembleSnapshot();
  assert.deepStrictEqual(Object.keys(snap).sort(), REQUIRED_SNAPSHOT_KEYS);
});

test('assembleSnapshot() passes through each of T2/T3/T4\'s six readers\' OWN return value unreshaped -- no filtering/renaming/re-nesting of its own', async () => {
  const snap = await reader.assembleSnapshot();
  assert.deepStrictEqual(snap.runs, await reader.readGraphRuns(), 'runs must equal a direct readGraphRuns() call');
  assert.deepStrictEqual(snap.events, await reader.readEventsLog(), 'events must equal a direct readEventsLog() call');
  assert.deepStrictEqual(snap.halt, await reader.readKillSwitch(), 'halt must equal a direct readKillSwitch() call');
  assert.deepStrictEqual(snap.approvals, await reader.readPendingApprovals(), 'approvals must equal a direct readPendingApprovals() call');
  assert.strictEqual(snap.phase, await reader.readAutonomyPhase(), 'phase must equal a direct readAutonomyPhase() call');
  assert.deepStrictEqual(snap.cycleHistory, await reader.readCycleHistory(), 'cycleHistory must equal a direct readCycleHistory() call');
});

test('assembleSnapshot(): runs reflects the fixture journal root (1 run, sess1/wfA)', async () => {
  const snap = await reader.assembleSnapshot();
  assert.strictEqual(snap.runs.length, 1);
  assert.strictEqual(snap.runs[0].sessionId, 'sess1');
  assert.strictEqual(snap.runs[0].workflowId, 'wfA');
});

test('assembleSnapshot(): events carries T3\'s skipped-line count at events.skippedLines, not a separate top-level key -- 2 parsed, 1 skipped', async () => {
  const snap = await reader.assembleSnapshot();
  assert.strictEqual(snap.events.events.length, 2);
  assert.strictEqual(snap.events.skippedLines, 1);
  assert.deepStrictEqual(snap.events.events, [{ 'type': 'evt-a' }, { 'type': 'evt-b' }]);
});

test('assembleSnapshot(): halt reflects the present fixture graph-halt file verbatim', async () => {
  const snap = await reader.assembleSnapshot();
  assert.deepStrictEqual(snap.halt, { halted: true, raw: '{"haltedBy":"unit-test"}' });
});

test('assembleSnapshot(): approvals lists both fixture marker filenames, sorted', async () => {
  const snap = await reader.assembleSnapshot();
  assert.deepStrictEqual(snap.approvals, ['cyc1.billing-2', 'cyc9.deploy']);
});

test('assembleSnapshot(): phase is the bare top-level integer (2) from the fixture config, not the decoy nested/differently-named keys', async () => {
  const snap = await reader.assembleSnapshot();
  assert.strictEqual(snap.phase, 2);
});

test('assembleSnapshot(): cycleHistory carries T4d\'s cycle-history rows -- the documented "plus whatever else the UI needs" addition', async () => {
  const snap = await reader.assembleSnapshot();
  assert.deepStrictEqual(snap.cycleHistory, [
    { cycle: 'cyc-unit-1', date: '2026-01-01', backlogItem: 'unit fixture item one', outcome: 'pass', deployBillingGateHit: 'no', claimValidatorResult: 'pass', changeFailure: 'no', notes: 'first row' },
    { cycle: 'cyc-unit-2', date: '2026-01-02', backlogItem: 'unit fixture item two', outcome: 'pass', deployBillingGateHit: 'yes', claimValidatorResult: 'pass', changeFailure: 'no', notes: 'second row' },
  ]);
});

test('serveSnapshot() writes a 200 application/json response whose parsed body deepStrictEquals assembleSnapshot()\'s own result', async () => {
  const chunks = [];
  let statusCode, headers;
  const res = {
    writeHead(code, hdrs) { statusCode = code; headers = hdrs; },
    end(body) { chunks.push(body); },
  };
  await reader.serveSnapshot({}, res);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(headers['Content-Type'], 'application/json; charset=utf-8');
  const parsed = JSON.parse(chunks.join(''));
  const expected = await reader.assembleSnapshot();
  assert.deepStrictEqual(parsed, expected, 'serveSnapshot must be a thin wrapper -- its wire body must exactly equal assembleSnapshot()\'s own result');
});

test('serveIndexHtml() still serves the real index.html contents unrelated to the snapshot work (T5 did not touch this handler)', async () => {
  const chunks = [];
  let statusCode, headers;
  const res = {
    writeHead(code, hdrs) { statusCode = code; headers = hdrs; },
    end(body) { chunks.push(body); },
  };
  await reader.serveIndexHtml({}, res);
  assert.strictEqual(statusCode, 200);
  assert.match(headers['Content-Type'], /text\/html/);
  assert.strictEqual(Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf-8'), '<!doctype html><title>fixture index</title>\n');
});

// =============================================================================
// PART 2 -- static/structural checks proving T5's OWN specific contract:
// assembleSnapshot is one shared, HTTP-agnostic function that serveSnapshot
// (and, per this task's spec, T6's future SSE endpoint) calls rather than
// duplicates. These read the real, full server.mjs source directly (not the
// extracted slice), same convention as every prior file's own "PART 3".
// =============================================================================

test('static: assembleSnapshot is defined exactly once in server.mjs (single shared function, not duplicated per caller)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const defs = src.match(/async function assembleSnapshot\(/g) || [];
  assert.strictEqual(defs.length, 1, `expected exactly one assembleSnapshot definition, found ${defs.length}`);
});

test('static: serveSnapshot()\'s body calls assembleSnapshot() and does not itself call any of the six readers directly (no duplicated composition logic)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('async function serveSnapshot(');
  assert.notEqual(start, -1, 'could not find serveSnapshot() in server.mjs');
  const end = src.indexOf('\n}', start) + 2;
  const body = src.slice(start, end);
  assert.ok(body.includes('assembleSnapshot()'), 'serveSnapshot() must call assembleSnapshot()');
  for (const reader_ of ['readGraphRuns(', 'readEventsLog(', 'readKillSwitch(', 'readPendingApprovals(', 'readAutonomyPhase(', 'readCycleHistory(']) {
    assert.ok(!body.includes(reader_), `serveSnapshot() must not call ${reader_} directly -- it must go through assembleSnapshot() only, so T6 can reuse the same single function`);
  }
});

test('static: assembleSnapshot()\'s body is HTTP-agnostic -- no res./req./writeHead/.end( reference -- so it is safe for a non-HTTP caller (T6\'s SSE endpoint) to reuse', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('async function assembleSnapshot(');
  assert.notEqual(start, -1, 'could not find assembleSnapshot() in server.mjs');
  const end = src.indexOf('\n}', start) + 2;
  const body = src.slice(start, end);
  for (const httpish of ['res.', 'req.', 'writeHead', '.end(']) {
    assert.ok(!body.includes(httpish), `assembleSnapshot() body unexpectedly references HTTP-response code: ${httpish}`);
  }
});

test('static: assembleSnapshot() calls all six of T2/T3/T4\'s readers with no arguments (their own defaults), each exactly once', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('async function assembleSnapshot(');
  const end = src.indexOf('\n}', start) + 2;
  const body = src.slice(start, end);
  for (const call of ['readGraphRuns(),', 'readEventsLog(),', 'readKillSwitch(),', 'readPendingApprovals(),', 'readAutonomyPhase(),', 'readCycleHistory(),']) {
    const occurrences = body.split(call).length - 1;
    assert.strictEqual(occurrences, 1, `expected exactly one no-argument call shaped "${call}" inside assembleSnapshot(), found ${occurrences}`);
  }
});

test('static: assembleSnapshot()\'s own return literal has exactly the six required keys, in no other shape', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('async function assembleSnapshot(');
  const end = src.indexOf('\n}', start) + 2;
  const body = src.slice(start, end);
  const match = body.match(/return\s*\{([^}]*)\}\s*;/);
  assert.ok(match, 'could not find a `return { ... };` literal inside assembleSnapshot()');
  const keys = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepStrictEqual(keys.sort(), REQUIRED_SNAPSHOT_KEYS);
});

test('static: the "Route handlers" section (T5\'s own new code) never shells out -- no execFileSync/exec/spawn call', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const start = src.indexOf('// Route handlers (GET-only, read-only -- see the header note above)');
  assert.notEqual(start, -1, 'could not find the Route handlers section marker');
  const section = src.slice(start);
  const codeOnly = section.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/\b(?:execFileSync|execSync|spawn(?:Sync)?|exec)\s*\(/.test(codeOnly), 'the Route handlers section must not shell out to a subprocess');
});

test('static: routes Map contains exactly the three known GET routes (\'/\', \'/api/snapshot\', and T6\'s \'/events\') and no mutating method anywhere in the file', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  assert.ok(!/\.method\s*===\s*['"](?:POST|PUT|DELETE|PATCH)['"]/.test(src), 'server.mjs must never branch on a mutating HTTP method');
  const routesBlockMatch = src.match(/const routes = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(routesBlockMatch, 'could not find the routes Map literal');
  assert.strictEqual(routesBlockMatch[1].trim(), "['/', serveIndexHtml],\n  ['/api/snapshot', serveSnapshot],\n  ['/events', serveEvents],", 'routes Map must contain exactly these three GET entries');
});

test('static: scripts/graph-dashboard/ still contains only server.mjs + index.html + T9\'s README.md (T1 single-file constraint) -- T5 added no new source files', async () => {
  // T1's real, documented constraint (see server.mjs's own header comment)
  // is scoped to ".mjs/.js module" -- not "no other file of any kind" --
  // so T9's legitimately-tasked README.md (documentation, not server-side
  // logic) is an expected, sanctioned addition here, not a regression.
  // Updated by T9's own tester, mirroring this same PART 3 block's own
  // "update this literal again if a later task adds another legitimate
  // one" precedent (see the routes-Map test just below).
  const entries = await readdir(path.join(REPO_ROOT, 'scripts', 'graph-dashboard'));
  assert.deepStrictEqual([...entries].sort(), ['README.md', 'index.html', 'server.mjs']);
});

// =============================================================================
// PART 3 -- integration: the REAL server.mjs process, spawned against a
// fixture STATE_DIR/JOURNAL_ROOT via the documented env vars, hit with real
// HTTP requests. Proves the actual shipped route dispatch, status codes,
// headers, and wire JSON -- none of which PART 1's extraction can see, since
// every extraction in this test suite deliberately excludes requestHandler/
// the routes Map/the http bootstrap.
// =============================================================================

test('integration: GET /api/snapshot -- 200, application/json, exact required key set over the wire (JSON.stringify cannot silently drop a key here)', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot');
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(Object.keys(body).sort(), REQUIRED_SNAPSHOT_KEYS);
});

test('integration: GET /api/snapshot -- runs/events/approvals reflect the integration fixture exactly (2 runs; 3 events + 2 skipped; 1 approval)', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot');
  const body = JSON.parse(res.body);
  assert.strictEqual(body.runs.length, 2);
  assert.deepStrictEqual(body.runs.map((r) => r.sessionId).sort(), ['sessA', 'sessB']);
  assert.strictEqual(body.events.events.length, 3);
  assert.strictEqual(body.events.skippedLines, 2);
  assert.deepStrictEqual(body.approvals, ['only.deploy']);
});

test('integration: GET /api/snapshot -- halt reflects the ABSENT fixture graph-halt file (not-halted branch, complementing PART 1\'s present-file case)', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot');
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.halt, { halted: false, raw: null });
});

test('integration: GET /api/snapshot -- phase and cycleHistory (real, uncontrolled governance docs) are at least well-shaped', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot');
  const body = JSON.parse(res.body);
  assert.ok(body.phase === null || (typeof body.phase === 'number' && Number.isInteger(body.phase)), 'phase must be an integer or null');
  assert.ok(Array.isArray(body.cycleHistory), 'cycleHistory must be an array');
  for (const row of body.cycleHistory) {
    assert.deepStrictEqual(Object.keys(row).sort(), ['backlogItem', 'changeFailure', 'claimValidatorResult', 'cycle', 'date', 'deployBillingGateHit', 'notes', 'outcome']);
  }
});

test('integration: GET / (pre-existing route) still serves 200 text/html -- T5 did not disturb it', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/');
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
});

test('integration: GET /nonexistent -- still 404', async () => {
  const res = await httpRequest(INTEGRATION_PORT, '/nonexistent');
  assert.strictEqual(res.statusCode, 404);
});

test('integration: POST/PUT/DELETE /api/snapshot -- all 404 (route is GET-only; T1\'s read-only-forever constraint holds for the new route too)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await httpRequest(INTEGRATION_PORT, '/api/snapshot', method);
    assert.strictEqual(res.statusCode, 404, `${method} /api/snapshot should be 404`);
  }
});
