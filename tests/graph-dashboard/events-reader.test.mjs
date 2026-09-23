// Tests for T3 (events.jsonl reader in scripts/graph-dashboard/server.mjs).
//
// Same reasoning as tests/graph-dashboard/reader.test.mjs (T2's suite):
// server.mjs cannot be `import`-ed directly in a test process -- it has no
// exports, and unconditionally binds a real TCP port (process.exit(1) on
// EADDRINUSE) as a module-load side effect. So this file extracts the T3
// reader section VERBATIM out of the real source (marker-based, not
// hardcoded line numbers, so it stays correct as later tasks add code
// around it) into a throwaway importable module, and tests that actual
// shipped source text -- never a reimplementation.
//
// Run with: node --test tests/graph-dashboard/events-reader.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');
const REAL_EVENTS_PATH = path.join(REPO_ROOT, '.workflow', 'state', 'events.jsonl');

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Extract the T3 reader section VERBATIM out of the real server.mjs source
// (marker-based) and load it as an importable module, exactly as
// reader.test.mjs does for T2. STATE_DIR is not part of the extracted
// section (it lives in server.mjs's own config-resolution code, which shells
// out to git and is out of scope here) -- readEventsLog only references it
// lazily, inside a default parameter, so it is safe to supply a local
// fixture-backed const of the same name here purely to exercise that default
// parameter path under test control (see the "default eventsPath" test).
// ---------------------------------------------------------------------------
let reader;
let fixtureRoot;
let fixtureStateDir;
// .workflow/state/events.jsonl is gitignored (per-machine/session runtime
// state -- confirmed via `git check-ignore -v .workflow/state/events.jsonl`,
// which matches BOTH the blanket `.workflow/state/*` rule and its own
// redundant explicit entry), so it will not exist on a fresh clone or in CI.
// Every PART 1 test below that touches its bytes directly (not through
// reader.readEventsLog(), which already handles ENOENT gracefully on its
// own) must self-skip when absent, matching reader.test.mjs's own
// hasRealData convention for the same reason.
let hasRealEventsFile = false;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-events-fixtures-'));
  fixtureStateDir = path.join(fixtureRoot, 'default-state-dir');
  await mkdir(fixtureStateDir, { recursive: true });

  try {
    await stat(REAL_EVENTS_PATH);
    hasRealEventsFile = true;
  } catch {
    hasRealEventsFile = false;
  }

  const src = await readFile(SERVER_MJS, 'utf-8');
  const startNeedle = '// Events log reader (T3)';
  const endNeedle = '// Route handlers (GET-only, read-only -- see the header note above)';
  const startIdx = src.indexOf(startNeedle);
  const endIdx = src.indexOf(endNeedle);
  assert.notEqual(startIdx, -1, 'could not find T3 reader-section start marker in server.mjs -- has the comment been reworded/removed?');
  assert.notEqual(endIdx, -1, 'could not find route-handlers marker in server.mjs -- has that section been reworded/removed?');
  assert.ok(startIdx < endIdx, 'markers found out of order');

  const sectionStart = src.lastIndexOf('\n', startIdx) + 1;
  const sepMarker = '// ---------------------------------------------------------------------------';
  const sectionEnd = src.lastIndexOf(sepMarker, endIdx);
  assert.ok(sectionEnd > sectionStart, 'could not locate the separator line closing the reader section');

  const section = src.slice(sectionStart, sectionEnd);

  // Self-diagnosing: fail loudly (not silently test nothing) if the expected
  // symbol isn't in the slice -- e.g. because it was renamed/refactored --
  // and equally fail loudly if it accidentally pulled in T2's reader or the
  // HTTP bootstrap instead of/in addition to T3's own function.
  assert.ok(section.includes('async function readEventsLog('), 'extracted section is missing expected declaration: async function readEventsLog(');
  for (const unexpected of ['http.createServer', 'server.listen', 'requestHandler', 'async function readGraphRuns(', 'async function buildRunModel(']) {
    assert.ok(!section.includes(unexpected), `extracted section unexpectedly includes unrelated code: ${unexpected}`);
  }

  // Structural guard on the task's hard "never write anything back to this
  // file" constraint: assert the actual shipped section text contains no
  // write-capable fs call at all, rather than only checking that it behaves
  // read-only in the specific cases this file happens to exercise below.
  for (const writer of ['writeFile', 'appendFile', 'fs.write', 'truncate', 'unlink', 'rm(', 'rmdir', 'copyFile', 'rename(']) {
    assert.ok(!section.includes(writer), `extracted T3 section unexpectedly references a write-capable call: ${writer}`);
  }

  const header = `import { readFile } from 'node:fs/promises';\nimport * as path from 'node:path';\n\nconst STATE_DIR = ${JSON.stringify(fixtureStateDir)};\n\n`;
  const footer = '\n\nexport { readEventsLog };\n';

  const extractedModulePath = path.join(fixtureRoot, 'events-reader-under-test.mjs');
  await writeFile(extractedModulePath, header + section + footer);

  reader = await import('file://' + extractedModulePath);
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// PART 1 -- real-data tests against the actual .workflow/state/events.jsonl.
//
// This is an append-only audit log that can grow during a live session
// (concurrent hooks/slash-commands), so the core assertions here
// independently recompute the expected parsed/skipped split from the file's
// CURRENT bytes -- a from-scratch line-by-line JSON.parse loop written
// separately from readEventsLog's own code, not a reuse of it -- and check
// the reader's result against that recomputation, which holds true no
// matter how much the file has grown since this task was authored. The
// task's own stated ground truth (189 non-blank lines, 10 skipped, at
// time of writing) is checked as a separate, self-skipping assertion so
// this file stays honest (never silently passes a stale expectation)
// without flaking the moment the log legitimately grows.
// =============================================================================

