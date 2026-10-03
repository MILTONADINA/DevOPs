// specs/graph/proof-inputs.md REQ-1..7 / AC-1..6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, symlinkSync, realpathSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'graph-proof-inputs.mjs');
const SENTINEL = 'owned-input-must-not-appear-in-diagnostics';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

function tree(directory) {
  return readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...tree(file)];
    if (stat.isSymbolicLink()) return [[file, 'symlink']];
    return [[file, hash(readFileSync(file))]];
  });
}

function fixture() {
  assert.ok(existsSync(SCRIPT), 'FEATURE_ABSENT: graph-proof-inputs.mjs is not implemented');
  const state = path.join(ROOT, '.workflow', 'state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'proof-inputs-')));
  const repo = path.join(outer, 'project');
  const runPath = path.join(repo, 'inputs', 'run.json');
  const journalPath = path.join(repo, 'inputs', 'wf_fixture', 'journal.jsonl');
  const sentinelPath = path.join(repo, 'command-side-effect');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  mkdirSync(path.dirname(journalPath), { recursive: true });
  copyFileSync(SCRIPT, path.join(repo, 'scripts', 'graph-proof-inputs.mjs'));
  const command = `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'executed')`)}; $(echo inert)\n# ${SENTINEL}`;
  const record = { schema_version: 1, cycleId: 'cycle_9', runId: 'wf_fixture', args: { cycleId: 'cycle_9' }, journalPath,
    status: 'completed', unrelated: SENTINEL };
  const events = [{ type: 'launched' }];
  const metadata = new Map();
  const role = (label, phase, result) => {
    const key = `key${metadata.size}`;
    const agentId = `agent${metadata.size}`;
    metadata.set(label, { key, agentId, phase });
    events.push({ type: 'started', key, agentId, label, phase }, { type: 'result', key, agentId, result });
  };
  role('preflight', 'Preflight', { status: 'ready' });
  role('planner', 'Plan', { tasks: [{ id: 'T1', description: SENTINEL }, { id: '1' }] });
  // Journal order differs from plan order; raw T1 and 1 must remain distinct.
  for (const id of ['1', 'T1']) {
    role(`coder:${id}`, 'Build', { task_id: id, passed: false, unrelated: SENTINEL });
    role(`tester:${id}`, 'Build', { task_id: id, passed: false, outcome: 'FAIL',
      proof: { command: id === 'T1' ? command : 'inert second declaration', exit_code: id === 'T1' ? 1 : 0, unrelated: SENTINEL } });
  }
  role('reviewer', 'Verify', { approved: false, unrelated: SENTINEL });
  role('security', 'Verify', { passed: false, scans: [
    { tool: 'semgrep', command: 'inert scan one', exit_code: 1, scanned_files: 0, unrelated: SENTINEL },
    { tool: 'other_tool', command: 'inert scan two', exit_code: 0, scanned_files: 2 },
  ], unrelated: SENTINEL });
  role('validator', 'Verify', { signed_off: false, unrelated: SENTINEL });
  writeFileSync(runPath, JSON.stringify(record, null, 2) + '\n');
  writeFileSync(journalPath, lines(events));
  return {
    repo, outer, runPath, journalPath, sentinelPath, record, events, metadata,
    saveRun() { writeFileSync(runPath, JSON.stringify(record, null, 2) + '\n'); },
    saveJournal() { writeFileSync(journalPath, lines(events)); },
    result(label) { return events.find((event) => event.type === 'result' && event.key === metadata.get(label).key).result; },
    removeRole(label) {
      const key = metadata.get(label).key;
      for (let i = events.length - 1; i >= 0; i--) if (events[i].key === key) events.splice(i, 1);
    },
    invoke(args = ['--run', runPath, '--journal', journalPath], cwd = repo) {
      const before = tree(outer);
      const result = spawnSync(process.execPath, [path.join(repo, 'scripts', 'graph-proof-inputs.mjs'), ...args], {
        cwd, env: { PATH: '', HOME: repo, LANG: 'C' }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.deepEqual(tree(outer), before, 'reader must not mutate inputs or create files');
      assert.equal(existsSync(sentinelPath), false, 'recorded commands must remain inert');
      return result;
    },
    cleanup() { rmSync(outer, { recursive: true, force: true }); },
  };
}

function withFixture(run) {
  const f = fixture();
  try { run(f); } finally { f.cleanup(); }
}
function accepted(result, f) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), ['schema_version', 'cycleId', 'runId', 'run_sha256', 'journal_sha256', 'tester_proofs', 'security_scans', 'verification'].sort());
  assert.equal(output.schema_version, 1);
  assert.equal(output.cycleId, f.record.cycleId);
  assert.equal(output.runId, f.record.runId);
  assert.equal(output.verification, 'not_run');
  assert.equal(output.run_sha256, hash(readFileSync(f.runPath)));
  assert.equal(output.journal_sha256, hash(readFileSync(f.journalPath)));
  assert.doesNotMatch(JSON.stringify(output), /"(?:unrelated|description|status|outcome|readyForPR|passed|journalPath)"\s*:/);
  return output;
}
function refused(result, code) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `graph-proof-inputs: ${code}\n`);
  assert.doesNotMatch(result.stderr, new RegExp(SENTINEL));
}
function mutationCase(name, mutate, code) {
  test(name, () => withFixture((f) => {
    mutate(f);
    f.saveRun();
    f.saveJournal();
    refused(f.invoke(), code);
  }));
}

