// Tests for T2 (graph-dashboard run-model reader in scripts/graph-dashboard/server.mjs).
//
// server.mjs cannot be `import`-ed directly in a test process: it has no
// exports, and unconditionally binds a real TCP port (process.exit(1) on
// EADDRINUSE) as a module-load side effect. So this file extracts the T2
// reader section VERBATIM out of the real source (marker-based, not
// hardcoded line numbers, so it stays correct as later tasks add code
// around it) into a throwaway importable module, and tests that actual
// shipped source text -- never a reimplementation.
//
// Run with: node --test tests/graph-dashboard/reader.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: THIS_DIR, encoding: 'utf-8' }).trim();
const SERVER_MJS = path.join(REPO_ROOT, 'scripts', 'graph-dashboard', 'server.mjs');
// Same derivation server.mjs itself uses for JOURNAL_ROOT (see its config
// resolution comment): real session run directories are wholly
// machine/checkout-specific, so every "real data" test below reads from
// `realRuns`/`hasRealData` (populated once in the before() hook) and skips
// itself -- rather than failing -- when this machine/checkout has none.
const REAL_JOURNAL_ROOT = path.join(os.homedir(), '.claude', 'projects', REPO_ROOT.replaceAll('/', '-'));

// ---------------------------------------------------------------------------
// Extract the T2 reader section VERBATIM out of the real server.mjs source
// (marker-based, not hardcoded line numbers, so this stays correct if later
// tasks add code before/after the section) and load it as an importable
// module. This tests the actual shipped source text, not a reimplementation
// -- server.mjs itself cannot be imported directly for testing because it
// unconditionally binds a real TCP port (and process.exit(1)s on
// EADDRINUSE) as a module-load side effect, and exports nothing.
// ---------------------------------------------------------------------------
let reader;
let extractedModulePath;

before(async () => {
  const src = await readFile(SERVER_MJS, 'utf-8');
  const startNeedle = '// Run model reader (T2)';
  const endNeedle = '// Route handlers (GET-only, read-only -- see the header note above)';
  const startIdx = src.indexOf(startNeedle);
  const endIdx = src.indexOf(endNeedle);
  assert.notEqual(startIdx, -1, 'could not find reader-section start marker in server.mjs -- has the T2 comment been reworded/removed?');
  assert.notEqual(endIdx, -1, 'could not find route-handlers marker in server.mjs -- has that section been reworded/removed?');
  assert.ok(startIdx < endIdx, 'markers found out of order');

  const sectionStart = src.lastIndexOf('\n', startIdx) + 1;
  const sepMarker = '// ---------------------------------------------------------------------------';
  const sectionEnd = src.lastIndexOf(sepMarker, endIdx);
  assert.ok(sectionEnd > sectionStart, 'could not locate the separator line closing the reader section');

  const section = src.slice(sectionStart, sectionEnd);

  // Self-diagnosing: fail loudly (not silently test nothing) if the expected
  // symbols aren't in the slice -- e.g. because the reader was refactored/
  // renamed and this extraction needs updating too.
  for (const fn of [
    'async function readGraphRuns(', 'async function buildRunModel(',
    'async function discoverRunDirectories(', 'function buildLabelStates(',
    'async function computeRunActivityWindow(', 'async function computeLabelTiming(',
    'async function findBacklogItem(', 'function deriveExpectedLabels(',
    'function buildNodes(',
  ]) {
    assert.ok(section.includes(fn), `extracted section is missing expected declaration: ${fn}`);
  }
  // And equally, it must NOT have pulled in the HTTP bootstrap / listen code.
  for (const forbidden of ['http.createServer', 'server.listen', 'requestHandler']) {
    assert.ok(!section.includes(forbidden), `extracted section unexpectedly includes bootstrap code: ${forbidden}`);
  }

  const header = 'import { readFile, readdir, stat } from "node:fs/promises";\nimport * as path from "node:path";\n\n';
  const footer = '\n\nexport { readGraphRuns, buildRunModel, discoverRunDirectories, buildLabelStates, readJournalEvents, computeRunActivityWindow, computeLabelTiming, findBacklogItem, scanFileForBacklogItem, deriveExpectedLabels, buildNodes };\n';

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-reader-'));
  extractedModulePath = path.join(tmpDir, 'reader-under-test.mjs');
  await writeFile(extractedModulePath, header + section + footer);

  reader = await import('file://' + extractedModulePath);

  // NOTE: deliberately done in THIS SAME before() hook, sequentially after
  // the `reader` import above, rather than as separate top-level before()
  // registrations -- this Node version does not run multiple top-level
  // before() hooks with the sequential-and-mutually-visible semantics that
  // would be needed for a later hook to safely read `reader` set by an
  // earlier one (confirmed empirically: it threw "Cannot read properties of
  // undefined (reading 'readGraphRuns')" when split into separate hooks).
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'graph-dashboard-fixtures-'));

  realRuns = await reader.readGraphRuns(REAL_JOURNAL_ROOT);
  hasRealData = realRuns.length > 0;
});