test('real data: reads the actual .workflow/state/events.jsonl without throwing', async () => {
  const result = await reader.readEventsLog(REAL_EVENTS_PATH);
  assert.ok(Array.isArray(result.events));
  assert.strictEqual(typeof result.skippedLines, 'number');
  assert.ok(Number.isInteger(result.skippedLines) && result.skippedLines >= 0);
});

test("real data: skippedLines matches an independently-recomputed parse of the same bytes (cross-check, not a reuse of the reader's own logic)", async (t) => {
  if (!hasRealEventsFile) {
    t.skip(`${REAL_EVENTS_PATH} does not exist on this machine/checkout (gitignored runtime state) -- not a failure`);
    return;
  }
  const raw = await readFile(REAL_EVENTS_PATH, 'utf-8');
  let expectedEvents = 0;
  let expectedSkipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      expectedEvents++;
    } catch {
      expectedSkipped++;
    }
  }
  const result = await reader.readEventsLog(REAL_EVENTS_PATH);
  assert.strictEqual(result.events.length, expectedEvents, 'parsed-event count diverges from an independent recomputation');
  assert.strictEqual(result.skippedLines, expectedSkipped, 'skipped-line count diverges from an independent recomputation');
});

test("real data: matches the task's documented ground truth (189 non-blank lines -> 10 skipped, 179 parsed) if the log hasn't grown/shrunk since", async (t) => {
  if (!hasRealEventsFile) {
    t.skip(`${REAL_EVENTS_PATH} does not exist on this machine/checkout (gitignored runtime state) -- not a failure`);
    return;
  }
  const raw = await readFile(REAL_EVENTS_PATH, 'utf-8');
  const nonBlankLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (nonBlankLines !== 189) {
    t.skip(`events.jsonl now has ${nonBlankLines} non-blank lines (was 189 at task-authoring time) -- log has legitimately grown/changed since, not a failure`);
    return;
  }
  const result = await reader.readEventsLog(REAL_EVENTS_PATH);
  assert.strictEqual(result.skippedLines, 10, 'expected exactly 10 skipped lines at the documented 189-line snapshot');
  assert.strictEqual(result.events.length, 179, 'expected exactly 179 parsed events at the documented 189-line snapshot');
});

test('real data: never writes back to events.jsonl (byte-identical bytes before/after, independently checksummed)', async (t) => {
  if (!hasRealEventsFile) {
    t.skip(`${REAL_EVENTS_PATH} does not exist on this machine/checkout (gitignored runtime state) -- not a failure`);
    return;
  }
  const beforeBuf = await readFile(REAL_EVENTS_PATH);
  await reader.readEventsLog(REAL_EVENTS_PATH);
  await reader.readEventsLog(REAL_EVENTS_PATH);
  const afterBuf = await readFile(REAL_EVENTS_PATH);
  assert.strictEqual(afterBuf.length, beforeBuf.length, 'events.jsonl byte length changed after calling readEventsLog');
  assert.strictEqual(md5(afterBuf), md5(beforeBuf), 'events.jsonl bytes changed after calling readEventsLog -- violates the never-write-back constraint');
});

