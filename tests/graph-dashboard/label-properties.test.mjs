// specs/ops/dashboard-label-properties.md AC-1..4.
// Synthetic data and explicitly owned reader inputs only; no live-server import.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/graph-dashboard/server.mjs');
// BEGIN READER MATERIALIZER
const READER_START = '// Run model reader (T2)';
const READER_END = '// Route handlers (GET-only, read-only -- see the header note above)';
const SEPARATOR = '// ---------------------------------------------------------------------------';
const MODULE_PREFIX = 'import { readFile, readdir, stat } from "node:fs/promises";\nimport * as path from "node:path";\n\n';
const MODULE_SUFFIX = '\nexport { buildLabelStates, labelStatesToObject, readGraphRuns };\n';
function materializeReader(source) {
  assert.equal(source.split(READER_START).length, 2, 'reader start marker must be unique');
  assert.equal(source.split(READER_END).length, 2, 'reader end marker must be unique');
  const start = source.indexOf(READER_START), end = source.indexOf(READER_END);
  assert.ok(start >= 0 && end > start, 'reader markers must be ordered');
  const sectionStart = source.lastIndexOf('\n', start) + 1;
  const sectionEnd = source.lastIndexOf(SEPARATOR, end);
  assert.ok(sectionEnd > sectionStart && sectionEnd < end);
  const section = source.slice(sectionStart, sectionEnd);
  for (const declaration of ['function buildLabelStates(', 'function labelStatesToObject(',
    'async function buildRunModel(', 'async function computeLabelTiming(',
    'async function readJournalEvents(', 'async function readRunRecords(', 'async function readGraphRuns(']) {
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
  owned = mkdtempSync(path.join(state, 'dashboard-label-fixture-'));
  try {
    const modulePath = path.join(owned, 'reader.mjs');
    writeFileSync(modulePath, moduleBody, { flag: 'wx' });
    reader = await import(pathToFileURL(modulePath).href);
    assert.deepEqual(Object.keys(reader), ['buildLabelStates', 'labelStatesToObject', 'readGraphRuns']);
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

const start = (label, key = 'k', agentId = 'A') => ({ type: 'started', key, agentId, label, phase: 'Verify' });
function projectUnchanged(states) {
  const references = [...states], content = structuredClone(references);
  const descriptors = references.map(([, value]) => Object.getOwnPropertyDescriptors(value));
  let projected;
  try { projected = reader.labelStatesToObject(states); }
  finally {
    assert.deepEqual([...states], content, 'projection mutated Map or state content');
    assert.equal(states.size, references.length);
    for (const [index, [label, value]] of references.entries()) {
      assert.equal(states.get(label), value, 'projection replaced input state identity');
      assert.deepEqual(Object.getOwnPropertyDescriptors(value), descriptors[index]);
    }
  }
  return projected;
}
function ownData(object, label, value) {
  assert.deepEqual(Object.getOwnPropertyDescriptor(object, label),
    { value, writable: true, enumerable: true, configurable: true });
  assert.equal(object[label], value, 'projected value must be the exact Map state');
}
function snapshot(directory) {
  const entries = [];
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix + name, file = path.join(dir, name), info = lstatSync(file);
      assert.equal(info.isSymbolicLink(), false, 'unexpected fixture symlink');
      if (info.isDirectory()) { entries.push([relative, 'directory']); visit(file, relative + '/'); }
      else { assert.ok(info.isFile()); entries.push([relative, 'file', readFileSync(file).toString('base64')]); }
    }
  }
  visit(directory); return entries;
}

test('dashboard labels: proto-name projection retains own data and the last matching state', () => {
  const variants = [
    { terminals: [], status: 'running', result: null },
    { terminals: [{ type: 'result', result: { passed: false } }], status: 'done', result: { passed: false } },
    { terminals: [{ type: 'failed' }], status: 'errored', result: null },
    { terminals: [{ type: 'failed' }, { type: 'result', result: null }], status: 'done', result: null },
  ];
  for (const variant of variants) {
    const events = [start('__proto__'), ...variant.terminals.map((event) => ({ ...event, key: 'k', agentId: 'A' }))];
    const states = reader.buildLabelStates(events), state = states.get('__proto__');
    const expected = { label: '__proto__', status: variant.status, phase: 'Verify', key: 'k', agentId: 'A', result: variant.result };
    assert.deepEqual(state, expected); assert.deepEqual([...states.keys()], ['__proto__']);
    const labels = projectUnchanged(states);
    assert.equal(Object.hasOwn(labels, '__proto__'), true, 'raw proto-name label must be an own property');
    assert.equal(Object.getPrototypeOf(labels), Object.prototype);
    assert.deepEqual(Object.keys(labels), ['__proto__']); ownData(labels, '__proto__', state);
    assert.equal(JSON.stringify(labels), '{"__proto__":' + JSON.stringify(expected) + '}');
    const decoded = JSON.parse(JSON.stringify(labels));
    assert.equal(Object.hasOwn(decoded, '__proto__'), true); assert.deepEqual(decoded.__proto__, expected);
  }
});

test('dashboard labels: the owned model serializes every observed raw label without changing nodes', async () => {
  const fixture = mkdtempSync(path.join(owned, 'model-'));
  try {
    const journalRoot = path.join(fixture, 'journals'), stateDir = path.join(fixture, 'state');
    const runDir = path.join(journalRoot, 'owned-session', 'subagents', 'workflows', 'wf_owned');
    mkdirSync(runDir, { recursive: true }); mkdirSync(stateDir);
    const events = [start('__proto__', 'proto-key', 'P'), start('validator', 'validator-key', 'V'),
      { type: 'result', key: 'validator-key', agentId: 'V', result: { passed: false } }];
    const journal = path.join(runDir, 'journal.jsonl');
    writeFileSync(journal, events.map((event) => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx' });
    utimesSync(journal, 2000, 2000); assert.equal(statSync(journal).mtimeMs, 2000000);
    const beforeFiles = snapshot(fixture); let runs;
    try { runs = await reader.readGraphRuns(journalRoot, { stateDir, now: 2001000 }); }
    finally { assert.deepEqual(snapshot(fixture), beforeFiles, 'reader changed owned input paths/bytes'); }
    assert.equal(runs.length, 1); const model = runs[0];
    const expectedNodes = [
      { label: '__proto__', status: 'running', phase: 'Verify', key: 'proto-key', agentId: 'P', result: null,
        startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
      { label: 'validator', status: 'done', phase: 'Verify', key: 'validator-key', agentId: 'V', result: { passed: false },
        startedAtMs: null, lastEventAtMs: null, elapsedMs: null },
    ];
    assert.deepEqual(model.nodes, expectedNodes); assert.deepEqual(model.expectedLabels, []);
    assert.equal(model.active, true); assert.equal(model.kind, 'workflow');
    assert.equal(model.observed, false); assert.equal(model.state, 'NOT_OBSERVED'); assert.equal(model.cycleId, null);
    assert.equal(model.cycleOutcome, null); assert.deepEqual(model.validatorOutcome, { passed: false });
    assert.equal(model.firstActivityMs, 2000000); assert.equal(model.lastActivityMs, 2000000);
    assert.equal(model.backlogItem, null); assert.equal(model.workflowId, 'wf_owned');
    assert.equal(Object.hasOwn(model.labels, '__proto__'), true, 'serialized model must retain the admitted raw label');
    assert.equal(Object.getPrototypeOf(model.labels), Object.prototype);
    assert.deepEqual(Object.keys(model.labels), ['__proto__', 'validator']);
    ownData(model.labels, '__proto__', model.nodes[0]); ownData(model.labels, 'validator', model.nodes[1]);
    const expectedJSON = '{"__proto__":' + JSON.stringify(expectedNodes[0]) + ',"validator":' + JSON.stringify(expectedNodes[1]) + '}';
    assert.equal(JSON.stringify(model.labels), expectedJSON);
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(model)).labels), expectedJSON);
  } finally {
    rmSync(fixture, { recursive: true, force: true }); assert.equal(existsSync(fixture), false);
  }
});

test('dashboard labels: ordinary empty inherited-name and numeric-key semantics stay compatible', () => {
  const empty = projectUnchanged(new Map());
  assert.deepEqual(empty, {}); assert.equal(Object.getPrototypeOf(empty), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(empty), []); assert.equal(JSON.stringify(empty), '{}');
  assert.notEqual(projectUnchanged(new Map()), empty, 'each projection returns a fresh object');
  const raw = ['constructor', '10', '2', 'toString', 'coder:1', 'coder:T1', '01', ''];
  const events = raw.map((label, index) => start(label, 'k' + index, 'A' + index));
  events.push({ type: 'result', key: 'k0', agentId: 'A0', result: { version: 1 } },
    { type: 'result', key: 'k0', agentId: 'A0', result: { version: 2 } },
    { type: 'result', key: 'k7', agentId: 'A7', result: { ignored: true } });
  const states = reader.buildLabelStates(events); assert.deepEqual([...states.keys()], raw);
  assert.deepEqual(states.get('constructor').result, { version: 2 });
  assert.equal(states.get('').status, 'running'); assert.equal(states.get('').result, null);
  const labels = projectUnchanged(states), keys = ['2', '10', 'constructor', 'toString', 'coder:1', 'coder:T1', '01', ''];
  assert.equal(Object.getPrototypeOf(labels), Object.prototype);
  assert.deepEqual(Object.keys(labels), keys); assert.deepEqual(Reflect.ownKeys(labels), keys);
  for (const label of keys) ownData(labels, label, states.get(label));
  const expectedJSON = '{' + keys.map((label) => JSON.stringify(label) + ':' + JSON.stringify(states.get(label))).join(',') + '}';
  assert.equal(JSON.stringify(labels), expectedJSON);
  assert.deepEqual(Object.keys(JSON.parse(expectedJSON)), keys);
  assert.equal(Object.hasOwn(labels, '__proto__'), false);
});
