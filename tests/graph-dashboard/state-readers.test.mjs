// Tests for T4 (kill switch / pending approvals / autonomy phase / cycle
// history readers in scripts/graph-dashboard/server.mjs).
//
// Same reasoning as tests/graph-dashboard/reader.test.mjs (T2) and
// tests/graph-dashboard/events-reader.test.mjs (T3): server.mjs cannot be
// `import`-ed directly in a test process -- it has no exports, and
// unconditionally binds a real TCP port (process.exit(1) on EADDRINUSE) as a
// module-load side effect. So this file extracts the T4 reader section
// VERBATIM out of the real source (marker-based, not hardcoded line numbers,
// so it stays correct as later tasks add code around it) into a throwaway
// importable module, and tests that actual shipped source text -- never a
// reimplementation.
//
// Run with: node --test tests/graph-dashboard/state-readers.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');
const REAL_HALT_PATH = path.join(REPO_ROOT, '.workflow', 'state', 'graph-halt');
const REAL_APPROVALS_DIR = path.join(REPO_ROOT, '.workflow', 'state', 'graph-approvals');
const REAL_AUTONOMY_CONFIG_PATH = path.join(REPO_ROOT, 'governance', 'graph', 'autonomy-config.yml');
const REAL_DASHBOARD_PATH = path.join(REPO_ROOT, 'governance', 'graph', 'stability-dashboard.md');

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Extract the T4 reader section VERBATIM out of the real server.mjs source
// (marker-based) and load it as an importable module, exactly as
// reader.test.mjs and events-reader.test.mjs do for T2/T3. STATE_DIR and
// GIT_TOP_LEVEL are not part of the extracted section (they live in
// server.mjs's own config-resolution code, which shells out to git and is
// out of scope here) -- all four T4 readers only reference them lazily,
// inside default parameters, so it is safe to supply local fixture-backed
// consts of the same names here purely to exercise those default-parameter
// paths under test control (see the "default path" tests below).
// ---------------------------------------------------------------------------
let reader;
let fixtureRoot;
let fixtureStateDir; // backs the STATE_DIR const seen by readKillSwitch/readPendingApprovals's defaults
let fixtureGitTopLevel; // backs the GIT_TOP_LEVEL const seen by readAutonomyPhase/readCycleHistory's defaults

// .workflow/state/* (graph-halt, graph-approvals/) is gitignored per-machine
// runtime state (confirmed via `git check-ignore -v`, matching the blanket
// `.workflow/state/*` rule -- same convention events-reader.test.mjs already
// established for events.jsonl), so its presence/contents are whatever this
// particular machine happens to have right now, not something this file may
// assume. governance/graph/autonomy-config.yml and
// governance/graph/stability-dashboard.md ARE tracked, so they are expected
// to exist in any checkout, but are still stat-checked rather than assumed,
// so this file degrades the same way if run against a future checkout that
// somehow lacks them.
let hasRealHaltFile = false;
let hasRealApprovalsDir = false;
let hasRealAutonomyConfig = false;
let hasRealDashboard = false;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-state-fixtures-'));
  fixtureStateDir = path.join(fixtureRoot, 'default-state-dir');
  fixtureGitTopLevel = path.join(fixtureRoot, 'default-git-top-level');
  await mkdir(fixtureStateDir, { recursive: true });
  await mkdir(path.join(fixtureGitTopLevel, 'governance', 'graph'), { recursive: true });

  hasRealHaltFile = await stat(REAL_HALT_PATH).then(() => true).catch(() => false);
  hasRealApprovalsDir = await stat(REAL_APPROVALS_DIR).then(() => true).catch(() => false);
  hasRealAutonomyConfig = await stat(REAL_AUTONOMY_CONFIG_PATH).then(() => true).catch(() => false);
  hasRealDashboard = await stat(REAL_DASHBOARD_PATH).then(() => true).catch(() => false);

  const src = await readFile(SERVER_MJS, 'utf-8');
  const startNeedle = '// Kill switch, pending approvals, autonomy phase, and cycle history readers';
  const endNeedle = '// Route handlers (GET-only, read-only -- see the header note above)';
  const startIdx = src.indexOf(startNeedle);
  const endIdx = src.indexOf(endNeedle);
  assert.notEqual(startIdx, -1, 'could not find T4 reader-section start marker in server.mjs -- has the comment been reworded/removed?');
  assert.notEqual(endIdx, -1, 'could not find route-handlers marker in server.mjs -- has that section been reworded/removed?');
  assert.ok(startIdx < endIdx, 'markers found out of order');

  const sectionStart = src.lastIndexOf('\n', startIdx) + 1;
  const sepMarker = '// ---------------------------------------------------------------------------';
  const sectionEnd = src.lastIndexOf(sepMarker, endIdx);
  assert.ok(sectionEnd > sectionStart, 'could not locate the separator line closing the reader section');

  const section = src.slice(sectionStart, sectionEnd);

  // Self-diagnosing: fail loudly (not silently test nothing) if an expected
  // symbol isn't in the slice -- e.g. because it was renamed/refactored --
  // and equally fail loudly if it accidentally pulled in T2's/T3's readers
  // or the HTTP bootstrap instead of/in addition to T4's own functions.
  for (const expected of [
    'async function readKillSwitch(',
    'async function readPendingApprovals(',
    'async function readAutonomyPhase(',
    'async function readCycleHistory(',
    'function splitMarkdownTableRow(',
    'function isTableSeparatorRow(',
  ]) {
    assert.ok(section.includes(expected), `extracted section is missing expected declaration: ${expected}`);
  }
  for (const unexpected of [
    'http.createServer',
    'server.listen',
    'requestHandler',
    'async function readGraphRuns(',
    'async function buildRunModel(',
    'async function readEventsLog(',
  ]) {
    assert.ok(!section.includes(unexpected), `extracted section unexpectedly includes unrelated code: ${unexpected}`);
  }

  // Structural guard on the task's hard "every reader here is read-only"
  // constraint: assert the actual shipped section text contains no
  // write-capable fs call at all, rather than only checking that it behaves
  // read-only in the specific cases this file happens to exercise below.
  for (const writer of ['writeFile', 'appendFile', 'fs.write', 'truncate', 'unlink', 'rm(', 'rmdir', 'copyFile', 'rename(']) {
    assert.ok(!section.includes(writer), `extracted T4 section unexpectedly references a write-capable call: ${writer}`);
  }

  // Structural guard on this task's specific, explicit constraint: T4 must
  // never invoke `npm run validate:claims` (or any variant) from server.mjs.
  // Checked here against just the extracted section as an early guard;
  // re-checked against the WHOLE server.mjs file in PART 3 below (the
  // authoritative version of this check -- see that test for why both
  // exist).
  for (const forbidden of ['validate:claims', 'validate-claims', 'claim-validator.ts', 'claim-validator.js']) {
    assert.ok(!section.includes(forbidden), `extracted T4 section unexpectedly references the claim validator: ${forbidden}`);
  }

  const header = `import { readFile, readdir } from 'node:fs/promises';\nimport * as path from 'node:path';\n\nconst STATE_DIR = ${JSON.stringify(fixtureStateDir)};\nconst GIT_TOP_LEVEL = ${JSON.stringify(fixtureGitTopLevel)};\n\n`;
  const footer = '\n\nexport { readKillSwitch, readPendingApprovals, readAutonomyPhase, readCycleHistory, splitMarkdownTableRow, isTableSeparatorRow, CYCLE_TABLE_COLUMNS, CYCLE_TABLE_KEYS };\n';

  const extractedModulePath = path.join(fixtureRoot, 'state-readers-under-test.mjs');
  await writeFile(extractedModulePath, header + section + footer);

  reader = await import('file://' + extractedModulePath);
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// =============================================================================
// PART 1 -- real-data tests against this machine's actual state/governance
// files. graph-halt/graph-approvals are gitignored runtime state that can be
// absent, present, empty, or populated depending on the machine and moment
// this runs -- these tests are written to hold true in EVERY one of those
// states (never assuming "absent" or "present"), independently recomputing
// the expected result from a fresh stat/read rather than hardcoding today's
// snapshot. autonomy-config.yml and stability-dashboard.md are tracked, so a
// stronger "documented ground truth" check is layered on top, self-skipping
// if the doc has legitimately moved on since this was written (same
// convention events-reader.test.mjs uses for events.jsonl).
// =============================================================================

