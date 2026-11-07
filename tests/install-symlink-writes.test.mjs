// specs/phase-2/F-skill-provenance.md REQ-F10, AC-F10.1: `devops init` and
// `devops-analyze` refuse to write, append or change a mode through a symlink
// the project commits, and leave the file outside the project untouched. Each
// case builds a disposable source, target project and outside directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const BASE_ENV = { ...process.env };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV'].includes(key)) delete BASE_ENV[key];
const HOOK = 'toy-hook.sh';
const ORIGINAL = 'outside bytes\n';

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'symlink-writes-')));
  try {
    const source = path.join(dir, 'source'); const target = path.join(dir, 'target'); const outside = path.join(dir, 'outside');
    mkdirSync(path.join(source, 'hooks/universal/pre-tool'), { recursive: true });
    writeFileSync(path.join(source, 'hooks/universal/pre-tool', HOOK), '#!/usr/bin/env bash\nexit 0\n');
    for (const file of ['AGENTS.md', 'CLAUDE.md']) copyFileSync(path.join(ROOT, file), path.join(source, file));
    const manifest = path.join(source, 'empty-manifest.yml'); writeFileSync(manifest, 'skills:\n');
    mkdirSync(path.join(target, '.workflow'), { recursive: true }); mkdirSync(outside);
    writeFileSync(path.join(target, '.workflow/profile.yml'), `skills:\nhooks:\n  - universal/pre-tool/${HOOK}\nsubagents:\n`);
    const victim = path.join(outside, 'victim.txt'); writeFileSync(victim, ORIGINAL); chmodSync(victim, 0o644);
    const install = () => spawnSync(process.execPath, [TSX, path.join(ROOT, 'analyzer/install.ts'), '--target', target, '--manifest', manifest],
      { cwd: target, env: { ...BASE_ENV, DEVOPS_ROOT: source }, encoding: 'utf8', timeout: 60_000 });
    const analyze = () => spawnSync(process.execPath, [TSX, path.join(ROOT, 'analyzer/scan.ts')],
      { cwd: target, env: BASE_ENV, encoding: 'utf8', timeout: 60_000 });
    fn({ target, outside, victim, install, analyze });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function assertRefused(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /refusing to write through a symlink/);
}

test('AC-F10.1 init refuses a hook destination that links outside the project and leaves its bytes and mode alone', () => {
  withProject(({ target, victim, install }) => {
    mkdirSync(path.join(target, '.claude/hooks'), { recursive: true });
    symlinkSync(victim, path.join(target, '.claude/hooks', HOOK));
    assertRefused(install());
    assert.equal(readFileSync(victim, 'utf8'), ORIGINAL);
    assert.equal(statSync(victim).mode & 0o777, 0o644);
  });
});

test('AC-F10.1 init refuses a dangling AGENTS.md link and creates nothing outside the project', () => {
  withProject(({ target, outside, install }) => {
    const planted = path.join(outside, 'planted.md');
    symlinkSync(planted, path.join(target, 'AGENTS.md'));
    const result = install();
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(existsSync(planted), false, 'nothing is created through the dangling link');
    assert.match(result.stdout, /AGENTS\.md already exists; not overwriting/);
  });
});

test('AC-F10.1 init refuses a .claude directory that links outside the project', () => {
  withProject(({ target, outside, install }) => {
    symlinkSync(outside, path.join(target, '.claude'));
    assertRefused(install());
    assert.equal(existsSync(path.join(outside, 'hooks')), false);
  });
});

test('AC-F10.1 init refuses a .gitignore that links outside the project', () => {
  withProject(({ target, victim, install }) => {
    symlinkSync(victim, path.join(target, '.gitignore'));
    assertRefused(install());
    assert.equal(readFileSync(victim, 'utf8'), ORIGINAL);
  });
});

test('AC-F10.1 devops-analyze refuses a .gitignore that links outside the project (#391)', () => {
  withProject(({ target, victim, analyze }) => {
    symlinkSync(victim, path.join(target, '.gitignore'));
    assertRefused(analyze());
    assert.equal(readFileSync(victim, 'utf8'), ORIGINAL);
  });
});

test('AC-F10.1 devops-analyze refuses a .workflow directory that links outside the project', () => {
  withProject(({ target, outside, analyze }) => {
    rmSync(path.join(target, '.workflow'), { recursive: true });
    symlinkSync(outside, path.join(target, '.workflow'));
    assertRefused(analyze());
    assert.equal(existsSync(path.join(outside, 'profile.yml')), false);
  });
});

test('AC-F10.1 devops-analyze refuses a profile.yml that links outside the project', () => {
  withProject(({ target, victim, analyze }) => {
    rmSync(path.join(target, '.workflow/profile.yml'));
    symlinkSync(victim, path.join(target, '.workflow/profile.yml'));
    assertRefused(analyze());
    assert.equal(readFileSync(victim, 'utf8'), ORIGINAL);
  });
});

test('init without links still installs the hook as executable', () => {
  withProject(({ target, install }) => {
    const result = install();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const hook = path.join(target, '.claude/hooks', HOOK);
    assert.ok((statSync(hook).mode & 0o111) !== 0);
    assert.ok(existsSync(path.join(target, 'AGENTS.md')));
  });
});
