// specs/ops/dashboard-attempt-identity.md AC-1..4.
// Owned arrays/files only. No live server import, HTTP, HOME or journal discovery.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/graph-dashboard/server.mjs');
// BEGIN READER MATERIALIZER
const READER_START = '// Run model reader (T2)';
const READER_END = '// Route handlers (GET-only, read-only -- see the header note above)';
const SEPARATOR = '// ---------------------------------------------------------------------------';
const MODULE_PREFIX = 'import { readFile, readdir, stat } from "node:fs/promises";\nimport * as path from "node:path";\n\n';
const MODULE_SUFFIX = '\nexport { buildLabelStates, buildRunModel };\n';
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
    'async function computeLabelTiming(', 'async function readJournalEvents(']) {
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
  owned = mkdtempSync(path.join(state, 'dashboard-attempt-fixture-'));
  try {
    const modulePath = path.join(owned, 'reader.mjs');
    writeFileSync(modulePath, moduleBody, { flag: 'wx' });
    // Only declarations/literal constants in the reviewed reader section load.
    // Neither the live server nor its original home-discovering tests are imported.
    reader = await import(pathToFileURL(modulePath).href);
    assert.deepEqual(Object.keys(reader).sort(), ['buildLabelStates', 'buildRunModel']);
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

const start = (key, agentId, label = 'tester:T1', phase = 'Build') =>
  ({ type: 'started', key, agentId, label, phase });
const terminal = (type, key, agentId, result = { superseded: true }) =>
  type === 'result' ? { type, key, agentId, result } : { type, key, agentId };
const running = (key, agentId, label = 'tester:T1', phase = 'Build') =>
  ({ label, status: 'running', phase, key, agentId, result: null });
function reduce(events) {
  const beforeEvents = structuredClone(events);
  try { return reader.buildLabelStates(events); }
  finally { assert.deepEqual(events, beforeEvents, 'reader mutated supplied event data'); }
}
function snapshot(directory) {
  const result = [];
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, file = path.join(dir, entry.name);
      const stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, 'unexpected fixture symlink');
      if (stat.isDirectory()) { result.push([relative, 'directory']); visit(file, relative + '/'); }
      else { assert.ok(stat.isFile()); result.push([relative, 'file', readFileSync(file).toString('base64')]); }
    }
  }
  visit(directory); return result;
}
async function readModelUnchanged(args) {
  const beforeFiles = snapshot(owned);
  try { return await reader.buildRunModel(args); }
  finally { assert.deepEqual(snapshot(owned), beforeFiles, 'model read changed owned input paths/bytes'); }
}

test('dashboard attempts: stale agent terminals leave a running retry unchanged', () => {
  for (const type of ['result', 'failed']) {
    const states = reduce([start('k', 'A'), start('k', 'B'), terminal(type, 'k', 'A')]);
    assert.deepEqual(states.get('tester:T1'), running('k', 'B'), type);
    assert.equal(states.size, 1);
  }
});

test('dashboard attempts: stale agent terminals cannot overwrite a completed retry', () => {
  const current = { task_id: 'T1', passed: false, attempt: 'B' };
  for (const type of ['result', 'failed']) {
    const states = reduce([start('k', 'A'), start('k', 'B'),
      terminal('result', 'k', 'B', current), terminal(type, 'k', 'A')]);
    assert.deepEqual(states.get('tester:T1'), { ...running('k', 'B'), status: 'done', result: current }, type);
  }
  for (const type of ['result', 'failed']) {
    const states = reduce([start('k', 'A'), start('k', 'B'),
      terminal('failed', 'k', 'B'), terminal(type, 'k', 'A')]);
    assert.deepEqual(states.get('tester:T1'), { ...running('k', 'B'), status: 'errored' }, type);
  }

});

test('dashboard attempts: an old key cannot target the replacement label with the same agent', () => {
  // Current start admission permits this identity reuse; it is not a native-chronology claim.
  for (const type of ['result', 'failed']) {
    const states = reduce([start('old', 'same'), start('new', 'same', 'tester:T1', 'Verify'),
      terminal(type, 'old', 'same')]);
    assert.deepEqual(states.get('tester:T1'), running('new', 'same', 'tester:T1', 'Verify'), type);
  }
  for (const [oldKey, currentKey] of [[1, '1'], ['1', 1]]) {
    for (const type of ['result', 'failed']) {
      const states = reduce([start(oldKey, 'same'), start(currentKey, 'same'),
        terminal(type, oldKey, 'same')]);
      assert.deepEqual(states.get('tester:T1'), running(currentKey, 'same'), `strict key: ${type}`);
    }
  }

});

test('dashboard attempts: an unknown agent terminal on the current key is ignored', () => {
  for (const type of ['result', 'failed']) {
    const states = reduce([start('k', 'current'), terminal(type, 'k', 'unknown')]);
    assert.deepEqual(states.get('tester:T1'), running('k', 'current'), type);
  }
  for (const [currentAgent, terminalAgent] of [[1, '1'], ['1', 1]]) {
    for (const type of ['result', 'failed']) {
      const states = reduce([start('k', currentAgent), terminal(type, 'k', terminalAgent)]);
      assert.deepEqual(states.get('tester:T1'), running('k', currentAgent), `strict agent: ${type}`);
    }
  }

});