after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture builder for synthetic edge cases. Each test builds its own dirs
// directly (explicit mkdir/writeFile) under a fresh subpath of fixtureRoot
// so fixtures never leak between tests.
// ---------------------------------------------------------------------------
let fixtureRoot;

// =============================================================================
// PART 1 -- real-data tests against this session's own real run directories.
//
// MEDIUM CONFIDENCE (environment-dependent, per proof-of-work's confidence
// tiers): these assert against actual `~/.claude/projects/<slug>/**` session
// history, which only exists on a machine/checkout that has run these
// Workflows before. Fetched once (in the before() hook above) and shared by
// every test below; each test skips itself (does not fail) when this
// machine/checkout has none, so this file stays a legitimate, honest
// regression test in CI or a fresh clone -- see PART 2 for the
// deterministic, anywhere-reproducible half.
// =============================================================================
let realRuns = [];
let hasRealData = false;

test('real data: readGraphRuns() resolves against the actual JOURNAL_ROOT and finds real runs', (t) => {
  if (!hasRealData) return t.skip(`no real run directories under ${REAL_JOURNAL_ROOT} on this machine/checkout`);
  assert.ok(Array.isArray(realRuns));
  assert.ok(realRuns.length >= 8, `expected at least the 8 known real run dirs, got ${realRuns.length}`);
});

test('real data: cycleId/cycleOutcome are always explicit null, never fabricated, on every real run', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  for (const run of realRuns) {
    assert.strictEqual(run.cycleId, null, `run ${run.workflowId} cycleId should be null`);
    assert.strictEqual(run.cycleOutcome, null, `run ${run.workflowId} cycleOutcome should be null`);
  }
});

test('real data: no started event ever carries phase "Release" (Release is post-agent-loop only)', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  for (const run of realRuns) {
    for (const label of Object.values(run.labels)) {
      assert.notStrictEqual(label.phase, 'Release', `run ${run.workflowId} label ${label.label} unexpectedly has phase Release`);
    }
  }
});

test('real data: label keys are never normalized (coder:1 and coder:T1 style both survive verbatim)', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const allLabels = new Set();
  for (const run of realRuns) for (const l of Object.keys(run.labels)) allLabels.add(l);
  assert.ok([...allLabels].some((l) => /^coder:T\d+$/.test(l)), 'expected at least one coder:T<n>-style label across real runs');
  assert.ok([...allLabels].some((l) => /^coder:\d+$/.test(l)), 'expected at least one plain coder:<n>-style label across real runs');
});

test('real data: the known retry case (wf_91d4a54d-706 tester:T3) resolves to done, not errored', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const run = realRuns.find((r) => r.workflowId === 'wf_91d4a54d-706');
  if (!run) return t.skip('this specific historical run (wf_91d4a54d-706) is not present on this machine/checkout');
  const label = run.labels['tester:T3'];
  assert.ok(label, 'expected a tester:T3 label in wf_91d4a54d-706');
  assert.strictEqual(label.status, 'done', 'a failed-then-successfully-retried label must resolve to done, not errored');
  assert.strictEqual(label.agentId, 'ae5d439292c54f91f', 'should carry the RETRY agentId (the second started), not the failed first one');
});

