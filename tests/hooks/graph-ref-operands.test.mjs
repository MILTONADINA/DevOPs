// REQ-M16: push destination namespaces and mutation option operands.
// Command strings are hook argv data, never executed as pushes/tags/signing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) {
  if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
}
function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-ref-operands-')));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function assertProcess(result) { assert.equal(result.error, undefined); assert.equal(result.signal, null); }
function hook(dir, name, command) {
  const result = spawnSync('bash', [path.join(ROOT, 'hooks/universal/pre-tool', name), command], {
    cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
  });
  assertProcess(result);
  return result;
}
function assertNoAuthority(dir) {
  for (const name of ['graph-cycles', 'graph-approvals', 'graph-halt']) {
    assert.equal(existsSync(path.join(dir, '.workflow/state', name)), false, `fixture must not acquire ${name}`);
  }
}
function stageRefs(dir) {
  const result = spawnSync('bash', [path.join(import.meta.dirname, 'fixtures/stage-hook-refs.sh'), dir], {
    cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
  });
  assertProcess(result); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^TOPLEVEL=(.*)$/m)?.[1], dir);
  assert.deepEqual(result.stdout.match(/^REFS_BEGIN\n([\s\S]*?)\nREFS_END$/m)?.[1].split('\n'), [
    'refs/heads/both', 'refs/heads/branch-only', 'refs/heads/feature',
    'refs/tags/both', 'refs/tags/release-candidate', 'refs/tags/tag-only', 'refs/tags/v1.0.0',
  ]);
  // The complete ref list proves tag-only is a source tag and feature is a
  // local branch with no same-named tag; it says nothing about remote names.
}

for (const [refspec, expected] of [
  ['refs/tags/tag-only:feature', 2], ['HEAD:feature', 2], [':feature', 2],
  ['feature', 0], ['HEAD:refs/heads/feature', 0], ['refs/tags/tag-only:refs/heads/feature', 0],
]) {
  test(`AC-M16.1 push destination requires explicit namespace when a colon is present: ${refspec}`, () => {
    withProject((dir) => {
      stageRefs(dir); assertNoAuthority(dir);
      const refs = ['refs/heads/feature', 'refs/tags/tag-only'].map((ref) => path.join(dir, '.git', ref));
      const before = refs.map((file) => readFileSync(file, 'utf8'));
      const result = hook(dir, 'deploy-gate.sh', `git push origin ${refspec}`);
      assert.equal(result.status, expected, result.stderr);
      if (expected === 2) {
        assert.match(result.stderr, /DEPLOY-GATE BLOCK/);
        assert.match(result.stderr, /deploy authority|running cycle/, 'refuse because the gated push has no cycle/approval, not a broken helper');
      }
      assertNoAuthority(dir);
      assert.deepEqual(refs.map((file) => readFileSync(file, 'utf8')), before, 'classification never changes local refs');
    });
  });
}

for (const [command, expected] of [
  ['git tag -f -u fixture-key v0.2.0', 2], ['git tag -fam note v0.2.0', 2],
  ['git tag -f ordinary v0.2.0', 0], ['git tag -f -m v0.2.0 ordinary', 0],
]) {
  test(`AC-M16.1 sealed mutation parsing distinguishes option values, destination and source: ${command}`, () => {
    withProject((dir) => {
      assertNoAuthority(dir);
      const result = hook(dir, 'block-sealed-refs.sh', command);
      assert.equal(result.status, expected, result.stderr);
      if (expected === 2) {
        assert.match(result.stderr, /SEALED-REF BLOCK/);
        assert.doesNotMatch(result.stderr, /graph-command-classifier\.mjs.*invalid decision/);
      }
      assertNoAuthority(dir);
      assert.equal(existsSync(path.join(dir, '.git')), false, 'tag/signing command text is never executed');
      assert.equal(existsSync(path.join(dir, 'fixture-key')), false);
    });
  });
}

for (const [hookName, command] of [
  ['deploy-gate.sh', 'env -- GIT_DIR=other git push origin feature'],
  ['block-sealed-refs.sh', 'env -- FIXTURE=1 git tag -d v0.2.0'],
]) {
  test(`AC-M16.1 env option terminator still preserves assignment and command recognition: ${command}`, () => {
    withProject((dir) => {
      stageRefs(dir); assertNoAuthority(dir);
      const result = hook(dir, hookName, command);
      assert.equal(result.status, 2, result.stderr);
      assert.doesNotMatch(result.stderr, /graph-command-classifier\.mjs.*invalid decision/);
      if (hookName === 'deploy-gate.sh') {
        assert.match(result.stderr, /DEPLOY-GATE BLOCK/);
        assert.match(result.stderr, /deploy authority|running cycle/);
      } else {
        assert.match(result.stderr, /SEALED-REF BLOCK/);
        const events = readFileSync(path.join(dir, '.workflow/state/events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(events.length, 1);
        assert.equal(events[0].event, 'sealed_ref_block');
        assert.equal(events[0].ref, 'refs/tags/v0.2.0', 'recognize the actual sealed target after env assignments');
        assert.equal(events[0].command, command);
      }
      assertNoAuthority(dir);
      assert.equal(existsSync(path.join(dir, 'other')), false, 'env command remains data; no alternate Git directory is created');
    });
  });
}