// --- (a) kill switch --------------------------------------------------------

test('real data: readKillSwitch() against the real STATE_DIR/graph-halt matches an independent stat+read, whichever state it is currently in', async () => {
  const result = await reader.readKillSwitch(REAL_HALT_PATH);
  if (!hasRealHaltFile) {
    assert.deepStrictEqual(result, { halted: false, raw: null }, 'graph-halt is absent on this machine -- must report not-halted, not an error');
    return;
  }
  const expectedRaw = await readFile(REAL_HALT_PATH, 'utf-8');
  assert.strictEqual(result.halted, true);
  assert.strictEqual(result.raw, expectedRaw, "raw must be the file's exact contents, never re-interpreted");
});

test('real data: readKillSwitch() never writes to or creates .workflow/state/graph-halt (existence state unchanged after repeated calls)', async () => {
  await reader.readKillSwitch(REAL_HALT_PATH);
  await reader.readKillSwitch(REAL_HALT_PATH);
  const stillHasFile = await stat(REAL_HALT_PATH).then(() => true).catch(() => false);
  assert.strictEqual(stillHasFile, hasRealHaltFile, 'graph-halt existence flipped after calling readKillSwitch -- it must never create or delete this file');
});

// --- (b) pending approvals ---------------------------------------------------

test('real data: readPendingApprovals() against the real STATE_DIR/graph-approvals matches an independent listing, whichever state it is currently in', async () => {
  const result = await reader.readPendingApprovals(REAL_APPROVALS_DIR);
  assert.ok(Array.isArray(result));
  if (!hasRealApprovalsDir) {
    assert.deepStrictEqual(result, [], 'graph-approvals/ is absent on this machine -- must report zero approvals, not an error');
    return;
  }
  const entries = await readdir(REAL_APPROVALS_DIR, { withFileTypes: true });
  const expected = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  assert.deepStrictEqual(result, expected);
});

test('real data: readPendingApprovals() never writes into .workflow/state/graph-approvals/ (directory listing unchanged after repeated calls)', async () => {
  const before1 = hasRealApprovalsDir ? (await readdir(REAL_APPROVALS_DIR)).sort() : null;
  await reader.readPendingApprovals(REAL_APPROVALS_DIR);
  await reader.readPendingApprovals(REAL_APPROVALS_DIR);
  const stillHasDir = await stat(REAL_APPROVALS_DIR).then(() => true).catch(() => false);
  assert.strictEqual(stillHasDir, hasRealApprovalsDir);
  if (before1) {
    const after1 = (await readdir(REAL_APPROVALS_DIR)).sort();
    assert.deepStrictEqual(after1, before1, 'graph-approvals/ contents changed after calling readPendingApprovals -- it must never write here');
  }
});

// --- (c) current autonomy phase ---------------------------------------------