test('real data: refute-style runs (no planner label) get an empty expected chain, not a fabricated sprint-cycle chain', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const refuteRuns = realRuns.filter((r) => !r.labels.planner);
  if (refuteRuns.length === 0) return t.skip('no non-sprint-cycle (no-planner) runs present on this machine/checkout');
  for (const run of refuteRuns) {
    assert.deepStrictEqual(run.expectedLabels, []);
    // nodes must still surface every observed label (never silently dropped)
    const observedLabels = Object.keys(run.labels).sort();
    const nodeLabels = run.nodes.map((n) => n.label).sort();
    assert.deepStrictEqual(nodeLabels, observedLabels);
  }
});

test('real data: findBacklogItem rejects the confirmed ${backlogItem} tool_result false-positive and finds the real text', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const run = realRuns.find((r) => r.workflowId === 'wf_5ac06c9b-e2d');
  if (!run) return t.skip('this specific historical run (wf_5ac06c9b-e2d) is not present on this machine/checkout');
  assert.ok(run.backlogItem, 'expected a non-null backlogItem for this run');
  assert.ok(!run.backlogItem.includes('${backlogItem}'), 'must never surface the unexpanded template literal as the backlog item');
  assert.ok(run.backlogItem.includes('SHIP_BLOCKERS.md item 1.1'), 'expected the real backlog item text (validate:claims investigation) to be recovered');
});

test('real data: active is always a strict boolean, independently computed per run (not a single global flag)', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  // NOTE: whether any given run is *currently* active is inherently a live
  // snapshot (true only while some label is genuinely mid-flight) so this
  // permanent regression test only pins the type/independence invariant.
  // At the time this suite was authored, this exact machine/session had 2
  // concurrently active real runs and 6 inactive ones simultaneously --
  // recorded as proof-run evidence, not baked in here as a hard assertion
  // that would flake the next time this file runs at a quiet moment.
  for (const run of realRuns) {
    assert.strictEqual(typeof run.active, 'boolean', `${run.workflowId}.active must be a strict boolean`);
  }
});

test('real data: every label with an agentId whose agent-*.jsonl/meta.json exist gets non-null timing', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const runs = realRuns;
  let checked = 0;
  for (const run of runs) {
    for (const label of Object.values(run.labels)) {
      if (!label.agentId) continue;
      checked++;
      assert.ok(label.startedAtMs !== null, `${run.workflowId}/${label.label} expected non-null startedAtMs`);
      assert.ok(label.lastEventAtMs !== null, `${run.workflowId}/${label.label} expected non-null lastEventAtMs`);
      assert.ok(label.elapsedMs !== null && label.elapsedMs >= 0, `${run.workflowId}/${label.label} expected elapsedMs >= 0`);
      assert.ok(label.startedAtMs <= label.lastEventAtMs, `${run.workflowId}/${label.label} startedAtMs must be <= lastEventAtMs`);
    }
  }
  assert.ok(checked > 20, `expected to have checked a substantial number of real labels, only checked ${checked}`);
});

test('real data: run-level activity window is populated and ordered for every run', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  for (const run of realRuns) {
    assert.ok(run.firstActivityMs !== null, `${run.workflowId} firstActivityMs should not be null (journal.jsonl always exists)`);
    assert.ok(run.lastActivityMs !== null, `${run.workflowId} lastActivityMs should not be null`);
    assert.ok(run.firstActivityMs <= run.lastActivityMs, `${run.workflowId} firstActivityMs must be <= lastActivityMs`);
  }
});

