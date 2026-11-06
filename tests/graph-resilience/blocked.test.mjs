import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

// Regression tests for consumer-graph reports #275-#278. Each runs the real script inside a
// synthetic toy project, so the layout matches a consumer checkout: no .workflow/ directory yet,
// a missing evidence file, or a project path that goes through a symlink.
const blockedFlags = ['--cycle', 'c7', '--stage', 'tester', '--task', 'T3', '--class', 'environment', '--checks', 'git.runs'];
const withoutGraphEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GRAPH_')) delete env[key];
  return env;
};
function toyBlockedProject() {
  const toy = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-blocked-toy-'));
  mkdirSync(path.join(toy, 'scripts'));
  copyFileSync(path.join(ROOT, 'scripts', 'graph-blocked.sh'), path.join(toy, 'scripts', 'graph-blocked.sh'));
  return toy;
}
const runBlocked = (script, args, cwd) => spawnSync('bash', [script, ...args], { cwd, env: withoutGraphEnv(), encoding: 'utf8' });

test('regression #277: the blocked record is written in a toy project with no .workflow directory', () => {
  const toy = toyBlockedProject();
  try {
    const evidence = path.join(toy, 'error.txt');
    writeFileSync(evidence, 'git: You have not agreed to the Xcode license agreements\n');
    const result = runBlocked(path.join(toy, 'scripts', 'graph-blocked.sh'), [...blockedFlags, '--evidence-file', evidence], toy);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.match(readFileSync(path.join(toy, '.workflow', 'state', 'blocked.md'), 'utf8'), /^## Class\nenvironment$/m);
  } finally { rmSync(toy, { recursive: true, force: true }); }
});

test('regression #278: a project reached through a symlink still records its blocked record', () => {
  const toy = toyBlockedProject();
  const link = `${toy}-link`;
  try {
    mkdirSync(path.join(toy, '.workflow', 'state'), { recursive: true });
    writeFileSync(path.join(toy, 'error.txt'), 'git: You have not agreed to the Xcode license agreements\n');
    symlinkSync(toy, link);
    const result = runBlocked(path.join(link, 'scripts', 'graph-blocked.sh'), [...blockedFlags, '--evidence-file', path.join(link, 'error.txt')], link);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(toy, '.workflow', 'state', 'blocked.md'), 'utf8'), /You have not agreed to the Xcode license/);
  } finally {
    rmSync(link, { force: true });
    rmSync(toy, { recursive: true, force: true });
  }
});

test('regression #275: a missing evidence file is recorded as missing, not as an uncaught ENOENT', () => {
  const toy = toyBlockedProject();
  try {
    mkdirSync(path.join(toy, '.workflow', 'state'), { recursive: true });
    const result = runBlocked(path.join(toy, 'scripts', 'graph-blocked.sh'), [...blockedFlags, '--evidence-file', path.join(toy, 'never-written.txt')], toy);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.match(readFileSync(path.join(toy, '.workflow', 'state', 'blocked.md'), 'utf8'), /Evidence file not found/);
  } finally { rmSync(toy, { recursive: true, force: true }); }
});

test('the blocked writer creates nothing outside the project root when an ancestor is a symlink out of it', () => {
  const toy = toyBlockedProject();
  const outside = mkdtempSync(path.join(tmpdir(), 'graph-blocked-outside-'));
  try {
    symlinkSync(outside, path.join(toy, '.workflow'));
    const result = runBlocked(path.join(toy, 'scripts', 'graph-blocked.sh'), blockedFlags, toy);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /leaves the project root/);
    assert.equal(existsSync(path.join(outside, 'state')), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(toy, { recursive: true, force: true });
  }
});
