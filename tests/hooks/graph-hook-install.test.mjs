// REQ-M16 companion packaging. Isolated source/target, no skills, signatures or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLASSIFIER = 'graph-command-classifier.mjs';
const ACTUAL_CLASSIFIER = path.join(ROOT, 'hooks/universal/pre-tool', CLASSIFIER);
const BASE_ENV = { ...process.env };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
// Before the feature exists, these bytes let the installer-copy RED reach the
// actual copy loop. GREEN behavior below explicitly requires the real source.
const PLACEHOLDER = '// Packaging RED fixture; not a functional command classifier.\n';

function withInstall(hookNames, fn, { companion = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-install-test-')));
  try {
    const source = path.join(dir, 'source'); const target = path.join(dir, 'target');
    const hooks = path.join(source, 'hooks/universal/pre-tool');
    mkdirSync(hooks, { recursive: true }); mkdirSync(path.join(target, '.workflow'), { recursive: true });
    for (const hookName of hookNames) {
      const actualHook = path.join(ROOT, 'hooks/universal/pre-tool', hookName);
      if (hookName === 'fixture-unrelated.sh') writeFileSync(path.join(hooks, hookName), '#!/usr/bin/env bash\nexit 0\n');
      else copyFileSync(actualHook, path.join(hooks, hookName));
    }
    if (companion) {
      if (existsSync(ACTUAL_CLASSIFIER)) copyFileSync(ACTUAL_CLASSIFIER, path.join(hooks, CLASSIFIER));
      else writeFileSync(path.join(hooks, CLASSIFIER), PLACEHOLDER);
    }
    for (const file of ['AGENTS.md', 'CLAUDE.md']) copyFileSync(path.join(ROOT, file), path.join(source, file));
    const manifest = path.join(source, 'empty-manifest.yml'); writeFileSync(manifest, 'skills:\n');
    writeFileSync(path.join(target, '.workflow/profile.yml'), `skills:\nhooks:\n${hookNames.map((name) => `  - universal/pre-tool/${name}\n`).join('')}subagents:\n`);
    const run = (...extra) => spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/install.ts'), '--target', target, '--manifest', manifest, ...extra],
      { cwd: target, env: { ...BASE_ENV, DEVOPS_ROOT: source }, encoding: 'utf8', timeout: 30_000 });
    fn({ dir, source, target, hooks, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function assertProcess(result) { assert.equal(result.error, undefined); assert.equal(result.signal, null); }

for (const names of [['deploy-gate.sh'], ['block-sealed-refs.sh'], ['deploy-gate.sh', 'block-sealed-refs.sh']]) {
  test(`AC-M16.1 installer copies exact hooks and companion, then installed harmless classification works: ${names.join(',')}`, () => {
    withInstall(names, ({ target, hooks, run }) => {
      const result = run(); assertProcess(result); assert.equal(result.status, 0, result.stderr);
      const destination = path.join(target, '.claude/hooks');
      assert.deepEqual(readdirSync(destination).sort(), [...names, CLASSIFIER].sort());
      assert.deepEqual(readFileSync(path.join(destination, CLASSIFIER)), readFileSync(path.join(hooks, CLASSIFIER)));
      assert.ok(existsSync(ACTUAL_CLASSIFIER), 'functional GREEN must use the actual shipped classifier, never the packaging placeholder');
      for (const hookName of names) {
        assert.deepEqual(readFileSync(path.join(destination, hookName)), readFileSync(path.join(hooks, hookName)));
        assert.ok((statSync(path.join(destination, hookName)).mode & 0o111) !== 0);
        const allowed = spawnSync('bash', [path.join(destination, hookName), 'git status'], { cwd: target, env: BASE_ENV, encoding: 'utf8', timeout: 30_000 });
        assertProcess(allowed); assert.equal(allowed.status, 0, allowed.stderr);
      }
    });
  });
}

for (const hookName of ['deploy-gate.sh', 'block-sealed-refs.sh']) {
  test(`AC-M16.1 installation fails when selected ${hookName} has no source companion`, () => {
    withInstall([hookName], ({ run }) => {
      const result = run(); assertProcess(result);
      assert.notEqual(result.status, 0, 'installer must not report a usable graph hook without its required companion');
      assert.match(result.stderr, /graph-command-classifier/);
    }, { companion: false });
  });
  for (const fault of ['absent', 'unrunnable']) {
    test(`AC-M16.1 ${hookName} fails closed if its installed classifier is ${fault}`, () => {
      withInstall([hookName], ({ target, hooks }) => {
        const destination = path.join(target, '.claude/hooks'); mkdirSync(destination, { recursive: true });
        copyFileSync(path.join(hooks, hookName), path.join(destination, hookName));
        if (fault === 'unrunnable') writeFileSync(path.join(destination, CLASSIFIER), 'throw new Error("synthetic classifier fault");\n');
        const result = spawnSync('bash', [path.join(destination, hookName), 'git status'], { cwd: target, env: BASE_ENV, encoding: 'utf8', timeout: 30_000 });
        assertProcess(result); assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /graph-command-classifier/);
        if (fault === 'absent') assert.equal(existsSync(path.join(destination, CLASSIFIER)), false);
      });
    });
  }
}

test('AC-M16.1 graph hook dry-run preserves target absence and ordinary installer behavior', () => {
  withInstall(['deploy-gate.sh'], ({ target, run }) => {
    const before = readFileSync(path.join(target, '.workflow/profile.yml'));
    const result = run('--dry-run'); assertProcess(result); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run: would copy 0 skills/);
    assert.equal(existsSync(path.join(target, '.claude')), false);
    assert.equal(existsSync(path.join(target, 'AGENTS.md')), false);
    assert.equal(existsSync(path.join(target, '.workflow/state')), false);
    assert.deepEqual(readFileSync(path.join(target, '.workflow/profile.yml')), before);
  });
});

for (const names of [[], ['fixture-unrelated.sh']]) {
  test(`AC-M16.1 no graph companion is copied for an unrelated/empty hook selection: ${names.join(',') || 'empty'}`, () => {
    withInstall(names, ({ target, run }) => {
      const result = run(); assertProcess(result); assert.equal(result.status, 0, result.stderr);
      for (const name of names) assert.ok(existsSync(path.join(target, '.claude/hooks', name)));
      assert.equal(existsSync(path.join(target, '.claude/hooks', CLASSIFIER)), false);
    });
  });
}