test('real data: runs are sorted by lastActivityMs descending', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  for (let i = 1; i < realRuns.length; i++) {
    assert.ok(realRuns[i - 1].lastActivityMs >= realRuns[i].lastActivityMs, `run ${i - 1} should sort before run ${i}`);
  }
});

test('real data: a run whose planner is done with tasks derives the full sprint-cycle chain, with queued placeholders where not yet observed', (t) => {
  if (!hasRealData) return t.skip('no real run directories on this machine/checkout');
  const run = realRuns.find((r) => r.labels.planner && r.labels.planner.status === 'done' && r.expectedLabels.length > 0);
  assert.ok(run, 'expected at least one real run with a done planner and a derivable chain');
  assert.strictEqual(run.expectedLabels[0], 'planner');
  assert.ok(['reviewer', 'security', 'validator'].every((l) => run.expectedLabels.includes(l)));
  // every node's status must be one of the four defined states
  for (const node of run.nodes) {
    assert.ok(['running', 'errored', 'done', 'queued'].includes(node.status), `unexpected status ${node.status}`);
  }
});

// =============================================================================
// PART 2 -- synthetic fixtures for edge cases not (or not reliably) present
// in the real data
// =============================================================================

test('synthetic: missing journal root entirely returns [] without throwing', async () => {
  const runs = await reader.readGraphRuns(path.join(fixtureRoot, 'does-not-exist-at-all'));
  assert.deepStrictEqual(runs, []);
});

test('synthetic: session dir with no subagents/workflows subtree is excluded, not an error', async () => {
  const root = path.join(fixtureRoot, 'case-no-subtree');
  await mkdir(path.join(root, 'sess1'), { recursive: true });
  const runs = await reader.readGraphRuns(root);
  assert.deepStrictEqual(runs, []);
});

test('synthetic: a workflow dir without journal.jsonl is excluded from discovery', async () => {
  const root = path.join(fixtureRoot, 'case-no-journal-file');
  const dir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_nope');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent-abc.jsonl'), '{}');
  const runs = await reader.readGraphRuns(root);
  assert.deepStrictEqual(runs, []);
});

test('synthetic: a non-"wf_"-prefixed dir name IS still included as long as it has journal.jsonl (no prefix filter in spec)', async () => {
  const root = path.join(fixtureRoot, 'case-no-prefix');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'totally-not-wf-prefixed');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"launched"}\n');
  const runs = await reader.readGraphRuns(root);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].workflowId, 'totally-not-wf-prefixed');
});

test('synthetic: malformed journal lines (invalid JSON, blanks, non-object JSON, arrays) never throw and are skipped', async () => {
  const root = path.join(fixtureRoot, 'case-malformed');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_bad');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"launched"}',
    '',
    '   ',
    '{not valid json at all',
    '"just a string"',
    '42',
    'null',
    '[1,2,3]',
    '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{"tasks":[]}}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_bad', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.labels.planner.status, 'done');
  assert.strictEqual(Object.keys(model.labels).length, 1, 'malformed lines must not create phantom labels');
});

test('synthetic: a started event with a non-string label is treated as malformed and produces no key binding', async () => {
  const root = path.join(fixtureRoot, 'case-bad-label');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_badlabel');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":123,"phase":"Plan"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{}}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_badlabel', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(Object.keys(model.labels).length, 0, 'a non-string label must not register any key->label binding, so the orphaned result is dropped too');
});

test('synthetic: result/failed events referencing an unseen key are silently ignored (no phantom labels, no crash)', async () => {
  const root = path.join(fixtureRoot, 'case-orphan-events');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_orphan');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"result","key":"ghost-key","agentId":"a1","result":{}}',
    '{"type":"failed","key":"another-ghost","agentId":"a2"}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_orphan', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.deepStrictEqual(model.labels, {});
  assert.strictEqual(model.active, false);
});

