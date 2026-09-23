import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('blocked record contains the prescribed recovery fields and audit events', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-blocked-test-'));
  try {
    const evidence = path.join(dir, 'error.txt');
    writeFileSync(evidence, 'git: You have not agreed to the Xcode license agreements\n');
    const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'graph-blocked.sh'),
      '--cycle', 'c7', '--stage', 'tester', '--task', 'T3', '--class', 'environment',
      '--checks', 'git.runs', '--evidence-file', evidence, '--fix', 'sudo xcodebuild -license accept'],
    { cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const record = readFileSync(path.join(dir, 'blocked.md'), 'utf8');
    const headings = [...record.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings, ['What happened', 'Class', 'Impact', 'Fix', 'Resume', 'Evidence', 'Run record']);
    assert.match(record, /\/sprint --resume c7/);
    assert.match(record, /git\.runs/);
    const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ['graph.blocked', 'graph.environment_fault']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocked writer rejects secret evidence paths before reading them', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-blocked-secret-test-'));
  try {
    const result = spawnSync('bash', [path.join(ROOT, 'scripts', 'graph-blocked.sh'),
      '--cycle', 'c7', '--stage', 'tester', '--class', 'environment',
      '--evidence-file', path.join(dir, '.env')],
    { cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret evidence file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('needs_human record names the human fix and marker removal before resume', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-blocked-human-test-'));
  const script = path.join(ROOT, 'scripts', 'graph-blocked.sh');
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  try {
    const missingFix = spawnSync('bash', [script, '--cycle', 'c7', '--stage', 'preflight',
      '--class', 'needs_human', '--checks', 'halt.absent'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.notEqual(missingFix.status, 0);
    assert.match(missingFix.stderr, /--fix/);
    const suppliedFix = spawnSync('bash', [script, '--cycle', 'c7', '--stage', 'preflight',
      '--class', 'needs_human', '--checks', 'halt.absent', '--fix', '/graph-resume'],
    { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(suppliedFix.status, 0, suppliedFix.stderr);
    const record = readFileSync(path.join(dir, 'blocked.md'), 'utf8');
    assert.match(record, /## Fix\n\/graph-resume\nrm -- \.workflow\/state\/blocked\.md/);
    assert.match(record, /## Resume\n\/sprint --resume c7/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
