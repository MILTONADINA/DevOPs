// verification/reproducibility-check.ts must run as a CLI under the package's ESM
// setting and print the hash the claim validator recomputes (verification/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const run = (...args) => spawnSync('tsx', ['verification/reproducibility-check.ts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('prints the validator hash for a commit and a command with no environment block', () => {
  const r = run('abc123', 'echo hi');
  assert.equal(r.status, 0, r.stderr);
  const expected = 'sha256:' + createHash('sha256').update('echo hi\n---\n\n---\nabc123').digest('hex');
  assert.equal(r.stdout.trim(), expected);
});

test('exits 1 with a usage line when arguments are missing', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: reproducibility-check <git_sha> "<command>"/);
});

test('prints the hash when invoked by an absolute path through a symlinked directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repro-link-'));
  try {
    const link = path.join(dir, 'repo');
    symlinkSync(ROOT, link);
    const r = spawnSync('tsx', [path.join(link, 'verification', 'reproducibility-check.ts'), 'abc123', 'echo hi'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^sha256:[0-9a-f]{64}$/, 'a symlinked invocation must not silently print nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