test('synthetic: missing agent-*.jsonl/meta.json files -> null timing, no crash', async () => {
  const root = path.join(fixtureRoot, 'case-missing-agent-files');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_missingfiles');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"ghost-agent","label":"planner","phase":"Plan"}\n');
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_missingfiles', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.labels.planner.status, 'running');
  assert.strictEqual(model.labels.planner.startedAtMs, null);
  assert.strictEqual(model.labels.planner.lastEventAtMs, null);
  assert.strictEqual(model.labels.planner.elapsedMs, null);
});

test('synthetic: a label with only one of the two agent files still gets safe (non-negative) elapsed timing', async () => {
  const root = path.join(fixtureRoot, 'case-partial-agent-files');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_partial');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"onlyjsonl","label":"planner","phase":"Plan"}\n');
  await writeFile(path.join(runDir, 'agent-onlyjsonl.jsonl'), '{}');
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_partial', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  const t = model.labels.planner;
  assert.ok(t.startedAtMs !== null);
  assert.ok(t.lastEventAtMs !== null);
  assert.ok(t.elapsedMs !== null && t.elapsedMs >= 0);
});

test('synthetic: empty journal.jsonl (0 events) -> empty labels/nodes, active false, but run activity window still populated from the file itself', async () => {
  const root = path.join(fixtureRoot, 'case-empty-journal');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_empty');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '');
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_empty', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.deepStrictEqual(model.labels, {});
  assert.deepStrictEqual(model.nodes, []);
  assert.strictEqual(model.active, false);
  assert.notStrictEqual(model.firstActivityMs, null);
  assert.notStrictEqual(model.lastActivityMs, null);
});

test('synthetic: planner still running (not done) yields an empty expected chain -- no premature chain/queued fabrication', async () => {
  const root = path.join(fixtureRoot, 'case-planner-running');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_plannerrunning');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}\n');
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_plannerrunning', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.deepStrictEqual(model.expectedLabels, []);
  assert.strictEqual(model.nodes.length, 1);
  assert.strictEqual(model.nodes[0].label, 'planner');
  assert.strictEqual(model.nodes[0].status, 'running');
});

test('synthetic: planner done but result.tasks malformed (missing / not an array / null) never fabricates a chain', async () => {
  const root = path.join(fixtureRoot, 'case-planner-malformed-tasks');
  for (const [name, resultJson] of [
    ['wf_no_tasks_key', '{"ambiguities":[]}'],
    ['wf_tasks_not_array', '{"tasks":"nope"}'],
    ['wf_tasks_null', '{"tasks":null}'],
  ]) {
    const runDir = path.join(root, 'sess1', 'subagents', 'workflows', name);
    await mkdir(runDir, { recursive: true });
    const lines = [
      '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}',
      `{"type":"result","key":"k1","agentId":"a1","result":${resultJson}}`,
    ];
    await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  }
  const runs = await reader.readGraphRuns(root);
  assert.strictEqual(runs.length, 3);
  for (const run of runs) {
    assert.deepStrictEqual(run.expectedLabels, [], `${run.workflowId} should have no derivable chain`);
  }
});

test('synthetic: a task with a non-string/empty id in planner.result.tasks is skipped, not fabricated as coder:undefined', async () => {
  const root = path.join(fixtureRoot, 'case-bad-task-id');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_badtaskid');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{"tasks":[{"id":"T1","description":"ok"},{"id":123,"description":"bad id type"},{"id":"","description":"empty id"},{"description":"missing id"}]}}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_badtaskid', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.deepStrictEqual(model.expectedLabels, ['planner', 'coder:T1', 'tester:T1', 'reviewer', 'security', 'validator']);
  assert.ok(!model.expectedLabels.some((l) => l.includes('undefined')));
});

