// Mechanical checks for specs/graph/R-resilience.md REQ-R4, REQ-R7, REQ-R9, REQ-R10 (launch record) and
// specs/graph/M-masterpiece-standard.md REQ-M7's static clauses. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const workflow = read('.claude', 'workflows', 'sprint-cycle.js').replace('export const meta =', 'const meta =');
const sprintCommand = read('slash-commands', 'universal', 'sprint.md');

async function run(agent) {
  const execute = new AsyncFunction('args', 'agent', 'log', 'phase', workflow);
  return execute({ backlogItem: 'toy backlog item', cycleId: 'c1' }, agent, () => {}, () => {});
}

test('REQ-R4: the first agent call is a low-effort preflight role that runs the JSON preflight', async () => {
  const calls = [];
  await assert.rejects(run(async (prompt, options) => {
    calls.push({ prompt, options });
    return { status: 'ready', check_ids: [] };
  }));
  assert.equal(calls[0].options.label, 'preflight');
  assert.equal(calls[0].options.effort, 'low');
  assert.match(calls[0].prompt, /scripts\/graph-preflight\.sh --json/);
});

for (const status of ['needs_human', 'error']) {
  test(`REQ-R4: preflight status ${status} throws BLOCKED_BY_ENVIRONMENT naming the checks before the planner`, async () => {
    const labels = [];
    await assert.rejects(run(async (_, options) => {
      labels.push(options.label);
      return { status, check_ids: ['toy.check'] };
    }), (error) => {
      assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/);
      assert.deepEqual(JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length)).check_ids, ['toy.check']);
      return true;
    });
    assert.deepEqual(labels, ['preflight']);
  });
}

test('REQ-R4: /sprint runs the preflight first and refuses launch on exit 20 or 2, printing the block path', () => {
  const before = sprintCommand.indexOf('## Before running');
  assert.ok(before >= 0);
  const step = sprintCommand.slice(before, sprintCommand.indexOf('2. Check', before));
  assert.match(step, /1\. Run `bash scripts\/graph-preflight\.sh` before calling Workflow/);
  assert.match(step, /exit 20 or 2 refuses launch/);
  assert.match(step, /Print\s+the block path/);
});

test('REQ-R7: every role schema carries the optional blocked_by_environment object', () => {
  const schemas = workflow.match(/\bschema:/g).length;
  const carriers = workflow.match(/blocked_by_environment: BLOCKED_SCHEMA/g).length;
  assert.ok(schemas >= 6, 'preflight, planner, coder, tester, reviewer, security and validator roles');
  assert.equal(carriers, schemas);
  assert.doesNotMatch(workflow, /required: \[[^\]]*blocked_by_environment/);
});

test('REQ-R7: ENVIRONMENT RULES point at the preflight and the blocked writer, and precede STALL RULES', () => {
  const rules = /const ENVIRONMENT_RULES = `([^`]*)`/.exec(workflow)[1];
  assert.match(rules, /^ENVIRONMENT RULES:/);
  assert.match(rules, /scripts\/graph-preflight\.sh/);
  assert.match(rules, /scripts\/graph-blocked\.sh/);
  assert.match(rules, /blocked_by_environment/);
  assert.match(rules, /set passed: false/);
  const stall = workflow.indexOf('STALL RULES (');
  assert.ok(stall > 0);
  const lastEnvironmentUse = workflow.lastIndexOf('${ENVIRONMENT_RULES}', stall);
  assert.ok(lastEnvironmentUse > 0 && lastEnvironmentUse < stall);
});

test('REQ-R9: the blocked record keeps the first 20 evidence lines, names the API fix and is gitignored', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-req-r9-'));
  try {
    const evidence = path.join(dir, 'error.txt');
    writeFileSync(evidence, Array.from({ length: 25 }, (_, i) => `toy line ${i + 1}`).join('\n'));
    const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'graph-blocked.sh'),
      '--cycle', 'c9', '--stage', 'coder', '--class', 'api', '--checks', 'toy.api', '--evidence-file', evidence],
    { cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const record = readFileSync(path.join(dir, 'blocked.md'), 'utf8');
    assert.match(record, /toy line 20\b/);
    assert.doesNotMatch(record, /toy line 21\b/);
    assert.match(record, /## Fix\nnone needed — resumes when the API is back/);
    assert.match(record, /## Resume\n\/sprint --resume c9/);
    assert.match(record, /## Run record\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const ignore = read('.gitignore').split('\n').map((line) => line.trim());
  assert.ok(ignore.includes('.workflow/state/*'));
  assert.ok(!ignore.some((line) => line.startsWith('!') && line.includes('blocked.md')));
});

test('REQ-R9: /sprint writes the block record after catching BLOCKED_BY_ENVIRONMENT, even when agent() returned null', () => {
  assert.match(sprintCommand, /throws `BLOCKED_BY_ENVIRONMENT:`[\s\S]*run `bash scripts\/graph-blocked\.sh`/);
  assert.match(sprintCommand, /even when `agent\(\)` returned null, so the block record exists before\s+the session reports the fault/);
});

test('REQ-M7: the planner schema types conflicts as {higher, lower, clause} and AGENTS.md carries the precedence line', () => {
  const start = workflow.indexOf('conflicts: {\n          type: \'array\'');
  assert.ok(start > 0);
  const block = workflow.slice(start, workflow.indexOf('blocked_by_environment', start));
  assert.match(block, /properties: \{ higher: \{ type: 'string' \}, lower: \{ type: 'string' \}, clause: \{ type: 'string' \} \}/);
  assert.match(block, /required: \['higher', 'lower', 'clause'\]/);
  const lines = read('AGENTS.md').split('\n').filter((line) => line.includes('owner decision > law/safety > approved spec > ADR/AC > plan > code'));
  assert.equal(lines.length, 1);
});

// Resolve HEAD from the ref files (a linked worktree has a .git file), as run-record.test.mjs does,
// because tests/hermeticity.test.mjs forbids spawning git for something a read can answer.
function readHead() {
  let gitDir = path.join(ROOT, '.git');
  if (!statSync(gitDir).isDirectory()) gitDir = path.resolve(ROOT, /^gitdir:\s*(.+)$/.exec(readFileSync(gitDir, 'utf8').trim())[1]);
  const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const symbolic = /^ref:\s*(\S+)/.exec(head);
  if (!symbolic) return head;
  const commonFile = path.join(gitDir, 'commondir');
  const common = existsSync(commonFile) ? path.resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
  const loose = path.join(common, symbolic[1]);
  if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
  const packed = readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n').find((line) => line.endsWith(` ${symbolic[1]}`));
  return packed.split(' ')[0];
}

test('REQ-R10: launch writes run.json with the documented fields at launch', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-req-r10-'));
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: readHead(), ran_at: new Date().toISOString() }));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'graph-run-record.mjs'), 'launch', '--cycle', 'c10', '--backlog', 'toy backlog item'],
      { cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(path.join(dir, 'graph-cycles', 'c10', 'run.json'), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['args', 'backlogItem', 'cycleId', 'journalPath', 'runId', 'schema_version', 'scriptPath', 'startedAt', 'status']);
    assert.equal(record.status, 'running');
    assert.equal(record.schema_version, 1);
    assert.equal(record.scriptPath, path.join(ROOT, '.claude', 'workflows', 'sprint-cycle.js'));
    assert.deepEqual(record.args, { backlogItem: 'toy backlog item', cycleId: 'c10' });
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