test('extracts only inert declarations in plan order with exact raw-byte hashes', () => withFixture((f) => {
  writeFileSync(f.journalPath, '\r\n' + lines(f.events).replaceAll('\n', '\r\n') + '  \r\n');
  const output = accepted(f.invoke(), f);
  assert.notEqual(output.run_sha256, hash(Buffer.from(JSON.stringify(f.record))));
  assert.notEqual(output.journal_sha256, hash(Buffer.from(JSON.stringify(f.events))));
  assert.deepEqual(output.tester_proofs, ['T1', '1'].map((id) => {
    const proof = f.result(`tester:${id}`).proof;
    return { task_id: id, command: proof.command, exit_code: proof.exit_code };
  }));
  assert.deepEqual(output.security_scans, f.result('security').scans.map(({ tool, command, exit_code, scanned_files }) => ({ tool, command, exit_code, scanned_files })));
}));

test('relative paths resolve from the script project root, either named-option order', () => withFixture((f) => {
  accepted(f.invoke(['--journal', 'inputs/wf_fixture/journal.jsonl', '--run', 'inputs/run.json'], f.outer), f);
}));

for (const [name, args] of [
  ['missing options', []], ['missing value', ['--run']],
  ['duplicate option', ['--run', 'inputs/run.json', '--run', 'inputs/run.json', '--journal', 'inputs/wf_fixture/journal.jsonl']],
  ['unknown option', ['--run', 'inputs/run.json', '--journal', 'inputs/wf_fixture/journal.jsonl', '--execute', 'true']],
  ['extra positional value', ['--run', 'inputs/run.json', '--journal', 'inputs/wf_fixture/journal.jsonl', 'extra']],
]) test(`CLI refuses ${name}`, () => withFixture((f) => refused(f.invoke(args), 'USAGE')));

for (const kind of ['missing', 'directory']) test(`refuses ${kind} input`, () => withFixture((f) => {
  rmSync(f.runPath);
  if (kind === 'directory') mkdirSync(f.runPath);
  refused(f.invoke(), 'INPUT_FILE');
}));

for (const kind of ['lexical escape', 'external symlink', 'internal symlink']) test(`refuses ${kind} without reading an operator file`, () => withFixture((f) => {
  const target = path.join(kind === 'internal symlink' ? f.repo : f.outer, 'owned-target.json');
  writeFileSync(target, readFileSync(f.runPath));
  if (kind === 'lexical escape') refused(f.invoke(['--run', '../owned-target.json', '--journal', f.journalPath]), 'INPUT_PATH');
  else {
    rmSync(f.runPath);
    symlinkSync(target, f.runPath);
    refused(f.invoke(), 'INPUT_PATH');
  }
}));