test('real data: readAutonomyPhase() against the real governance/graph/autonomy-config.yml matches an independently-recomputed regex scan', async (t) => {
  if (!hasRealAutonomyConfig) {
    t.skip(`${REAL_AUTONOMY_CONFIG_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const raw = await readFile(REAL_AUTONOMY_CONFIG_PATH, 'utf-8');
  const match = /^phase:\s*(\d+)/m.exec(raw); // independently written, not a reuse of the reader's own regex constant
  const expected = match ? Number(match[1]) : null;
  const result = await reader.readAutonomyPhase(REAL_AUTONOMY_CONFIG_PATH);
  assert.strictEqual(result, expected);
});

test("real data: matches the task's documented ground truth (top-level phase: 0, pilot stage) if the config hasn't moved on since", async (t) => {
  if (!hasRealAutonomyConfig) {
    t.skip(`${REAL_AUTONOMY_CONFIG_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const result = await reader.readAutonomyPhase(REAL_AUTONOMY_CONFIG_PATH);
  if (result !== 0) {
    t.skip(`autonomy-config.yml's top-level phase is now ${result} (was 0 at task-authoring time) -- the program has legitimately advanced phase, not a failure`);
    return;
  }
  assert.strictEqual(result, 0);
});

test('real data: readAutonomyPhase() never writes to autonomy-config.yml (byte-identical bytes before/after, independently checksummed)', async (t) => {
  if (!hasRealAutonomyConfig) {
    t.skip(`${REAL_AUTONOMY_CONFIG_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const beforeBuf = await readFile(REAL_AUTONOMY_CONFIG_PATH);
  await reader.readAutonomyPhase(REAL_AUTONOMY_CONFIG_PATH);
  await reader.readAutonomyPhase(REAL_AUTONOMY_CONFIG_PATH);
  const afterBuf = await readFile(REAL_AUTONOMY_CONFIG_PATH);
  assert.strictEqual(md5(afterBuf), md5(beforeBuf), 'autonomy-config.yml bytes changed after calling readAutonomyPhase -- violates the read-only constraint');
});

// --- (d) cycle history --------------------------------------------------------

test('real data: readCycleHistory() against the real stability-dashboard.md returns well-formed rows with exactly the documented column keys', async (t) => {
  if (!hasRealDashboard) {
    t.skip(`${REAL_DASHBOARD_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const rows = await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 1, 'expected at least one parsed cycle row from the real dashboard');
  const expectedKeys = ['cycle', 'date', 'backlogItem', 'outcome', 'deployBillingGateHit', 'claimValidatorResult', 'changeFailure', 'environmentFaults', 'notes'];
  for (const row of rows) {
    assert.deepStrictEqual(Object.keys(row), expectedKeys);
    for (const key of expectedKeys) assert.strictEqual(typeof row[key], 'string', `row.${key} must be a raw string, never undefined/parsed`);
  }
});

test("real data: row count matches an independently-recomputed line scan of the raw table (cross-check, not a reuse of the reader's own splitMarkdownTableRow/fold logic) -- catches a row being silently DROPPED, which a doc-growth-tolerant count alone would not", async (t) => {
  if (!hasRealDashboard) {
    t.skip(`${REAL_DASHBOARD_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const raw = await readFile(REAL_DASHBOARD_PATH, 'utf-8');
  const lines = raw.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim().startsWith('| Cycle | Date | Backlog item |'));
  assert.notEqual(headerIdx, -1, 'could not independently locate the table header line in the real file -- has it been reworded?');
  assert.ok(/^\|[\s:-]+\|/.test(lines[headerIdx + 1].trim()), 'expected a separator row immediately after the header');
  let expectedRowCount = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break; // same "first non-'|' line ends the table" rule, applied independently
    expectedRowCount++;
  }
  const rows = await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  assert.strictEqual(rows.length, expectedRowCount, 'readCycleHistory() row count diverges from an independently-recomputed count of raw "|"-leading lines under the table header');
});

test("real data: matches the task's documented ground truth (at least 5 cycle rows, starting with phase0-001-lockfile) -- a hard floor, since the table only ever grows, never shrinks, under normal operation", async (t) => {
  if (!hasRealDashboard) {
    t.skip(`${REAL_DASHBOARD_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const rows = await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  assert.ok(rows.length >= 5, `expected at least the 5 documented cycle rows; got ${rows.length} -- this assertion does NOT self-skip, unlike the exact-match check below, because a row COUNT DROPPING is a real regression signal, never legitimate`);
  assert.strictEqual(rows[0].cycle, '`phase0-001-lockfile`', 'the first documented cycle row must still be first (rows are never reordered)');
  if (rows.length !== 5) {
    t.skip(`stability-dashboard.md now has ${rows.length} cycle rows (was 5 at task-authoring time) -- the table has legitimately grown since; skipping only the exact-5th-row identity check below`);
    return;
  }
  assert.strictEqual(rows[4].cycle, '`phase0-005-test-suites`');
});

test('real data: the real embedded-pipe row (phase0-005-test-suites Notes, containing literal `cmd | tail; $?`) survives intact -- proves the overflow-pipe fold works on real data, not just a synthetic mirror', async (t) => {
  if (!hasRealDashboard) {
    t.skip(`${REAL_DASHBOARD_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const rows = await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  const row = rows.find((r) => r.cycle === '`phase0-005-test-suites`');
  if (!row) {
    t.skip('phase0-005-test-suites row no longer present in stability-dashboard.md -- table has legitimately changed, not a failure');
    return;
  }
  assert.ok(
    row.notes.includes('`cmd | tail; $?` captured tail'),
    `expected the embedded-pipe fragment to survive verbatim in row.notes; got: ${row.notes.slice(0, 200)}...`
  );
  // Independent cross-check: the raw line for this row must contain more
  // delimiter "|" characters than the 8-column header implies (that is
  // exactly the wrinkle this row exercises); if this ever goes to exactly
  // 8, the "real embedded pipe" premise of this test itself is stale, so it
  // self-skips rather than silently passing on a mooted case.
  const raw = await readFile(REAL_DASHBOARD_PATH, 'utf-8');
  const rawLine = raw.split('\n').find((l) => l.includes('phase0-005-test-suites'));
  if (!rawLine) {
    t.skip('could not find the raw phase0-005-test-suites line to cross-check pipe count against');
    return;
  }
  const pipeCount = (rawLine.match(/\|/g) || []).length;
  assert.ok(pipeCount > 9, `expected the real row to still have an overflow pipe (>9 total "|", 8 column boundaries + >=1 embedded); got ${pipeCount}`);
  // And the column that absorbed the overflow must still be exactly column 8
  // (notes) -- i.e. no bleed into deployBillingGateHit/claimValidatorResult/changeFailure.
  assert.strictEqual(row.deployBillingGateHit, 'Not triggered');
  assert.strictEqual(row.changeFailure, 'No');
});

test('real data: readCycleHistory() never writes to stability-dashboard.md (byte-identical bytes before/after, independently checksummed) -- including the file\'s own pre-existing uncommitted edit, untouched by this reader', async (t) => {
  if (!hasRealDashboard) {
    t.skip(`${REAL_DASHBOARD_PATH} does not exist on this checkout -- not a failure`);
    return;
  }
  const beforeBuf = await readFile(REAL_DASHBOARD_PATH);
  await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  await reader.readCycleHistory(REAL_DASHBOARD_PATH);
  const afterBuf = await readFile(REAL_DASHBOARD_PATH);
  assert.strictEqual(md5(afterBuf), md5(beforeBuf), 'stability-dashboard.md bytes changed after calling readCycleHistory -- violates the read-only constraint');
});

// =============================================================================
// PART 2 -- synthetic fixtures for deterministic, anywhere-reproducible edge
// cases (each test builds its own dir directly under fixtureRoot so fixtures
// never leak between tests).
// =============================================================================

// --- (a) kill switch ---------------------------------------------------------

test('synthetic: kill switch -- missing file returns not-halted without throwing (the normal/expected case)', async () => {
  const p = path.join(fixtureRoot, 'does-not-exist-at-all', 'graph-halt');
  const result = await reader.readKillSwitch(p);
  assert.deepStrictEqual(result, { halted: false, raw: null });
});

test('synthetic: kill switch -- a missing file does NOT log via console.error (ENOENT is expected, not an error)', async () => {
  const p = path.join(fixtureRoot, 'silent-missing-halt', 'graph-halt');
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  try {
    await reader.readKillSwitch(p);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(calls.length, 0, 'a missing halt file must not be logged as an error');
});

test('synthetic: kill switch -- an existing file reports halted:true with raw contents handed back exactly as written, never parsed', async () => {
  const dir = path.join(fixtureRoot, 'case-halt-present');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'graph-halt');
  const content = '{"haltedBy":"/graph-halt","at":"2026-09-15T00:00:00Z","reason":"manual pause"}\n';
  await writeFile(p, content);
  const result = await reader.readKillSwitch(p);
  assert.deepStrictEqual(result, { halted: true, raw: content }, 'raw must be byte-identical to the file, not re-serialized JSON');
});

test('synthetic: kill switch -- an existing but EMPTY (0-byte) file still reports halted:true (existence alone drives halted, not content)', async () => {
  const dir = path.join(fixtureRoot, 'case-halt-empty');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'graph-halt');
  await writeFile(p, '');
  const result = await reader.readKillSwitch(p);
  assert.deepStrictEqual(result, { halted: true, raw: '' });
});

test('synthetic: kill switch -- non-JSON garbage content is returned verbatim, never JSON.parse-attempted or rejected', async () => {
  const dir = path.join(fixtureRoot, 'case-halt-garbage');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'graph-halt');
  await writeFile(p, 'not json at all, just a human note');
  const result = await reader.readKillSwitch(p);
  assert.deepStrictEqual(result, { halted: true, raw: 'not json at all, just a human note' });
});

test('synthetic: kill switch -- a non-ENOENT read error (path is a directory) is logged via console.error but still degrades to not-halted, never throws', async () => {
  const dirPath = path.join(fixtureRoot, 'case-halt-is-a-directory');
  await mkdir(dirPath, { recursive: true });
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readKillSwitch(dirPath);
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(result, { halted: false, raw: null });
  assert.ok(calls.length >= 1, 'expected a console.error call for a non-ENOENT read failure');
  assert.ok(calls[0].includes(dirPath), 'expected the error message to name the failing path');
});

test('synthetic: kill switch -- the default haltPath parameter resolves to STATE_DIR/graph-halt when called with no argument', async () => {
  const defaultPath = path.join(fixtureStateDir, 'graph-halt');
  await writeFile(defaultPath, 'halted via default path\n');
  const result = await reader.readKillSwitch(); // no argument -- exercises the default parameter
  assert.deepStrictEqual(result, { halted: true, raw: 'halted via default path\n' });
  await rm(defaultPath); // clean up so later default-path tests in this file aren't affected
});

// --- (b) pending approvals ----------------------------------------------------

test('synthetic: pending approvals -- missing directory returns [] without throwing (the normal/expected case)', async () => {
  const p = path.join(fixtureRoot, 'does-not-exist-at-all', 'graph-approvals');
  const result = await reader.readPendingApprovals(p);
  assert.deepStrictEqual(result, []);
});

test('synthetic: pending approvals -- an existing but empty directory returns []', async () => {
  const p = path.join(fixtureRoot, 'case-approvals-empty');
  await mkdir(p, { recursive: true });
  const result = await reader.readPendingApprovals(p);
  assert.deepStrictEqual(result, []);
});

test('synthetic: pending approvals -- returns sorted filenames only, excluding subdirectories', async () => {
  const p = path.join(fixtureRoot, 'case-approvals-mixed');
  await mkdir(p, { recursive: true });
  await writeFile(path.join(p, 'cycle-b.deploy'), '');
  await writeFile(path.join(p, 'cycle-a.billing-2'), '');
  await writeFile(path.join(p, 'cycle-a.billing-1'), '');
  await mkdir(path.join(p, 'a-subdir-should-be-excluded'), { recursive: true }); // must never appear in the result
  const result = await reader.readPendingApprovals(p);
  assert.deepStrictEqual(result, ['cycle-a.billing-1', 'cycle-a.billing-2', 'cycle-b.deploy'], 'expected only files, lexicographically sorted, subdirectory excluded');
});

test('synthetic: pending approvals -- a marker\'s own contents are never read (a file with unparseable/garbage bytes still just contributes its name)', async () => {
  const p = path.join(fixtureRoot, 'case-approvals-garbage-contents');
  await mkdir(p, { recursive: true });
  await writeFile(path.join(p, 'weird.deploy'), Buffer.from([0xff, 0xfe, 0x00, 0x01])); // invalid UTF-8 bytes
  const result = await reader.readPendingApprovals(p);
  assert.deepStrictEqual(result, ['weird.deploy']);
});

test('synthetic: pending approvals -- NEVER logs via console.error on any failure, including a non-ENOENT one (asymmetric vs. the other three T4 readers, matching T2\'s listSubdirNames convention)', async () => {
  // approvalsDir points at a FILE, not a directory -> ENOTDIR, a non-ENOENT
  // failure. readKillSwitch/readAutonomyPhase/readCycleHistory all log via
  // console.error for the equivalent non-ENOENT case (see their own tests
  // above/below) -- readPendingApprovals must NOT, per its own
  // "matching T2's listSubdirNames convention" comment in server.mjs.
  const filePath = path.join(fixtureRoot, 'case-approvals-target-is-a-file.txt');
  await writeFile(filePath, 'not a directory');
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readPendingApprovals(filePath);
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(result, []);
  assert.strictEqual(calls.length, 0, 'readPendingApprovals must never log via console.error, even for a non-ENOENT failure (ENOTDIR here)');
});

test('synthetic: pending approvals -- the default approvalsDir parameter resolves to STATE_DIR/graph-approvals when called with no argument', async () => {
  const defaultDir = path.join(fixtureStateDir, 'graph-approvals');
  await mkdir(defaultDir, { recursive: true });
  await writeFile(path.join(defaultDir, 'only-marker.deploy'), '');
  const result = await reader.readPendingApprovals(); // no argument -- exercises the default parameter
  assert.deepStrictEqual(result, ['only-marker.deploy']);
  await rm(defaultDir, { recursive: true, force: true }); // clean up so later default-path tests aren't affected
});

// --- (c) current autonomy phase -----------------------------------------------

test('synthetic: autonomy phase -- missing file returns null without throwing, and is NOT logged (ENOENT is expected)', async () => {
  const p = path.join(fixtureRoot, 'does-not-exist-at-all', 'autonomy-config.yml');
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readAutonomyPhase(p);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(result, null);
  assert.strictEqual(calls.length, 0, 'a missing autonomy-config.yml must not be logged as an error');
});

for (const [label, phaseValue] of [['0 (pilot)', 0], ['1 (inner-loop autonomous)', 1], ['2 (low-risk loosening)', 2]]) {
  test(`synthetic: autonomy phase -- well-formed "phase: ${phaseValue}" with a trailing comment (matching the real file's own shape) yields ${phaseValue} [${label}]`, async () => {
    const dir = path.join(fixtureRoot, `case-phase-${phaseValue}`);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'autonomy-config.yml');
    await writeFile(p, `phase: ${phaseValue}  # ${label}\n\nroles:\n  planner: { subagent: planner }\n`);
    const result = await reader.readAutonomyPhase(p);
    assert.strictEqual(result, phaseValue);
  });
}

test('synthetic: autonomy phase -- "phase:0" with no space after the colon still matches', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-no-space');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  await writeFile(p, 'phase:0\n');
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(result, 0);
});

test('synthetic: autonomy phase -- only indented/differently-named phase-like keys (no genuine top-level "phase:") correctly yields null, not a false positive', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-decoys-only');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  // Mirrors the real file's own decoy shapes: phase_0/1/2 nested under
  // gates.merge_to_main, plus phase_2_entry_criteria and loosens_in_phase_2
  // -- none of these may be line-start-anchored as "phase:".
  await writeFile(
    p,
    [
      'gates:',
      '  production_deploy:',
      '    loosens_in_phase_2: false',
      '  merge_to_main:',
      '    phase_0: human_required_every_time',
      '    phase_1: human_required_every_time',
      '    phase_2: auto_allowed_for_low_risk_devops_core_only',
      'phase_2_entry_criteria:',
      '  min_clean_phase_1_cycles: null',
      '',
    ].join('\n')
  );
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(result, null, 'a decoy-only file (no genuine top-level phase: key) must yield null, never mistakenly match a nested/differently-named key');
});

test('synthetic: autonomy phase -- a commented-out "# phase: 5" line does not match (line must literally start with "phase:", not "#")', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-commented-out');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  await writeFile(p, '# phase: 5 (old value, do not use)\nroles:\n  planner: {}\n');
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(result, null);
});

test('synthetic: autonomy phase -- the key can appear on any line (multiline flag), not only the first', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-not-first-line');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  await writeFile(p, '# a leading comment\n# another one\n\nphase: 1\n\nroles: {}\n');
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(result, 1);
});

test('synthetic: autonomy phase -- an empty (0-byte) file yields null', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-empty-file');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  await writeFile(p, '');
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(result, null);
});

test('synthetic: autonomy phase -- a non-ENOENT read error (path is a directory) is logged via console.error but still degrades to null, never throws', async () => {
  const dirPath = path.join(fixtureRoot, 'case-phase-is-a-directory');
  await mkdir(dirPath, { recursive: true });
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readAutonomyPhase(dirPath);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(result, null);
  assert.ok(calls.length >= 1, 'expected a console.error call for a non-ENOENT read failure');
  assert.ok(calls[0].includes(dirPath), 'expected the error message to name the failing path');
});

test('synthetic: autonomy phase -- the default configPath parameter resolves to GIT_TOP_LEVEL/governance/graph/autonomy-config.yml when called with no argument', async () => {
  const defaultPath = path.join(fixtureGitTopLevel, 'governance', 'graph', 'autonomy-config.yml');
  await writeFile(defaultPath, 'phase: 2\n');
  const result = await reader.readAutonomyPhase(); // no argument -- exercises the default parameter
  assert.strictEqual(result, 2);
  await rm(defaultPath); // clean up so later default-path tests aren't affected
});

test('synthetic: autonomy phase -- return type is always a bare number or null, never an object (guards against a future key collision with T2\'s per-run phase field)', async () => {
  const dir = path.join(fixtureRoot, 'case-phase-type-check');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'autonomy-config.yml');
  await writeFile(p, 'phase: 1\n');
  const result = await reader.readAutonomyPhase(p);
  assert.strictEqual(typeof result, 'number');
  assert.ok(Number.isInteger(result));
  const missingResult = await reader.readAutonomyPhase(path.join(fixtureRoot, 'nope', 'autonomy-config.yml'));
  assert.strictEqual(missingResult, null);
});

// --- (d) cycle history ---------------------------------------------------------

const SYNTHETIC_HEADER = '| Cycle | Date | Backlog item | Outcome | Deploy/billing gate hit? | Claim-validator result | Change-failure? | Notes |';
const SYNTHETIC_SEP = '|---|---|---|---|---|---|---|---|';

test('synthetic: cycle history -- missing file returns [] without throwing, and is NOT logged (ENOENT is expected)', async () => {
  const p = path.join(fixtureRoot, 'does-not-exist-at-all', 'stability-dashboard.md');
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readCycleHistory(p);
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(result, []);
  assert.strictEqual(calls.length, 0, 'a missing stability-dashboard.md must not be logged as an error');
});

test('synthetic: cycle history -- a well-formed two-row table parses into objects with exactly the documented keys, in top-to-bottom order', async () => {
  const dir = path.join(fixtureRoot, 'case-history-well-formed');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    '# Some heading',
    '',
    'Intro prose before the table.',
    '',
    SYNTHETIC_HEADER,
    SYNTHETIC_SEP,
    '| `c1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | first notes |',
    '| `c2` | 2026-01-02 | item two | Blocked | Triggered | 5/5 passing | Yes | second notes |',
    '',
    'Trailing prose after the table.',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.deepStrictEqual(rows, [
    { cycle: '`c1`', date: '2026-01-01', backlogItem: 'item one', outcome: 'Ready', deployBillingGateHit: 'Not triggered', claimValidatorResult: 'Not re-run', changeFailure: 'No', notes: 'first notes' },
    { cycle: '`c2`', date: '2026-01-02', backlogItem: 'item two', outcome: 'Blocked', deployBillingGateHit: 'Triggered', claimValidatorResult: '5/5 passing', changeFailure: 'Yes', notes: 'second notes' },
  ]);
});

test('synthetic: cycle history -- the environment-fault column is preserved separately', async () => {
  const p = path.join(fixtureRoot, 'case-history-environment-faults.md');
  await writeFile(p, [
    '| Cycle | Date | Backlog item | Outcome | Deploy/billing gate hit? | Claim-validator result | Change-failure? | Environment faults | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| `c7` | 2026-09-15 | resilience | Blocked | No | 1/1 | No | 3: api 2, environment 1; resume time unrecorded | recovery notes |',
  ].join('\n'));
  const rows = await reader.readCycleHistory(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].environmentFaults, '3: api 2, environment 1; resume time unrecorded');
  assert.equal(rows[0].changeFailure, 'No');
  assert.equal(rows[0].notes, 'recovery notes');
});

test('synthetic: cycle history -- a reworded header (doc reshaped) does not match -- degrades to [], never a misaligned parse', async () => {
  const dir = path.join(fixtureRoot, 'case-history-reworded-header');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    '| Cycle ID | Date | Backlog item | Outcome | Deploy/billing gate hit? | Claim-validator result | Change-failure? | Notes |', // "Cycle ID" != "Cycle"
    SYNTHETIC_SEP,
    '| `c1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | notes |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.deepStrictEqual(rows, []);
});

test('synthetic: cycle history -- header-shaped text with no real separator row right after it is rejected (guards a false-positive header match outside a real table)', async () => {
  const dir = path.join(fixtureRoot, 'case-history-header-no-separator');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    SYNTHETIC_HEADER,
    'this is not a valid separator row', // no leading "|" at all
    '| `c1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | notes |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.deepStrictEqual(rows, []);
});

test('synthetic: cycle history -- header matched with EOF immediately after it (no separator line at all) degrades to []', async () => {
  const dir = path.join(fixtureRoot, 'case-history-header-then-eof');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  await writeFile(p, SYNTHETIC_HEADER); // no trailing newline, nothing after
  const rows = await reader.readCycleHistory(p);
  assert.deepStrictEqual(rows, []);
});

test('synthetic: cycle history -- a short/malformed row (fewer cells than the header) is skipped, never fabricated -- other rows still parse', async () => {
  const dir = path.join(fixtureRoot, 'case-history-short-row');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    SYNTHETIC_HEADER,
    SYNTHETIC_SEP,
    '| `good1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | notes |',
    '| `too-short` | 2026-01-02 | only 3 cells |', // malformed -- 3 cells, not 8
    '| `good2` | 2026-01-03 | item three | Blocked | Triggered | 1/1 | Yes | more notes |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.strictEqual(rows.length, 2, 'the malformed row must be skipped, leaving exactly the 2 well-formed rows');
  assert.deepStrictEqual(rows.map((r) => r.cycle), ['`good1`', '`good2`']);
});

test('synthetic: cycle history -- the table ends at the first line that does not start with "|" -- content after a blank/prose line is excluded', async () => {
  const dir = path.join(fixtureRoot, 'case-history-table-end');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    SYNTHETIC_HEADER,
    SYNTHETIC_SEP,
    '| `c1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | notes |',
    '', // blank line ends the table
    '## A later heading that happens to contain a | pipe character, but is not a table row',
    '| `should-not-be-parsed` | 2026-99-99 | ghost row | X | X | X | X | X |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.deepStrictEqual(rows.map((r) => r.cycle), ['`c1`'], 'rows after the table-ending blank line must never be parsed');
});

test('synthetic: cycle history -- an embedded pipe inside inline code in the LAST column is folded back in, not misaligned or dropped (synthetic mirror of the real phase0-005 row)', async () => {
  const dir = path.join(fixtureRoot, 'case-history-embedded-pipe');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    SYNTHETIC_HEADER,
    SYNTHETIC_SEP,
    '| `c1` | 2026-01-01 | item one | Ready | Not triggered | Not re-run | No | saw `cmd | tail; $?` captured tail status |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].notes, 'saw `cmd | tail; $?` captured tail status', 'the embedded pipe must be restored verbatim in the final column');
  assert.strictEqual(rows[0].changeFailure, 'No', 'the second-to-last column must not have absorbed any of the overflow');
});

test('synthetic: cycle history -- raw Markdown (bold, backticks) in cells is preserved, trimmed only of surrounding whitespace', async () => {
  const dir = path.join(fixtureRoot, 'case-history-raw-markdown');
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, 'stability-dashboard.md');
  const md = [
    SYNTHETIC_HEADER,
    SYNTHETIC_SEP,
    '| `c1` |   2026-01-01   | item one | **Bold outcome** with an em dash — here | Not triggered | Not re-run | No | plain notes |',
  ].join('\n');
  await writeFile(p, md);
  const rows = await reader.readCycleHistory(p);
  assert.strictEqual(rows[0].date, '2026-01-01', 'surrounding whitespace must be trimmed');
  assert.strictEqual(rows[0].outcome, '**Bold outcome** with an em dash — here', 'internal Markdown/punctuation must be preserved exactly, not re-interpreted');
});

test('synthetic: cycle history -- a non-ENOENT read error (path is a directory) is logged via console.error but still degrades to [], never throws', async () => {
  const dirPath = path.join(fixtureRoot, 'case-history-is-a-directory');
  await mkdir(dirPath, { recursive: true });
  const originalError = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(' '));
  let result;
  try {
    result = await reader.readCycleHistory(dirPath);
  } finally {
    console.error = originalError;
  }
  assert.deepStrictEqual(result, []);
  assert.ok(calls.length >= 1, 'expected a console.error call for a non-ENOENT read failure');
  assert.ok(calls[0].includes(dirPath), 'expected the error message to name the failing path');
});

