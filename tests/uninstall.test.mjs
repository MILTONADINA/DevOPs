// specs/release/npm-package.md REQ-16, AC-21 (issue #353): `devops uninstall`
// removes what init and analyze recorded and restores what was there before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { MANIFEST } from '../analyzer/install-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
const UNSIGNED = ['--allow-unsigned', '--rationale=uninstall test without cosign'];
// Tests never run the real git (tests/hermeticity.test.mjs).
const STUB_BIN = mkdtempSync(path.join(tmpdir(), 'uninstall-git-'));
writeStubGit(STUB_BIN);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const USER_CLAUDE = '# Our own notes\n\nKeep this.\n';
const GITIGNORE = 'node_modules/\n';

function withProject(fn, { claude = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-353-')));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer/nextjs-project'), dir, { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    if (claude) writeFileSync(path.join(dir, 'CLAUDE.md'), USER_CLAUDE);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function install(dir) {
  const a = devops(dir, 'analyze');
  assert.equal(a.status, 0, a.stderr);
  const r = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
/** Every file below `dir` with its bytes; folders are listed with a trailing slash. */
function snapshot(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (e.isFile()) out[rel] = readFileSync(path.join(dir, rel), 'utf8');
    else if (e.isDirectory() && !rel.startsWith('.git')) out[`${rel}/`] = '';
  }
  return out;
}
const uninstall = (dir, ...args) => devops(dir, 'uninstall', ...args);

test(`uninstall after analyze and init leaves the project as it was (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    install(dir);
    assert.ok(existsSync(path.join(dir, '.git/hooks/pre-commit')), 'init installed the hook');
    assert.equal(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), USER_CLAUDE, 'init keeps a CLAUDE.md the project has');
    assert.notEqual(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE, 'init changed .gitignore');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restore {3}\.gitignore/);
    assert.match(r.stdout, /DevOPs removed\./);
    assert.deepEqual(snapshot(dir), before);
  });
});

test(`a dry run reports the plan and changes nothing (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const installed = snapshot(dir);
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would remove {4}\.claude\//);
    assert.match(r.stdout, /would restore {3}\.gitignore/);
    assert.match(r.stdout, /nothing changed/);
    assert.deepEqual(snapshot(dir), installed);
  });
});

test(`an edited file is kept, reported and left in the manifest (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const agent = Object.keys(m.files).find(k => k.startsWith('.claude/agents/'));
    assert.ok(agent, 'init installed an agent');
    appendFileSync(path.join(dir, agent), '\nOur own change.\n');
    appendFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    const edited = readFileSync(path.join(dir, agent), 'utf8');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`kept {6}${agent.replace(/[.]/g, '\\.')}: edited since DevOPs wrote it`));
    assert.match(r.stdout, /kept {6}\.gitignore: edited/);
    assert.equal(readFileSync(path.join(dir, agent), 'utf8'), edited);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /dist\/\n$/);
    const left = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    assert.deepEqual(Object.keys(left.files).sort(), ['.gitignore', agent].sort());
    assert.ok(existsSync(path.join(dir, left.files['.gitignore'].original.copy)), 'the original copy is kept');
    assert.ok(!existsSync(path.join(dir, '.claude/hooks')), 'unedited files and their empty folders went');
  });
});

test(`a changed original copy is not restored (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const installed = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    writeFileSync(path.join(dir, m.files['.gitignore'].original.copy), 'not what was there\n');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}\.gitignore: its original copy .* is missing or changed/);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), installed);
  });
});

test(`a recorded file replaced by a symlink is not followed (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-outside-')));
    try {
      const target = path.join(outside, 'keep.txt');
      writeFileSync(target, 'outside\n');
      unlinkSync(path.join(dir, 'AGENTS.md'));
      symlinkSync(target, path.join(dir, 'AGENTS.md'));
      const r = uninstall(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kept {6}AGENTS\.md: refusing to .*symlink/);
      assert.equal(readFileSync(target, 'utf8'), 'outside\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`a pre-commit hook that is no longer DevOPs's is kept (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const hook = path.join(dir, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho ours\n');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}git-hooks\/pre-commit: edited since DevOPs wrote it/);
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho ours\n');
  });
});

test(`in an adopted install, files with a recorded original are kept for the user to check (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow/state/install.log'), '{}\n');
    install(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}\.gitignore: recorded where an earlier DevOPs had installed/);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /AGENTS\.override\.md/);
    assert.ok(!existsSync(path.join(dir, '.claude/hooks')), 'files DevOPs created are still removed');
  });
});

test(`without a manifest uninstall changes nothing and says so (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing DevOPs recorded to remove/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(uninstall(dir, '--force').status, 1, 'an unknown option is refused');
  });
});