test('dashboard attempts: matching terminals retain result null failure and negative-proof semantics', () => {
  for (const result of [{ passed: true }, { passed: false }, null]) {
    const states = reduce([start('k', 'A'), terminal('result', 'k', 'A', result)]);
    assert.deepEqual(states.get('tester:T1'), { ...running('k', 'A'), status: 'done', result });
  }
  const absent = reduce([start('k', 'A'), { type: 'result', key: 'k', agentId: 'A' }]);
  assert.deepEqual(absent.get('tester:T1'), { ...running('k', 'A'), status: 'done' });
  const failed = reduce([start('k', 'A'), terminal('failed', 'k', 'A')]);
  assert.deepEqual(failed.get('tester:T1'), { ...running('k', 'A'), status: 'errored' });
});

test('dashboard attempts: normal retries orphan handling and permissive start policy remain compatible', () => {
  const result = { attempt: 'B' };
  const retried = reduce([start('k', 'A'), terminal('failed', 'k', 'A'), start('k', 'B'), terminal('result', 'k', 'B', result)]);
  assert.deepEqual(retried.get('tester:T1'), { ...running('k', 'B'), status: 'done', result });
  assert.equal(reduce([terminal('result', 'unseen', 'A'), terminal('failed', 'other', 'B')]).size, 0);
  assert.equal(reduce([start('bad', 'A', 123), terminal('result', 'bad', 'A')]).size, 0);
  const names = reduce([start('k1', 'A', 'coder:1'), start('k2', 'B', 'coder:T1')]);
  assert.deepEqual([...names.keys()], ['coder:1', 'coder:T1']);
  const repeated = reduce([start('k', 'A'), terminal('result', 'k', 'A', { first: true }),
    terminal('failed', 'k', 'A'), terminal('result', 'k', 'A', { last: true })]);
  assert.deepEqual(repeated.get('tester:T1'), { ...running('k', 'A'), status: 'done', result: { last: true } });
  for (const identity of [{}, { key: null, agentId: null }]) {
    const states = reduce([{ type: 'started', label: 'legacy', phase: 42, ...identity },
      { type: 'result', result: { retained: true }, ...identity }]);
    assert.deepEqual(states.get('legacy'), {
      label: 'legacy', status: 'done', phase: null,
      key: identity.key, agentId: identity.agentId, result: { retained: true },
    });
  }
});

test('dashboard attempts: the model retains current validator timing and outcome after a stale result', async () => {
  const runDir = path.join(owned, 'model-run'); mkdirSync(runDir);
  const journalPath = path.join(runDir, 'journal.jsonl');
  const events = [start('v', 'A', 'validator', 'Verify'), start('v', 'B', 'validator', 'Verify'),
    terminal('result', 'v', 'A', { signed_off: true, reason: 'old attempt' })];
  writeFileSync(journalPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const A_SECONDS = 1000, B_SECONDS = 2000, NOW = 2001 * 1000;
  for (const [agentId, seconds] of [['A', A_SECONDS], ['B', B_SECONDS]]) {
    for (const suffix of ['jsonl', 'meta.json']) {
      const file = path.join(runDir, `agent-${agentId}.${suffix}`);
      writeFileSync(file, '{}\n'); utimesSync(file, seconds, seconds);
      assert.equal(statSync(file).mtimeMs, seconds * 1000, 'whole-second fixture mtime prerequisite failed');
    }
  }
  const args = { sessionId: 'owned-session', workflowId: 'owned-run', runDir, journalPath, record: null, now: NOW };
  const first = await readModelUnchanged(args);
  const current = first.labels.validator;
  assert.equal(current.agentId, 'B'); assert.equal(current.key, 'v');
  assert.equal(current.status, 'running'); assert.equal(current.result, null);
  assert.equal(current.lastEventAtMs, B_SECONDS * 1000);
  assert.equal(first.nodes.length, 1); assert.deepEqual(first.nodes[0], current);
  assert.equal(first.active, true); assert.equal(first.validatorOutcome, null);
  assert.equal(first.cycleOutcome, null); assert.equal(first.state, 'NOT_OBSERVED');
  const result = { signed_off: false, reason: 'current attempt' };
  appendFileSync(journalPath, JSON.stringify(terminal('result', 'v', 'B', result)) + '\n');
  const second = await readModelUnchanged(args);
  assert.equal(second.labels.validator.agentId, 'B'); assert.equal(second.labels.validator.status, 'done');
  assert.equal(second.labels.validator.lastEventAtMs, B_SECONDS * 1000);
  assert.equal(second.active, false); assert.deepEqual(second.validatorOutcome, result);
  assert.equal(second.cycleOutcome, null);
});