test('synthetic: cycle history -- the default dashboardPath parameter resolves to GIT_TOP_LEVEL/governance/graph/stability-dashboard.md when called with no argument', async () => {
  const defaultPath = path.join(fixtureGitTopLevel, 'governance', 'graph', 'stability-dashboard.md');
  const md = [SYNTHETIC_HEADER, SYNTHETIC_SEP, '| `default-path-c1` | 2026-01-01 | x | x | x | x | x | x |'].join('\n');
  await writeFile(defaultPath, md);
  const rows = await reader.readCycleHistory(); // no argument -- exercises the default parameter
  assert.deepStrictEqual(rows.map((r) => r.cycle), ['`default-path-c1`']);
  await rm(defaultPath); // clean up so later default-path tests aren't affected
});

// --- (d) direct unit tests of the two small parsing helpers -------------------

test('synthetic: splitMarkdownTableRow -- a line not starting with "|" (even containing one elsewhere) returns null', () => {
  assert.strictEqual(reader.splitMarkdownTableRow("This isn't | a table row", 8), null);
  assert.strictEqual(reader.splitMarkdownTableRow('', 8), null);
});

test('synthetic: splitMarkdownTableRow -- exact column count splits cleanly with each cell trimmed', () => {
  const result = reader.splitMarkdownTableRow('|  a  | b |c| d |', 4);
  assert.deepStrictEqual(result, ['a', 'b', 'c', 'd']);
});

