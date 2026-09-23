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