test('synthetic: full chain derivation fills queued placeholders for not-yet-observed labels, in expected order', async () => {
  const root = path.join(fixtureRoot, 'case-full-chain-partial-progress');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_partialchain');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{"tasks":[{"id":"T1","description":"d"},{"id":"T2","description":"d"}]}}',
    '{"type":"started","key":"k2","agentId":"a2","label":"coder:T1","phase":"Build"}',
    '{"type":"result","key":"k2","agentId":"a2","result":{}}',
    '{"type":"started","key":"k3","agentId":"a3","label":"tester:T1","phase":"Build"}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_partialchain', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  const byLabel = Object.fromEntries(model.nodes.map((n) => [n.label, n.status]));
  assert.deepStrictEqual(byLabel, {
    planner: 'done',
    'coder:T1': 'done',
    'tester:T1': 'running',
    'coder:T2': 'queued',
    'tester:T2': 'queued',
    reviewer: 'queued',
    security: 'queued',
    validator: 'queued',
  });
  assert.deepStrictEqual(model.nodes.map((n) => n.label), ['planner', 'coder:T1', 'tester:T1', 'coder:T2', 'tester:T2', 'reviewer', 'security', 'validator']);
});

test('synthetic: multiple runs sort by lastActivityMs descending, and active can be zero, one, or more than one', async () => {
  const root = path.join(fixtureRoot, 'case-multi-run-sort-active');
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-06-01T00:00:00Z');
  const newest = new Date('2026-09-01T00:00:00Z');

  // Run A: inactive, oldest
  const dirA = path.join(root, 'sessA', 'subagents', 'workflows', 'wf_a');
  await mkdir(dirA, { recursive: true });
  await writeFile(path.join(dirA, 'journal.jsonl'), '{"type":"started","key":"k","agentId":"a","label":"planner","phase":"Plan"}\n{"type":"result","key":"k","agentId":"a","result":{}}\n');
  await utimes(path.join(dirA, 'journal.jsonl'), older, older);

  // Run B: active, newest
  const dirB = path.join(root, 'sessB', 'subagents', 'workflows', 'wf_b');
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirB, 'journal.jsonl'), '{"type":"started","key":"k","agentId":"a","label":"planner","phase":"Plan"}\n');
  await utimes(path.join(dirB, 'journal.jsonl'), newest, newest);

  // Run C: active, middle
  const dirC = path.join(root, 'sessC', 'subagents', 'workflows', 'wf_c');
  await mkdir(dirC, { recursive: true });
  await writeFile(path.join(dirC, 'journal.jsonl'), '{"type":"started","key":"k","agentId":"a","label":"coder:T1","phase":"Build"}\n');
  await utimes(path.join(dirC, 'journal.jsonl'), newer, newer);

  const runs = await reader.readGraphRuns(root);
  assert.strictEqual(runs.length, 3);
  assert.deepStrictEqual(runs.map((r) => r.workflowId), ['wf_b', 'wf_c', 'wf_a'], 'expected descending lastActivityMs order');
  const activeIds = runs.filter((r) => r.active).map((r) => r.workflowId).sort();
  assert.deepStrictEqual(activeIds, ['wf_b', 'wf_c']);
  assert.strictEqual(runs.find((r) => r.workflowId === 'wf_a').active, false);
});

test('synthetic: backlogItem is extracted from a plain-string transcript body and rejects an unexpanded ${backlogItem} literal', async () => {
  const root = path.join(fixtureRoot, 'case-backlog-extraction');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_backlog');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"pagent","label":"planner","phase":"Plan"}\n');
  // Real prompt body -- should be picked up.
  const realLine = JSON.stringify({ message: { role: 'user', content: 'Read the backlog item below.\n\nBacklog item: "Fix the widget frobnicator"\n\nDecompose it.' } });
  // Unexpanded template literal reaching here as a plain string (adversarial case beyond the array/tool_result one seen in real data).
  const literalLine = JSON.stringify({ message: { role: 'user', content: 'Backlog item: "${backlogItem}"' } });
  await writeFile(path.join(runDir, 'agent-pagent.jsonl'), [literalLine, realLine].join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_backlog', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.backlogItem, 'Fix the widget frobnicator');
});