test('parent-directory symlink refuses with otherwise valid bound inputs', () => withFixture((f) => {
  const inputs = path.join(f.repo, 'inputs');
  const target = path.join(f.outer, 'owned-inputs');
  renameSync(inputs, target);
  symlinkSync(target, inputs);
  refused(f.invoke(), 'INPUT_PATH');
}));

for (const input of ['runPath', 'journalPath']) test(`invalid UTF-8 in ${input} is refused`, () => withFixture((f) => {
  writeFileSync(f[input], Buffer.from([0xff, 0x0a]));
  refused(f.invoke(), 'INPUT_ENCODING');
}));

test('exact file byte limits are inclusive', () => withFixture((f) => {
  const rawRun = readFileSync(f.runPath);
  writeFileSync(f.runPath, Buffer.concat([rawRun, Buffer.alloc(262144 - rawRun.length, 0x20)]));
  let journal = readFileSync(f.journalPath, 'utf8');
  let remaining = 8388608 - Buffer.byteLength(journal, 'utf8');
  while (remaining > 0) {
    const padding = remaining > 262144 ? ' '.repeat(262144) + '\n' : ' '.repeat(remaining);
    journal += padding;
    remaining -= Buffer.byteLength(padding, 'utf8');
  }
  writeFileSync(f.journalPath, journal);
  assert.equal(readFileSync(f.runPath).length, 262144);
  assert.equal(readFileSync(f.journalPath).length, 8388608);
  accepted(f.invoke(), f);
}));

for (const [input, limit] of [['runPath', 262144], ['journalPath', 8388608]]) test(`${input} one byte above the file limit refuses`, () => withFixture((f) => {
  writeFileSync(f[input], Buffer.alloc(limit + 1, 0x20));
  refused(f.invoke(), 'INPUT_LIMIT');
}));

test('exact journal line-byte and physical-line limits are inclusive', () => withFixture((f) => {
  const raw = lines(f.events) + ' '.repeat(262144) + '\n';
  const count = raw.split('\n').length - 1;
  writeFileSync(f.journalPath, raw + '\n'.repeat(10000 - count));
  accepted(f.invoke(), f);
}));

for (const kind of ['line bytes', 'line count']) test(`journal above ${kind} limit refuses`, () => withFixture((f) => {
  const raw = lines(f.events);
  writeFileSync(f.journalPath, kind === 'line bytes' ? raw + ' '.repeat(262145) : raw + '\n'.repeat(10001 - (raw.split('\n').length - 1)));
  refused(f.invoke(), 'INPUT_LIMIT');
}));

for (const value of [null, []]) test(`run ${JSON.stringify(value)} is not a record object`, () => withFixture((f) => {
  writeFileSync(f.runPath, JSON.stringify(value));
  refused(f.invoke(), 'RUN_RECORD');
}));

for (const [name, mutate, code] of [
  ['missing args object', (f) => { delete f.record.args; }, 'RUN_RECORD'],
  ['schema version', (f) => { f.record.schema_version = '1'; }, 'RUN_RECORD'],
  ['invalid cycle identifier', (f) => { f.record.cycleId = '../bad'; }, 'RUN_RECORD'],
  ['missing run identifier', (f) => { delete f.record.runId; }, 'RUN_RECORD'],
  ['args cycle mismatch', (f) => { f.record.args.cycleId = 'other'; }, 'RUN_BINDING'],
  ['journal binding mismatch', (f) => { f.record.journalPath = path.join(f.outer, SENTINEL); }, 'RUN_BINDING'],
  ['run-directory mismatch', (f) => { f.record.runId = 'different_run'; }, 'RUN_BINDING'],
]) mutationCase(name, mutate, code);

for (const field of ['resumedFrom', 'priorRunIds']) mutationCase(`top-level ${field} presence refuses even when null`, (f) => { f.record[field] = null; }, 'RESUME_UNSUPPORTED');
for (const field of ['resumedFrom', 'priorRunIds', 'plan', 'priorBuildResults', 'priorCoderResults']) mutationCase(`args ${field} presence refuses even when empty`, (f) => { f.record.args[field] = []; }, 'RESUME_UNSUPPORTED');

