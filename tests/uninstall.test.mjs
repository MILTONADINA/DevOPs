// specs/release/npm-package.md REQ-16, AC-21 (issue #353): `devops uninstall`
// removes what init and analyze recorded and restores what was there before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
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
const devopsWith = (env, cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const devops = (cwd, ...args) => devopsWith({}, cwd, ...args);
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
    assert.match(r.stdout, /1 file\(s\) kept|file\(s\) kept/);
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

test(`a manifest Git tracks is refused and nothing changes (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const installed = snapshot(dir);
    const r = devopsWith({ STUB_GIT_LS_FILES: MANIFEST }, dir, 'uninstall');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /is tracked by Git, so it is not this machine's install record/);
    assert.deepEqual(snapshot(dir), installed);
  });
});

test(`an uninstall that stops part-way is finished by running it again (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    install(dir);
    const agents = path.join(dir, '.claude/agents');
    chmodSync(agents, 0o555); // its files cannot be removed
    try {
      const r = uninstall(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kept {6}\.claude\/agents\/[^:]+: .*(EACCES|permission denied)/i);
      assert.match(r.stdout, /restore {3}\.gitignore/);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
    } finally {
      chmodSync(agents, 0o755);
    }
    const again = uninstall(dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /DevOPs removed\./);
    assert.deepEqual(snapshot(dir), before);
  });
});

test(`a core.hooksPath set after init does not move where uninstall looks for the hook (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    mkdirSync(path.join(dir, '.husky'));
    writeFileSync(path.join(dir, '.husky/pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
    const r = devopsWith({ STUB_GIT_PATH_HOOKS: '.husky', STUB_HOOKS_PATH: '.husky' }, dir, 'uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /remove {4}git-hooks\/pre-commit/);
    assert.ok(!existsSync(path.join(dir, '.git/hooks/pre-commit')));
    assert.equal(readFileSync(path.join(dir, '.husky/pre-commit'), 'utf8'), '#!/bin/sh\nnpx lint-staged\n');
  });
});

test(`a recorded file already gone is dropped, and a dry run names the folders (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    unlinkSync(path.join(dir, 'AGENTS.md'));
    const dry = uninstall(dir, '--dry-run');
    assert.match(dry.stdout, /would remove \.claude\/ once empty/);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /AGENTS\.md/);
    assert.match(r.stdout, /DevOPs removed\./);
    assert.ok(!existsSync(path.join(dir, MANIFEST)));
  });
});

const manifestNow = dir => JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));

test(`an edit made between two DevOPs runs keeps .gitignore and its user line (${SPEC}#ac-23)`, () => {
  withProject(dir => {
    const a = devops(dir, 'analyze');
    assert.equal(a.status, 0, a.stderr);
    appendFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    const i = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(i.status, 0, i.stdout + i.stderr);
    const u = uninstall(dir);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /kept {6}\.gitignore: edited since DevOPs wrote it/);
    assert.doesNotMatch(u.stdout, /restore {3}\.gitignore/);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^dist\/$/m, 'the user rule survives');
    assert.equal(manifestNow(dir).files['.gitignore'].edited, true);
  });
});

test(`a file not edited between two DevOPs runs is still restored (${SPEC}#ac-23)`, () => {
  withProject(dir => {
    install(dir);
    const again = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(manifestNow(dir).files['.gitignore'].edited, undefined, 'no edit, no mark');
    const u = uninstall(dir);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /restore {3}\.gitignore/);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
  });
});
