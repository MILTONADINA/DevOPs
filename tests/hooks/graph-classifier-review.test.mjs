// REQ-M16: independent review regressions. Every proposed command stays argv data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-review-test-')));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(dir, hook, command) {
  const result = spawnSync('bash', [path.join(ROOT, 'hooks/universal/pre-tool', hook), command], {
    cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}

for (const command of [
  'git tag -d v0.2.0>out', 'git branch -D stratum-merge>out',
  'git update-ref --stdin', 'git push origin --mirror',
  'git push origin --tags --force', 'git push origin --all -f',
  'git push origin --follow-tags --force-with-lease',
  'command -p git tag -d v0.2.0', "env -S 'git tag -d v0.2.0'",
  'npx --package=git git tag -d v0.2.0',
]) {
  test(`AC-M16.1 recognized unsupported or ambiguous mutation refuses with a truthful event: ${command}`, () => {
    withProject((dir) => {
      const result = run(dir, 'block-sealed-refs.sh', command);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /SEALED-REF BLOCK/);
      assert.doesNotMatch(result.stderr, /graph-command-classifier\.mjs.*invalid decision/);
      const events = readFileSync(path.join(dir, '.workflow/state/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'sealed_ref_block'); assert.equal(events[0].command, command);
      assert.equal(events[0].ref, null, 'unknown target must not be invented as an exact protected identity');
      assert.equal(existsSync(path.join(dir, 'out')), false, 'classification never performs the proposed redirect');
    });
  });
}

for (const command of [
  "echo 'git tag -d v0.2.0>out'", "git tag -d 'v0.2.0>out'",
  'git tag -d refs/heads/stratum-merge', 'git tag -d refs/tags/v0.2.0',
  'git branch -D refs/tags/v0.2.0', 'git branch -D refs/heads/stratum-merge',
  'git push origin --tags', 'git push origin --follow-tags', 'git push origin --all',
  'command -- git status', 'env FIXTURE=1 git status', 'npx --no-install git status',
]) {
  test(`AC-M16.1 literal namespace and inert/bulk controls remain allowed by the sealed hook: ${command}`, () => {
    withProject((dir) => {
      const result = run(dir, 'block-sealed-refs.sh', command);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(path.join(dir, '.workflow/state/events.jsonl')), false);
      assert.equal(existsSync(path.join(dir, 'out')), false);
    });
  });
}

for (const command of [
  'GIT_DIR=other git push origin feature', 'GIT_WORK_TREE=other git push origin feature',
  'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=other git push origin feature',
]) {
  test(`AC-M16.1 inline Git routing/config cannot borrow the original project branch exception: ${command}`, () => {
    withProject((dir) => {
      const fixture = spawnSync('bash', [path.join(ROOT, 'tests/hooks/fixtures/stage-hook-refs.sh'), dir], {
        env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(fixture.error, undefined); assert.equal(fixture.signal, null); assert.equal(fixture.status, 0, fixture.stderr);
      assert.equal(fixture.stdout.match(/^TOPLEVEL=(.*)$/m)?.[1], dir);
      assert.match(fixture.stdout, /^refs\/heads\/feature$/m);
      assert.doesNotMatch(fixture.stdout, /^refs\/tags\/feature$/m);
      mkdirSync(path.join(dir, 'other'));
      const result = run(dir, 'deploy-gate.sh', command);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /DEPLOY-GATE BLOCK/);
      assert.equal(existsSync(path.join(dir, '.workflow/state/graph-cycles')), false);
    });
  });
}

for (const [command, ref] of [
  ['git tag -df ordinary v0.2.0', 'refs/tags/v0.2.0'],
  ['git branch -Df ordinary stratum-merge', 'refs/heads/stratum-merge'],
]) {
  test(`AC-M16.1 grouped deletion flags retain every target operand: ${command}`, () => {
    withProject((dir) => {
      const result = run(dir, 'block-sealed-refs.sh', command);
      assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /SEALED-REF BLOCK/);
      const events = readFileSync(path.join(dir, '.workflow/state/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.length, 1); assert.equal(events[0].ref, ref); assert.equal(events[0].command, command);
    });
  });
}
