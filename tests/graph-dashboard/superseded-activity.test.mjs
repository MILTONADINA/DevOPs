// specs/ops/dashboard-superseded-activity.md AC-1..4.
// Only owned files and explicitly rooted discovery; no live server or HOME discovery.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/graph-dashboard/server.mjs');
// BEGIN READER MATERIALIZER
const READER_START = '// Run model reader (T2)';
const READER_END = '// Route handlers (GET-only, read-only -- see the header note above)';
const SEPARATOR = '// ---------------------------------------------------------------------------';
const MODULE_PREFIX = 'import { readFile, readdir, stat } from "node:fs/promises";\nimport * as path from "node:path";\n\n';
const MODULE_SUFFIX = '\nexport { readGraphRuns };\n';
function materializeReader(source) {
  assert.equal(source.split(READER_START).length, 2, 'reader start marker must be unique');
  assert.equal(source.split(READER_END).length, 2, 'reader end marker must be unique');
  const start = source.indexOf(READER_START), end = source.indexOf(READER_END);
  assert.ok(start >= 0 && end > start, 'reader markers must be ordered');
  const sectionStart = source.lastIndexOf('\n', start) + 1;
  const sectionEnd = source.lastIndexOf(SEPARATOR, end);
  assert.ok(sectionEnd > sectionStart && sectionEnd < end);
  const section = source.slice(sectionStart, sectionEnd);
  for (const declaration of ['function buildLabelStates(', 'async function buildRunModel(',
    'async function computeLabelTiming(', 'async function readJournalEvents(',
    'async function readRunRecords(', 'async function readGraphRuns(']) {
    assert.equal(section.split(declaration).length, 2, `missing/duplicate declaration: ${declaration}`);
  }
  for (const forbidden of ['http.createServer', 'server.listen', 'requestHandler']) {
    assert.ok(!section.includes(forbidden), `reader extraction contains bootstrap: ${forbidden}`);
  }
  return MODULE_PREFIX + section + MODULE_SUFFIX;
}
// END READER MATERIALIZER

let owned, reader, sourceBytes;
before(async () => {
  sourceBytes = readFileSync(SOURCE);
  const moduleBody = materializeReader(sourceBytes.toString('utf8'));
  const state = path.join(ROOT, '.workflow/state');
  assert.ok(lstatSync(state).isDirectory(), 'owned project state prerequisite is missing');
  owned = mkdtempSync(path.join(state, 'dashboard-superseded-fixture-'));
  try {
    const modulePath = path.join(owned, 'reader.mjs');
    writeFileSync(modulePath, moduleBody, { flag: 'wx' });
    reader = await import(pathToFileURL(modulePath).href);
    assert.deepEqual(Object.keys(reader), ['readGraphRuns']);
  } catch (error) {
    rmSync(owned, { recursive: true, force: true });
    assert.equal(existsSync(owned), false);
    owned = undefined;
    throw error;
  }
});
after(() => {
  try {
    if (sourceBytes) assert.deepEqual(readFileSync(SOURCE), sourceBytes, 'reader source changed');
  } finally {
    if (owned) {
      rmSync(owned, { recursive: true, force: true });
      assert.equal(existsSync(owned), false, 'owned fixture cleanup failed');
    }
  }
});

