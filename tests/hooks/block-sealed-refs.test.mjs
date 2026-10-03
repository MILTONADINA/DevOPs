// specs/graph/M-masterpiece-standard.md#AC-M16.1: commands are hook argv data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = process.env.SEALED_REFS_HOOK ? path.resolve(process.env.SEALED_REFS_HOOK) : path.join(ROOT, 'hooks/universal/pre-tool/block-sealed-refs.sh');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
assert.ok(existsSync(HOOK), `sealed hook missing: ${HOOK}`);

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sealed-ref-test-')));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function runHook(dir, command) {
  const result = spawnSync('bash', [HOOK, command], { cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function assertBlocked(result) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /SEALED-REF BLOCK/);
}

for (const command of [
  'git push origin :v0.2.0', 'git push origin :refs/tags/v0.2.0',
  'git push origin +HEAD:stratum-merge', 'git push origin +HEAD:refs/heads/stratum-merge',
  'git -C . tag -d v0.2.0', 'git -C "directory with spaces" tag -d v0.2.0',
  'git update-ref refs/tags/v0.2.0 HEAD', 'git update-ref -d refs/tags/v0.2.0',
  'git -C . update-ref refs/heads/phase-2-security-depth HEAD',
  'git tag -d v0.2.0', 'git tag --force v0.2.0 HEAD',
  'git push origin --force HEAD:stratum-merge', 'git push origin --delete phase-2-security-depth',
  'git branch -D stratum-merge', 'git branch --delete --force phase-2-security-depth',
  'git reset --hard v0.2.0', 'git filter-branch -- stratum-merge', 'git filter-repo --refs phase-2-security-depth',
  'echo harmless; git tag -d v0.2.0', 'echo harmless\ngit tag -d v0.2.0',
  'echo "$(git tag -d v0.2.0)"',
]) {
  test(`AC-M16.1 sealed target mutation refuses: ${JSON.stringify(command)}`, () => {
    withProject((dir) => {
      // Even an apparent approval cannot authorize a sealed-ref mutation.
      const approvals = path.join(dir, '.workflow/state/graph-approvals');
      mkdirSync(approvals, { recursive: true });
      const marker = path.join(approvals, 'current.deploy'); writeFileSync(marker, '{}');
      assertBlocked(runHook(dir, command));
      assert.equal(readFileSync(marker, 'utf8'), '{}');
    });
  });
}

for (const command of [
  'echo git tag -d v0.2.0', "echo 'git tag -d v0.2.0'", 'echo "git tag -d v0.2.0"',
  'echo "\\$(git tag -d v0.2.0)"', "printf '%s' 'git tag -d v0.2.0'",
  'git status', 'git log v0.2.0', 'git show phase-2-security-depth', 'git rev-parse stratum-merge',
  'git -C . show v0.2.0', 'git tag -d v0.2.0-backup',
  'git push origin +HEAD:refs/heads/feature', 'git push origin +v0.2.0:refs/heads/feature',
  'git push origin +HEAD:refs/heads/v0.2.0', 'git push origin +HEAD:refs/tags/stratum-merge',
  'git tag -d stratum-merge', 'git branch -D v0.2.0',
]) {
  test(`AC-M16.1 inert text, reads and unsealed destinations remain allowed: ${JSON.stringify(command)}`, () => {
    withProject((dir) => {
      const result = runHook(dir, command);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(path.join(dir, '.workflow/state/events.jsonl')), false, 'an allowed command must not emit a false block');
    });
  });
}

test('AC-M16.1 real sealed wrapper preserves valid JSON multiline data and project root', () => {
  withProject((dir) => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
    const wrapper = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).find((entry) => entry.command.includes('H=hooks/universal/pre-tool/block-sealed-refs.sh;'))?.command;
    assert.equal(typeof wrapper, 'string');
    const hooks = path.join(dir, 'hooks/universal/pre-tool'); mkdirSync(hooks, { recursive: true });
    copyFileSync(HOOK, path.join(hooks, 'block-sealed-refs.sh'));
    const helper = path.join(path.dirname(HOOK), 'graph-command-classifier.mjs');
    if (existsSync(helper)) copyFileSync(helper, path.join(hooks, path.basename(helper)));
    const wrapperPath = path.join(dir, 'valid-delivery-wrapper.sh'); writeFileSync(wrapperPath, wrapper);
    const nested = path.join(dir, 'nested'); mkdirSync(nested);
    const command = 'echo "synthetic quoted"\ngit -C . tag -d v0.2.0';
    const result = spawnSync('bash', [wrapperPath], { cwd: nested, env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assertBlocked(result);
    const events = readFileSync(path.join(dir, '.workflow/state/events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'sealed_ref_block');
    assert.equal(events[0].command, command);
  });
});


test('AC-M16.1 inert echo remains allowed by the sealed hook while graph-halt exists', () => {
  withProject((dir) => {
    const state = path.join(dir, '.workflow/state'); mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, 'graph-halt'), 'fixture halt');
    const result = runHook(dir, 'echo git tag -d v0.2.0');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(state, 'graph-halt'), 'utf8'), 'fixture halt');
  });
});

test('AC-M16.1 classifying command substitution never evaluates its supplied shell text', () => {
  withProject((dir) => {
    const command = 'echo "$(printf MR3_NOT_EXECUTED > mr3-evaluation-sentinel; git tag -d v0.2.0)"';
    assertBlocked(runHook(dir, command));
    assert.equal(existsSync(path.join(dir, 'mr3-evaluation-sentinel')), false, 'the classifier must never execute command text');
  });
});
