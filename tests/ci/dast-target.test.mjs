// specs/security/local-dast.md REQ-2 / AC-2; exact target admission only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CHECKER = path.join(ROOT, 'scripts/validate-dast-target.mjs');
const TARGET = 'http://127.0.0.1:18080/docs';
const SENTINEL = 'MR21_PRIVATE_TARGET_SENTINEL';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function tree(root) {
  return readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name); const stat = lstatSync(file);
    const identity = [stat.mode, stat.ino, stat.nlink];
    if (stat.isDirectory()) return [[file, 'directory', identity], ...tree(file)];
    return [[file, identity, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : hash(readFileSync(file))]];
  });
}

function withFixture(run) {
  assert.ok(existsSync(CHECKER), 'FEATURE_ABSENT: scripts/validate-dast-target.mjs is not implemented');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'dast-target-')));
  try {
    const root = path.join(outer, 'project'); const cwd = path.join(outer, 'different-cwd');
    const script = path.join(root, 'scripts/validate-dast-target.mjs');
    for (const dir of [path.dirname(script), cwd, path.join(root, 'tmp')]) mkdirSync(dir, { recursive: true });
    copyFileSync(CHECKER, script);
    run({ root, cwd, invoke(target = TARGET, args = [], launchCwd = root) {
      const env = { PATH: '', HOME: root, TMPDIR: path.join(root, 'tmp'), LANG: 'C' };
      if (target !== null) env.DAST_TARGET = target;
      const before = tree(outer);
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: launchCwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      });
      assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
      assert.deepEqual(tree(outer), before, 'target admission must not mutate its owned input tree');
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /,
        'loader/crash is not a target refusal');
      assert.equal(output.includes(SENTINEL), false, 'private target input must not enter diagnostics');
      assert.equal(output.includes('\u001b'), false); assert.doesNotMatch(output, /^::/m);
      return result;
    } });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function passed(result) {
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'dast-target: accepted\n'); assert.equal(result.stderr, '');
}
function refused(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'dast-target: refused\n');
}

test('exact owned target passes from the copied project and an unrelated owned CWD', () => withFixture(f => {
  passed(f.invoke()); passed(f.invoke(TARGET, [], f.cwd));
}));

test('absent and empty DAST_TARGET refuse instead of choosing a default', () => withFixture(f => {
  // Null is a fixture-only sentinel for omitting the environment variable.
  refused(f.invoke(null));
  refused(f.invoke(''));
}));

test('foreign authorities, aliases and service ports refuse', () => withFixture(f => {
  for (const target of ['https://example.com', 'https://127.0.0.1:18080/docs', 'http://localhost:18080/docs',
    'http://[::1]:18080/docs', 'http://fixture@127.0.0.1:18080/docs', 'http://127.0.0.1:18081/docs',
    'http://127.0.0.1:18090/docs', 'http://127.0.0.1:18091/docs']) refused(f.invoke(target));
}));

test('alternate paths, encoded or decorated forms and whitespace refuse', () => withFixture(f => {
  for (const target of ['http://127.0.0.1:18080/', TARGET + '/', TARGET + '?probe=1', TARGET + '#fragment',
    'http://127.0.0.1:18080/%64ocs', 'HTTP://127.0.0.1:18080/docs', ' ' + TARGET, TARGET + '\n']) refused(f.invoke(target));
}));

test('any CLI arguments refuse even with the exact target environment', () => withFixture(f => {
  for (const args of [[TARGET], ['--help'], ['--target', TARGET]]) refused(f.invoke(TARGET, args));
}));

test('refusal never echoes a private target or terminal control text', () => withFixture(f => {
  refused(f.invoke('https://example.com/' + SENTINEL + '?value=\u001b[31m\n::error::synthetic'));
}));