test('synthetic: backlogItem scan falls back to non-priority agent-*.jsonl files when no planner/reviewer/security/validator label exists', async () => {
  const root = path.join(fixtureRoot, 'case-backlog-fallback');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_refutestyle');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"ragent","label":"refute:something","phase":"Refute"}\n');
  const realLine = JSON.stringify({ message: { role: 'user', content: 'Backlog item: "Refute-style fallback text"' } });
  await writeFile(path.join(runDir, 'agent-ragent.jsonl'), realLine);
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_refutestyle', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.backlogItem, 'Refute-style fallback text');
});

test('synthetic: backlogItem is null (never fabricated) when nothing matches anywhere', async () => {
  const root = path.join(fixtureRoot, 'case-backlog-none');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_nobacklog');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}\n');
  await writeFile(path.join(runDir, 'agent-a1.jsonl'), JSON.stringify({ message: { role: 'user', content: 'nothing relevant here' } }));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_nobacklog', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.backlogItem, null);
});

test('synthetic: validatorOutcome mirrors the validator result and is kept distinct from cycleOutcome (always null)', async () => {
  const root = path.join(fixtureRoot, 'case-validator-outcome');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_validator');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":"validator","phase":"Verify"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{"signed_off":false,"reason":"tests failed"}}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_validator', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.deepStrictEqual(model.validatorOutcome, { signed_off: false, reason: 'tests failed' });
  assert.strictEqual(model.cycleOutcome, null, 'validatorOutcome must never be aliased into cycleOutcome');
});

test('synthetic: a tester result with passed:false is "done", not "errored" -- distinct from an invocation crash', async () => {
  const root = path.join(fixtureRoot, 'case-negative-result-not-errored');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_negresult');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":"tester:T1","phase":"Build"}',
    '{"type":"result","key":"k1","agentId":"a1","result":{"task_id":"T1","passed":false,"output_tail":"assertion failed"}}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_negresult', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.labels['tester:T1'].status, 'done');
  assert.strictEqual(model.labels['tester:T1'].result.passed, false);
});

test('synthetic: a genuinely errored label (failed with no later retry) reports errored, distinct from queued/running/done', async () => {
  const root = path.join(fixtureRoot, 'case-real-error');
  const runDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_realerror');
  await mkdir(runDir, { recursive: true });
  const lines = [
    '{"type":"started","key":"k1","agentId":"a1","label":"coder:T1","phase":"Build"}',
    '{"type":"failed","key":"k1","agentId":"a1"}',
  ];
  await writeFile(path.join(runDir, 'journal.jsonl'), lines.join('\n'));
  const model = await reader.buildRunModel({ sessionId: 'sess1', workflowId: 'wf_realerror', runDir, journalPath: path.join(runDir, 'journal.jsonl') });
  assert.strictEqual(model.labels['coder:T1'].status, 'errored');
  assert.strictEqual(model.active, false, 'an errored-only run has nothing currently running');
});

test('synthetic: readGraphRuns never throws for one bad run dir among several good ones -- bad one is skipped, others still returned', async () => {
  const root = path.join(fixtureRoot, 'case-partial-failure-isolation');
  // A good run.
  const goodDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_good');
  await mkdir(goodDir, { recursive: true });
  await writeFile(path.join(goodDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}\n{"type":"result","key":"k1","agentId":"a1","result":{}}\n');
  // A run dir whose journal.jsonl is actually a directory, not a file, at the
  // deeper agent-file level -- forces a stat/read edge case elsewhere in the
  // pipeline without simply not-existing (statSafe already covers not-existing).
  const weirdDir = path.join(root, 'sess1', 'subagents', 'workflows', 'wf_weird');
  await mkdir(weirdDir, { recursive: true });
  await writeFile(path.join(weirdDir, 'journal.jsonl'), '{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}\n');
  await mkdir(path.join(weirdDir, 'agent-a1.jsonl')); // a directory where a file is expected
  const runs = await reader.readGraphRuns(root);
  const ids = runs.map((r) => r.workflowId).sort();
  assert.ok(ids.includes('wf_good'), 'the good run must still come back even if a sibling run is weird');
});