const SECONDS = 2000;
const MTIME = SECONDS * 1000;
const FRESH_NOW = MTIME + 1000;
const OLD_NOW = MTIME + 30 * 60 * 1000;
const THREE_HOURS_LATER = MTIME + 3 * 60 * 60 * 1000 + 1000;
function put(file, text) {
  writeFileSync(file, text, { flag: 'wx' });
  utimesSync(file, SECONDS, SECONDS);
  assert.equal(statSync(file).mtimeMs, MTIME, 'whole-second fixture mtime prerequisite failed');
}
function snapshot(directory) {
  const entries = [];
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix + name, file = path.join(dir, name), stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'unexpected fixture symlink');
      if (stat.isDirectory()) { entries.push([relative, 'directory']); visit(file, relative + '/'); }
      else { assert.ok(stat.isFile()); entries.push([relative, 'file', readFileSync(file).toString('base64')]); }
    }
  }
  visit(directory); return entries;
}
async function fixture(name, work) {
  const root = mkdtempSync(path.join(owned, name + '-'));
  const f = { root, journalRoot: path.join(root, 'journals'), stateDir: path.join(root, 'state') };
  f.cycles = path.join(f.stateDir, 'graph-cycles');
  try {
    mkdirSync(f.journalRoot); mkdirSync(f.cycles, { recursive: true });
    await work(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'owned case cleanup failed');
  }
}
function addRun(f, id, { timing = true, label = 'planner', terminal } = {}) {
  const runDir = path.join(f.journalRoot, 'owned-session', 'subagents', 'workflows', id);
  mkdirSync(runDir, { recursive: true });
  const events = [{ type: 'started', key: 'k', agentId: 'A', label, phase: 'Verify' }];
  if (terminal) events.push({ ...terminal, key: 'k', agentId: 'A' });
  put(path.join(runDir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (timing) {
    put(path.join(runDir, 'agent-A.jsonl'), '{}\n');
    put(path.join(runDir, 'agent-A.meta.json'), '{}\n');
  }
}
function addRecord(f, cycleId, record) {
  const dir = path.join(f.cycles, cycleId); mkdirSync(dir);
  put(path.join(dir, 'run.json'), JSON.stringify({ cycleId, ...record }) + '\n');
}
async function readRuns(f, now = FRESH_NOW) {
  const beforeFiles = snapshot(f.root);
  try { return await reader.readGraphRuns(f.journalRoot, { stateDir: f.stateDir, now }); }
  finally { assert.deepEqual(snapshot(f.root), beforeFiles, 'reader changed owned input paths/bytes'); }
}
function byId(runs, id) {
  const matches = runs.filter((run) => run.workflowId === id);
  assert.equal(matches.length, 1, 'expected exactly one owned run');
  return matches[0];
}
function assertNode(run, { status = 'running', result = null, timing = true, label = 'planner' } = {}) {
  assert.equal(run.nodes.length, 1); assert.deepEqual(run.nodes[0], run.labels[label]);
  const node = run.nodes[0];
  assert.deepEqual({ label: node.label, status: node.status, phase: node.phase,
    key: node.key, agentId: node.agentId, result: node.result },
  { label, status, phase: 'Verify', key: 'k', agentId: 'A', result });
  assert.equal(node.lastEventAtMs, timing ? MTIME : null);
  if (!timing) { assert.equal(node.startedAtMs, null); assert.equal(node.elapsedMs, null); }
  assert.equal(run.firstActivityMs, MTIME); assert.equal(run.lastActivityMs, MTIME);
  assert.deepEqual(run.expectedLabels, []); assert.equal(run.backlogItem, null);
  assert.equal(run.sessionId, 'owned-session'); assert.equal(run.cycleOutcome, null);
}
function assertSameEvidence(actual, unjoined, cycleId, state = 'superseded') {
  assert.equal(actual.observed, true); assert.equal(actual.cycleId, cycleId);
  assert.equal(actual.state, state); assert.equal(actual.kind, 'sprint');
  // Independent unjoined observation of the same input bytes supplies every
  // preserved field; only record projections and active are excluded here.
  const fields = ['active', 'observed', 'cycleId', 'state', 'kind'];
  const stable = (model) => Object.fromEntries(Object.entries(model).filter(([key]) => !fields.includes(key)));
  assert.deepEqual(stable(actual), stable(unjoined), 'joining changed existing node/timing/result evidence');
}

test('dashboard superseded: resumed predecessors are inactive with fresh timing', async () => {
  for (const timing of [true, false]) {
    await fixture('resumed', async (f) => {
      addRun(f, 'wf_old', { timing });
      const baseline = byId(await readRuns(f), 'wf_old');
      assertNode(baseline, { timing }); assert.equal(baseline.active, true);
      addRecord(f, 'cycle', { runId: 'wf_current', resumedFrom: 'wf_old', status: 'running' });
      const run = byId(await readRuns(f), 'wf_old');
      assertSameEvidence(run, baseline, 'cycle'); assertNode(run, { timing });
      assert.equal(run.active, false, 'a selected superseded predecessor is not active');
    });
  }
});

test('dashboard superseded: accumulated predecessors are inactive while the replacement stays active', async () => {
  for (const timing of [true, false]) {
    await fixture('prior', async (f) => {
      addRun(f, 'wf_A', { timing }); addRun(f, 'wf_B'); addRun(f, 'wf_C');
      const baseline = await readRuns(f);
      addRecord(f, 'cycle', { runId: 'wf_C', resumedFrom: 'wf_B', priorRunIds: ['wf_A', 'wf_B'], status: 'running' });
      const runs = await readRuns(f); assert.equal(runs.length, 3);
      const current = byId(runs, 'wf_C');
      assertSameEvidence(current, byId(baseline, 'wf_C'), 'cycle', 'running');
      assertNode(current); assert.equal(current.active, true);
      for (const id of ['wf_A', 'wf_B']) {
        const run = byId(runs, id);
        assertSameEvidence(run, byId(baseline, id), 'cycle');
        assertNode(run, { timing: id === 'wf_A' ? timing : true });
        assert.equal(run.active, false, 'an accumulated superseded predecessor is not active');
      }
    });
  }
});

test('dashboard superseded: missing agent timing never keeps an earlier run active', async () => {
  for (const reference of [{ resumedFrom: 'wf_old' }, { priorRunIds: ['wf_old'] }]) {
    await fixture('no-timing', async (f) => {
      addRun(f, 'wf_old', { timing: false });
      const baseline = byId(await readRuns(f, THREE_HOURS_LATER), 'wf_old');
      assertNode(baseline, { timing: false }); assert.equal(baseline.active, true);
      addRecord(f, 'cycle', { runId: 'wf_current', status: 'running', ...reference });
      const run = byId(await readRuns(f, THREE_HOURS_LATER), 'wf_old');
      assertSameEvidence(run, baseline, 'cycle'); assertNode(run, { timing: false });
      assert.equal(run.active, false, 'missing timing does not override selected supersession');
    });
  }
});

test('dashboard superseded: direct running records win in both directory orders', async () => {
  for (const field of ['resumedFrom', 'priorRunIds']) {
    for (const directFirst of [false, true]) {
      await fixture('precedence', async (f) => {
        addRun(f, 'wf_live');
        const baseline = byId(await readRuns(f), 'wf_live');
        const direct = directFirst ? 'a-direct' : 'z-direct';
        const reference = directFirst ? 'z-reference' : 'a-reference';
        addRecord(f, reference, { runId: 'wf_other', status: 'failed',
          [field]: field === 'priorRunIds' ? ['wf_live'] : 'wf_live' });
        addRecord(f, direct, { runId: 'wf_live', status: 'running' });
        const expectedOrder = directFirst ? [direct, reference] : [reference, direct];
        assert.deepEqual(await readdir(f.cycles), expectedOrder, 'directory-order prerequisite failed');
        const run = byId(await readRuns(f), 'wf_live');
        assertSameEvidence(run, baseline, direct, 'running'); assertNode(run);
        assert.equal(run.active, true, 'the selected direct record remains active');
      });
    }
  }
});

test('dashboard superseded: old stale nodes and matching terminal evidence remain intact', async () => {
  await fixture('old-stale', async (f) => {
    addRun(f, 'wf_old');
    const baseline = byId(await readRuns(f, OLD_NOW), 'wf_old');
    assertNode(baseline, { status: 'stale' }); assert.equal(baseline.active, false);
    addRecord(f, 'cycle', { runId: 'wf_new', resumedFrom: 'wf_old', status: 'running' });
    const run = byId(await readRuns(f, OLD_NOW), 'wf_old');
    assertSameEvidence(run, baseline, 'cycle'); assertNode(run, { status: 'stale' });
    assert.equal(run.active, false);
  });
  for (const terminal of [{ type: 'result', result: { passed: true } },
    { type: 'result', result: { passed: false } }, { type: 'result', result: null },
    { type: 'result' }, { type: 'failed' }]) {
    await fixture('terminal', async (f) => {
      addRun(f, 'wf_old', { label: 'validator', terminal });
      const baseline = byId(await readRuns(f), 'wf_old');
      const expectedResult = terminal.result ?? null;
      const status = terminal.type === 'failed' ? 'errored' : 'done';
      assertNode(baseline, { label: 'validator', status, result: expectedResult });
      assert.equal(baseline.active, false); assert.deepEqual(baseline.validatorOutcome, expectedResult);
      addRecord(f, 'cycle', { runId: 'wf_new', priorRunIds: ['wf_old'], status: 'running' });
      const run = byId(await readRuns(f), 'wf_old');
      assertSameEvidence(run, baseline, 'cycle');
      assertNode(run, { label: 'validator', status, result: expectedResult });
      assert.equal(run.active, false); assert.deepEqual(run.validatorOutcome, expectedResult);
    });
  }
});

test('dashboard superseded: unrelated statuses and existing age policies retain activity', async () => {
  await fixture('current', async (f) => {
    addRun(f, 'wf_live'); addRecord(f, 'cycle', { runId: 'wf_live', status: 'running' });
    for (const now of [FRESH_NOW, OLD_NOW]) {
      const run = byId(await readRuns(f, now), 'wf_live');
      assert.equal(run.state, 'running'); assertNode(run); assert.equal(run.active, true);
    }
    const old = byId(await readRuns(f, THREE_HOURS_LATER), 'wf_live');
    assertNode(old, { status: 'stale' }); assert.equal(old.active, false);
  });
  for (const [label, kind] of [['planner', 'sprint'], ['refute:owned', 'workflow']]) {
    await fixture('unrecorded', async (f) => {
      addRun(f, 'wf_unrecorded', { label });
      const fresh = byId(await readRuns(f), 'wf_unrecorded');
      assertNode(fresh, { label }); assert.equal(fresh.active, true);
      assert.equal(fresh.observed, false); assert.equal(fresh.cycleId, null);
      assert.equal(fresh.state, 'NOT_OBSERVED'); assert.equal(fresh.kind, kind);
      const old = byId(await readRuns(f, OLD_NOW), 'wf_unrecorded');
      assertNode(old, { label, status: 'stale' }); assert.equal(old.active, false);
    });
  }
  for (const status of ['Superseded', 'superseded ', 'failed', 'completed', null]) {
    await fixture('exact-status', async (f) => {
      addRun(f, 'wf_live'); addRecord(f, 'cycle', { runId: 'wf_live', status });
      const run = byId(await readRuns(f), 'wf_live');
      assert.equal(run.state, status ?? 'UNKNOWN'); assertNode(run); assert.equal(run.active, true);
    });
  }
  await fixture('completed', async (f) => {
    addRun(f, 'wf_done', { terminal: { type: 'result', result: { passed: false } } });
    addRecord(f, 'cycle', { runId: 'wf_done', status: 'completed' });
    const run = byId(await readRuns(f), 'wf_done');
    assert.equal(run.state, 'completed'); assertNode(run, { status: 'done', result: { passed: false } });
    assert.equal(run.active, false); assert.equal(run.validatorOutcome, null);
  });
});