test('synthetic: splitMarkdownTableRow -- one surplus delimiter-shaped "|" folds into the final column with the pipe restored (hand-verified example)', () => {
  // Hand-computed: inner split gives 5 parts for expectedCells=4 -- the
  // first 3 are trusted as real boundaries, the last 2 are rejoined with
  // "|" restored into a single 4th column.
  const line = '| A | B | text with a | pipe | C |';
  const result = reader.splitMarkdownTableRow(line, 4);
  assert.deepStrictEqual(result, ['A', 'B', 'text with a', 'pipe | C']);
});

test('synthetic: splitMarkdownTableRow -- two surplus pipes still fold entirely into the final column', () => {
  const line = '| A | one | two | three | B |'; // expectedCells=3 -> 5 parts -> 2 surplus
  const result = reader.splitMarkdownTableRow(line, 3);
  assert.deepStrictEqual(result, ['A', 'one', 'two | three | B']);
});

test('synthetic: isTableSeparatorRow -- accepts plain dashes and alignment-marker variants, rejects real cell text and an empty array', () => {
  assert.strictEqual(reader.isTableSeparatorRow(['---', '---', '---']), true);
  assert.strictEqual(reader.isTableSeparatorRow([':--', '--:', ':-:']), true);
  assert.strictEqual(reader.isTableSeparatorRow(['-', '-']), true);
  assert.strictEqual(reader.isTableSeparatorRow(['---', 'a', '---']), false);
  assert.strictEqual(reader.isTableSeparatorRow([]), false);
});

