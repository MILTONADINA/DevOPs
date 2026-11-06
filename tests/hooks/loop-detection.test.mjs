// hooks/universal/pre-tool/loop-detection.sh fails closed on an empty tool
// name (exit 2, the only status Claude Code treats as blocking), lets a normal
// call through and still halts a repeated call past its threshold (#355).
// Runs in a disposable directory with its own tracking file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'loop-detection.sh');

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-detection-'));
  try {
    const run = (...args) => {
      const result = spawnSync('bash', [HOOK, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, DEVOPS_LOOP_THRESHOLD: '2', DEVOPS_LOOP_TRACKING: path.join(dir, 'tracking.jsonl'), DEVOPS_SESSION_ID: 'toy' },
      });
      assert.equal(result.error, undefined, String(result.error));
      return result;
    };
    fn(run);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('an empty tool name halts with exit 2 and says a name is required', () => {
  withDir(run => {
    const result = run('');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /loop-detection\.sh: tool name required/);
  });
});

test('a missing tool name argument halts with exit 2', () => {
  withDir(run => assert.equal(run().status, 2));
});

test('a normal call is allowed', () => {
  withDir(run => {
    const result = run('Bash', 'ls');
    assert.equal(result.status, 0, result.stderr);
  });
});

test('the same call past the threshold still halts with exit 2', () => {
  withDir(run => {
    const statuses = [1, 2, 3, 4].map(() => run('Bash', 'ls').status);
    assert.equal(statuses[0], 0);
    assert.ok(statuses.includes(2), `expected a halt, got ${statuses.join(',')}`);
  });
});