for (const [input, code] of [['runPath', 'RUN_JSON'], ['journalPath', 'JOURNAL_JSON']]) test(`malformed ${input} never leaks the parser excerpt`, () => withFixture((f) => {
  writeFileSync(f[input], '{' + SENTINEL);
  refused(f.invoke(), code);
}));

for (const [name, mutate, code] of [
  ['empty journal', (f) => { f.events.length = 0; }, 'JOURNAL_ORDER'],
  ['missing launch', (f) => { f.events.shift(); }, 'JOURNAL_ORDER'],
  ['duplicate launch', (f) => { f.events.push({ type: 'launched' }); }, 'JOURNAL_ORDER'],
  ['non-object native event', (f) => { f.events.push(null); }, 'JOURNAL_EVENT'],
  ['missing native key', (f) => { delete f.events[1].key; }, 'JOURNAL_EVENT'],
  ['wrong-type native key', (f) => { f.events[1].key = 1; }, 'JOURNAL_EVENT'],
  ['missing native agent', (f) => { delete f.events[1].agentId; }, 'JOURNAL_EVENT'],
  ['wrong-type native agent', (f) => { f.events[1].agentId = []; }, 'JOURNAL_EVENT'],
  ['missing native phase', (f) => { delete f.events[1].phase; }, 'JOURNAL_EVENT'],
  ['wrong-type native phase', (f) => { f.events[1].phase = false; }, 'JOURNAL_EVENT'],
  ['native ASCII control', (f) => { f.events[1].key = 'bad\u0000key'; }, 'JOURNAL_EVENT'],
  ['unknown event', (f) => { f.events.push({ type: 'workflow_result', readyForPR: true }); }, 'JOURNAL_EVENT'],
  ['extra native field', (f) => { f.events[0].extra = SENTINEL; }, 'JOURNAL_EVENT'],
  ['terminal before start', (f) => { f.events.splice(1, 0, { ...f.events[2] }); }, 'JOURNAL_ORDER'],
  ['duplicate terminal', (f) => { f.events.push({ ...f.events.at(-1) }); }, 'JOURNAL_ORDER'],
  ['duplicate start for one agent', (f) => { f.events.push({ ...f.events[1] }); }, 'JOURNAL_ORDER'],
  ['same key with another label', (f) => { f.events.push({ ...f.events[1], agentId: 'new_agent', label: 'security' }); }, 'JOURNAL_BINDING'],
  ['same label with another key', (f) => { f.events.push({ ...f.events[1], key: 'new_key', agentId: 'new_agent' }); }, 'JOURNAL_BINDING'],
  ['agent reused by a different label', (f) => { f.events.push({ ...f.events.find((event) => event.label === 'reviewer'), agentId: f.events[1].agentId }); }, 'JOURNAL_BINDING'],
  ['missing current preflight', (f) => { f.removeRole('preflight'); }, 'ROLE_INCOMPLETE'],
  ['missing tester', (f) => { f.removeRole('tester:T1'); }, 'ROLE_INCOMPLETE'],
  ['unknown role label', (f) => { f.events.find((event) => event.label === 'reviewer').label = 'other_role'; }, 'ROLE_INCOMPLETE'],
  ['unplanned task label', (f) => { f.events.find((event) => event.label === 'tester:T1').label = 'tester:unknown'; }, 'ROLE_INCOMPLETE'],
  ['non-object current result', (f) => { f.events.at(-1).result = null; }, 'ROLE_INCOMPLETE'],
  ['duplicate planned ID', (f) => { f.result('planner').tasks.push({ id: 'T1' }); }, 'PLAN_INVALID'],
  ['invalid planned ID', (f) => { f.result('planner').tasks[0].id = '../bad'; }, 'PLAN_INVALID'],
  ['empty plan', (f) => { f.result('planner').tasks = []; }, 'PLAN_INVALID'],
  ['coder task mismatch', (f) => { f.result('coder:T1').task_id = '1'; }, 'ROLE_INCOMPLETE'],
  ['tester task mismatch', (f) => { f.result('tester:T1').task_id = '1'; }, 'ROLE_INCOMPLETE'],
]) mutationCase(name, mutate, code);