test('synthetic: CYCLE_TABLE_COLUMNS and CYCLE_TABLE_KEYS stay the same length (structural sanity -- one key per documented column)', () => {
  assert.strictEqual(reader.CYCLE_TABLE_COLUMNS.length, 9);
  assert.strictEqual(reader.CYCLE_TABLE_KEYS.length, 9);
  assert.deepStrictEqual(reader.CYCLE_TABLE_COLUMNS, ['Cycle', 'Date', 'Backlog item', 'Outcome', 'Deploy/billing gate hit?', 'Claim-validator result', 'Change-failure?', 'Environment faults', 'Notes']);
  assert.deepStrictEqual(reader.CYCLE_TABLE_KEYS, ['cycle', 'date', 'backlogItem', 'outcome', 'deployBillingGateHit', 'claimValidatorResult', 'changeFailure', 'environmentFaults', 'notes']);
});

// =============================================================================
// PART 3 -- static/structural regression checks against the real, full
// server.mjs source: independently re-verifies (not merely trusting the
// coder's report) that T4 respected T1's hard, permanent constraints plus
// this task's own explicit constraints.
// =============================================================================

test('static: scripts/graph-dashboard/ still contains only server.mjs + index.html + T9\'s README.md (T1 single-file constraint) -- T4 added no new source files', async () => {
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

test('static: server.mjs still defines only the known, whitelisted GET routes (T1 read-only-forever constraint) -- T4 itself added no route and no write call (T5 legitimately added GET /api/snapshot, and T6 legitimately added GET /events -- see tests/graph-dashboard/snapshot.test.mjs and server.mjs\'s own "SSE broadcast (T6)" section)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  assert.ok(!/\.method\s*===\s*['"](?:POST|PUT|DELETE|PATCH)['"]/.test(src), 'server.mjs must never branch on a mutating HTTP method');
  const routesBlockMatch = src.match(/const routes = new Map\(\[([\s\S]*?)\]\);/);
  assert.ok(routesBlockMatch, 'could not find the routes Map literal');
  assert.strictEqual(routesBlockMatch[1].trim(), "['/', serveIndexHtml],\n  ['/api/snapshot', serveSnapshot],\n  ['/events', serveEvents],", 'routes Map must contain only the known GET routes -- update this literal (and this test\'s own name/comment) again if a later task adds another legitimate one');
});