// =============================================================================
// PART 2 -- synthetic fixtures for deterministic, anywhere-reproducible edge
// cases (each test builds its own dir directly under fixtureRoot so fixtures
// never leak between tests).
// =============================================================================

test('synthetic: missing file returns an empty result without throwing (the normal/expected case)', async () => {
  const p = path.join(fixtureRoot, 'does-not-exist-at-all', 'events.jsonl');
  const result = await reader.readEventsLog(p);
  assert.deepStrictEqual(result, { events: [], skippedLines: 0 });
});

test('synthetic: a missing file does NOT log via console.error (ENOENT is expected, not an error)', async () => {
  const p = path.join(fixtureRoot, 'silent-missing', 'events.jsonl');
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  try {
    await reader.readEventsLog(p);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(calls.length, 0, 'a missing file must not be logged as an error');
});

test('synthetic: a non-ENOENT read error (path is a directory) is logged via console.error but still returns gracefully, never throws', async () => {
  const dirPath = path.join(fixtureRoot, 'case-is-a-directory');
  await mkdir(dirPath, { recursive: true });
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readEventsLog(dirPath);
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(result, { events: [], skippedLines: 0 });
  assert.ok(calls.length >= 1, 'expected a console.error call for a non-ENOENT read failure');
  assert.ok(calls[0].includes(dirPath), 'expected the error message to name the failing path');
});

test('synthetic: mixed content -- every JSON value shape is accepted, blank/whitespace lines are neither parsed nor skipped, garbage is skipped', async () => {
  const dir = path.join(fixtureRoot, 'case-mixed');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  const lines = [
    '{"type":"a"}',
    '',
    '   ',
    '\t',
    '[1,2,3]',
    '"just a string"',
    '42',
    'null',
    'true',
    'false',
    '{not valid json at all',
    'orphaned raw shell output fragment',
    '{"type":"b","nested":{"x":1}}',
  ];
  await writeFile(p, lines.join('\n'));
  const result = await reader.readEventsLog(p);
  assert.deepStrictEqual(result.events, [
    { type: 'a' },
    [1, 2, 3],
    'just a string',
    42,
    null,
    true,
    false,
    { type: 'b', nested: { x: 1 } },
  ]);
  assert.strictEqual(result.skippedLines, 2, 'expected exactly the 2 garbage lines to be skipped');
});

test('synthetic: a file with no trailing newline still parses its final line', async () => {
  const dir = path.join(fixtureRoot, 'case-no-trailing-newline');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  await writeFile(p, '{"a":1}\n{"b":2}'); // deliberately no trailing \n
  const result = await reader.readEventsLog(p);
  assert.deepStrictEqual(result.events, [{ a: 1 }, { b: 2 }]);
  assert.strictEqual(result.skippedLines, 0);
});

test('synthetic: a file containing only blank/whitespace lines yields zero events and zero skipped', async () => {
  const dir = path.join(fixtureRoot, 'case-only-blank');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  await writeFile(p, '\n   \n\t\n\n');
  const result = await reader.readEventsLog(p);
  assert.deepStrictEqual(result, { events: [], skippedLines: 0 });
});

test('synthetic: a completely empty file (0 bytes) yields zero events and zero skipped', async () => {
  const dir = path.join(fixtureRoot, 'case-empty-file');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  await writeFile(p, '');
  const result = await reader.readEventsLog(p);
  assert.deepStrictEqual(result, { events: [], skippedLines: 0 });
});

test('synthetic: an explicit eventsPath argument is honored verbatim -- two fixture files never cross-contaminate', async () => {
  const dir = path.join(fixtureRoot, 'case-explicit-path-override');
  await mkdir(dir, { recursive: true });
  const pA = path.join(dir, 'a.jsonl');
  const pB = path.join(dir, 'b.jsonl');
  await writeFile(pA, '{"which":"a"}\n');
  await writeFile(pB, '{"which":"b"}\n{"which":"b2"}\n');
  const resultA = await reader.readEventsLog(pA);
  const resultB = await reader.readEventsLog(pB);
  assert.deepStrictEqual(resultA.events, [{ which: 'a' }]);
  assert.deepStrictEqual(resultB.events, [{ which: 'b' }, { which: 'b2' }]);
});

test('synthetic: the default eventsPath parameter resolves to STATE_DIR/events.jsonl when called with no argument', async () => {
  const defaultPath = path.join(fixtureStateDir, 'events.jsonl');
  await writeFile(defaultPath, ['{"default":"path"}', 'not json at all', '{"more":"ok"}', ''].join('\n'));
  const result = await reader.readEventsLog(); // no argument -- exercises the default parameter
  assert.deepStrictEqual(result.events, [{ default: 'path' }, { more: 'ok' }]);
  assert.strictEqual(result.skippedLines, 1);
});

test('synthetic: no multi-line-join recovery -- two lines that would combine into valid JSON if joined are both skipped independently, never reassembled', async () => {
  const dir = path.join(fixtureRoot, 'case-no-multiline-recovery');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  // '{"a":' and '1}' would be valid JSON if concatenated, but per spec each
  // line is parsed strictly on its own -- both must count as skipped, never
  // silently joined into one recovered event.
  await writeFile(p, ['{"a":', '1}', '{"valid":true}'].join('\n'));
  const result = await reader.readEventsLog(p);
  assert.strictEqual(result.skippedLines, 2, 'both halves of a would-be-joinable multi-line fragment must be counted as skipped independently');
  assert.deepStrictEqual(result.events, [{ valid: true }]);
});

test('synthetic: one bad line in the middle never stops subsequent lines from being read (per-line try/catch isolation)', async () => {
  const dir = path.join(fixtureRoot, 'case-bad-line-in-middle');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ n: i }));
  lines.splice(10, 0, '{{{not json}}}'); // inject one bad line among 20 good ones
  await writeFile(p, lines.join('\n'));
  const result = await reader.readEventsLog(p);
  assert.strictEqual(result.events.length, 20, 'all 20 valid lines must still be read despite one bad line among them');
  assert.strictEqual(result.skippedLines, 1);
  assert.deepStrictEqual(result.events.map((e) => e.n), Array.from({ length: 20 }, (_, i) => i));
});