function retry(f, { terminal = 'result', stale = false } = {}) {
  const { key, agentId, phase } = f.metadata.get('tester:T1');
  const result = structuredClone(f.result('tester:T1'));
  result.proof.command = 'inert replacement declaration';
  f.events.push({ type: 'started', key, agentId: 'retry_agent', label: 'tester:T1', phase });
  if (terminal) f.events.push({ type: terminal, key, agentId: stale ? agentId : 'retry_agent', ...(terminal === 'result' ? { result } : {}) });
}

test('failed attempt followed by fresh current retry selects only the new result', () => withFixture((f) => {
  const index = f.events.findIndex((event) => event.type === 'result' && event.key === f.metadata.get('tester:T1').key);
  const prior = f.events[index];
  retry(f);
  f.events[index] = { type: 'failed', key: prior.key, agentId: prior.agentId };
  f.saveJournal();
  const output = accepted(f.invoke(), f);
  assert.equal(output.tester_proofs[0].command, 'inert replacement declaration');
}));

for (const [name, options, code] of [
  ['in-flight retry', { terminal: null }, 'ROLE_INCOMPLETE'],
  ['failed retry', { terminal: 'failed' }, 'ROLE_INCOMPLETE'],
  ['stale old-agent result after retry', { stale: true }, 'JOURNAL_BINDING'],
]) mutationCase(name, (f) => retry(f, options), code);

for (const [name, mutate] of [
  ['legacy tester fields without proof', (f) => { const r = f.result('tester:T1'); r.command = 'legacy'; r.exit_code = 0; delete r.proof; }],
  ['blank command', (f) => { f.result('tester:T1').proof.command = ' \n '; }],
  ['oversized command', (f) => { f.result('tester:T1').proof.command = 'x'.repeat(8193); }],
  ['noninteger exit code', (f) => { f.result('tester:T1').proof.exit_code = 0.5; }],
  ['out-of-range exit code', (f) => { f.result('tester:T1').proof.exit_code = 256; }],
  ['negative tester exit code', (f) => { f.result('tester:T1').proof.exit_code = -1; }],
  ['string tester exit code', (f) => { f.result('tester:T1').proof.exit_code = '0'; }],
  ['missing scans', (f) => { delete f.result('security').scans; }],
  ['malformed scans container', (f) => { f.result('security').scans = {}; }],
  ['malformed scan declaration', (f) => { f.result('security').scans[0] = null; }],
  ['empty scans', (f) => { f.result('security').scans = []; }],
  ['unsafe tool name', (f) => { f.result('security').scans[0].tool = '../scanner'; }],
  ['oversized tool name', (f) => { f.result('security').scans[0].tool = 'x'.repeat(65); }],
  ['negative declared scan count', (f) => { f.result('security').scans[0].scanned_files = -1; }],
  ['unsafe integer declared count', (f) => { f.result('security').scans[0].scanned_files = Number.MAX_SAFE_INTEGER + 1; }],
]) mutationCase(name, mutate, 'DECLARATION_INVALID');

test('declaration maxima remain inert and are accepted inclusively', () => withFixture((f) => {
  f.result('tester:T1').proof.command = 'x'.repeat(8192);
  f.result('tester:T1').proof.exit_code = 255;
  Object.assign(f.result('security').scans[0], { tool: 'x'.repeat(64), exit_code: 255, scanned_files: Number.MAX_SAFE_INTEGER });
  f.saveJournal();
  const output = accepted(f.invoke(), f);
  assert.equal(output.tester_proofs[0].command.length, 8192);
  assert.equal(output.tester_proofs[0].exit_code, 255);
  assert.equal(output.security_scans[0].scanned_files, Number.MAX_SAFE_INTEGER);
}));