test("static: server.mjs never invokes \"npm run validate:claims\" (or any variant) anywhere in the file -- this task's own explicit, hard constraint", async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  for (const forbidden of ['validate:claims', 'validate-claims', 'claim-validator.ts', 'claim-validator.js', 'ClaimValidator']) {
    assert.ok(!src.includes(forbidden), `server.mjs must never reference the claim validator; found forbidden substring: ${forbidden}`);
  }
  // The server derives its root from its own file location, so it has no
  // toolchain subprocess dependency even when git is unavailable.
  const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const execFileSyncCalls = [...codeOnly.matchAll(/execFileSync\(\s*(['"`])(.*?)\1/g)].map((m) => m[2]);
  assert.deepStrictEqual(execFileSyncCalls, [], `server.mjs must not spawn a toolchain command -- found: ${JSON.stringify(execFileSyncCalls)}`);
  // Excludes a "." immediately before exec/execSync/spawn(Sync) so this
  // doesn't false-positive on the two unrelated RegExp#exec() calls already
  // in this file (BACKLOG_ITEM_RE.exec(...), AUTONOMY_PHASE_RE.exec(...)) --
  // neither is node:child_process, both are String-matching regexes.
  assert.ok(!/(?<!\.)\b(?:execSync|spawn(?:Sync)?|exec)\s*\(/.test(codeOnly), 'server.mjs must not use any other node:child_process invocation style');
});

test('static: the autonomy-phase naming-collision warning survives in the source (documentation regression guard for a real, previously-flagged risk)', async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  assert.ok(src.includes('NAMING COLLISION WARNING'), 'expected the explicit warning against merging autonomy phase under the same key as T2\'s per-run phase field to still be present near readAutonomyPhase');
});