test('synthetic: never writes back to the file it reads (byte-identical content unaffected by repeated reads)', async () => {
  const dir = path.join(fixtureRoot, 'case-read-only-check');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'events.jsonl');
  const content = '{"a":1}\nnot json\n{"b":2}\n';
  await writeFile(p, content);
  const beforeBuf = await readFile(p);
  await reader.readEventsLog(p);
  await reader.readEventsLog(p); // call twice for good measure
  const afterBuf = await readFile(p);
  assert.strictEqual(afterBuf.toString('utf-8'), content);
  assert.strictEqual(md5(afterBuf), md5(beforeBuf));
});

test('synthetic: skippedLines does not leak/accumulate across separate calls (no shared mutable module state)', async () => {
  const dir = path.join(fixtureRoot, 'case-no-shared-state');
  await mkdir(dir, { recursive: true });
  const p1 = path.join(dir, 'first.jsonl');
  const p2 = path.join(dir, 'second.jsonl');
  await writeFile(p1, ['bad1', 'bad2', 'bad3', '{"ok":true}'].join('\n'));
  await writeFile(p2, '{"clean":true}\n');
  const r1 = await reader.readEventsLog(p1);
  assert.strictEqual(r1.skippedLines, 3);
  const r2 = await reader.readEventsLog(p2);
  assert.strictEqual(r2.skippedLines, 0, 'skippedLines must not carry over from a previous call');
  assert.deepStrictEqual(r2.events, [{ clean: true }]);
});

// =============================================================================
// PART 3 -- static/structural regression checks against the real, full
// server.mjs source: independently re-verifies (not merely trusting the
// coder's report) that T3 respected T1's hard, permanent constraints.
// =============================================================================

test('static: scripts/graph-dashboard/ still contains only server.mjs + index.html + T9\'s README.md (T1 single-file constraint) -- T3 added no new source files', async () => {
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

test('static: server.mjs still defines only the known, whitelisted GET routes (T1 read-only-forever constraint) -- T3 itself added no route and no write call (T5 legitimately added GET /api/snapshot, and T6 legitimately added GET /events -- see tests/graph-dashboard/snapshot.test.mjs and server.mjs\'s own "SSE broadcast (T6)" section)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  assert.ok(!/\.method\s*===\s*['"](?:POST|PUT|DELETE|PATCH)['"]/.test(src), 'server.mjs must never branch on a mutating HTTP method');
  const routesBlockMatch = src.match(/const routes = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(routesBlockMatch, 'could not find the routes Map literal');
  assert.strictEqual(routesBlockMatch[1].trim(), "['/', serveIndexHtml],\n  ['/api/snapshot', serveSnapshot],\n  ['/events', serveEvents],", 'routes Map must contain only the known GET routes -- update this literal (and this test\'s own name/comment) again if a later task adds another legitimate one');
});
