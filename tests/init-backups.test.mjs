// specs/phase-2/F-skill-provenance.md REQ-F11 (issue #349): init and analyze
// back up a file that differs from the new copy before replacing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { UnsafeWriteError, backupIfChanged, backupStamp, freshBackupStamp, writeBackup } from '../analyzer/safe-write.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/phase-2/F-skill-provenance.md';
// These tests are about backups, not signatures, so they opt out of cosign and
// log why, as package-smoke.sh does.
const UNSIGNED = ['--allow-unsigned', '--rationale=init backup test without cosign'];
// Tests never run the real git (tests/hermeticity.test.mjs): a stub on PATH tells
// init-project.sh that the project's hooks live in .git/hooks.
const STUB_BIN = mkdtempSync(path.join(tmpdir(), 'init-backups-git-'));
writeStubGit(STUB_BIN);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const EDITED = [
  '.claude/hooks/block-secrets.sh',
  '.claude/skills/goal-loop/SKILL.md',
  '.claude/agents/coder.md',
  '.git/hooks/pre-commit',
  '.workflow/profile.yml',
];
const backupName = file => (file === '.git/hooks/pre-commit' ? 'git-hooks/pre-commit' : file);

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-backups-349-')));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer/nextjs-project'), dir, { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function analyzeAndInit(dir) {
  const a = devops(dir, 'analyze');
  assert.equal(a.status, 0, a.stderr);
  const i = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
  return { out: `${a.stdout}\n${i.stdout}\n${i.stderr}`, status: i.status, stderr: i.stderr };
}
const backupsDir = dir => path.join(dir, '.workflow/state/backups');

test(`re-running analyze and init backs up every edited file and names it (${SPEC}#req-f11)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    for (const file of EDITED) {
      assert.ok(existsSync(path.join(dir, file)), `${file} was installed`);
      appendFileSync(path.join(dir, file), '# local edit\n');
    }
    const { out, status, stderr } = analyzeAndInit(dir);
    assert.equal(status, 0, stderr);
    // analyze and init are separate runs, so each may have its own stamp.
    const stamps = readdirSync(backupsDir(dir));
    for (const file of EDITED) {
      const found = stamps.filter(st => existsSync(path.join(backupsDir(dir), st, backupName(file))));
      assert.equal(found.length, 1, `${file}: ${found.join(',')}`);
      const backup = `.workflow/state/backups/${found[0]}/${backupName(file)}`;
      assert.match(readFileSync(path.join(dir, backup), 'utf8'), /# local edit\n$/, backup);
      assert.ok(out.includes(`; the previous copy is in ${backup}`), `${file} not named:\n${out}`);
      assert.doesNotMatch(readFileSync(path.join(dir, file), 'utf8'), /# local edit/, `${file} was replaced`);
    }
    assert.match(out, /^replaced=3 /m);
  });
});

test(`a re-run with no local edits creates no backup and prints no replacement (${SPEC}#req-f11)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    const { out, status, stderr } = analyzeAndInit(dir);
    assert.equal(status, 0, stderr);
    assert.ok(!existsSync(backupsDir(dir)), 'no backups folder');
    assert.doesNotMatch(out, /↻ Replaced/);
    assert.match(out, /^replaced=0 /m);
  });
});

test(`a symlinked backups folder is refused and nothing is written through it (${SPEC}#req-f10)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-backups-outside-')));
    try {
      symlinkSync(outside, backupsDir(dir));
      appendFileSync(path.join(dir, '.claude/agents/coder.md'), '# local edit\n');
      const { status, stderr } = analyzeAndInit(dir);
      assert.notEqual(status, 0, 'init refuses to back up through a symlink');
      assert.match(stderr, /refusing to write through a symlink in the project: \.workflow\/state\/backups/);
      assert.deepEqual(readdirSync(outside), []);
      assert.match(readFileSync(path.join(dir, '.claude/agents/coder.md'), 'utf8'), /# local edit\n$/, 'the edit is kept');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`backupIfChanged copies only a differing regular file (${SPEC}#req-f11)`, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'backup-unit-349-')));
  try {
    const stamp = backupStamp(new Date('2026-11-07T01:02:03.456Z'));
    assert.equal(stamp, '2026-11-07T01-02-03Z');
    assert.equal(backupIfChanged(dir, 'missing.txt', 'new', stamp), null);
    writeFileSync(path.join(dir, 'same.txt'), 'same');
    assert.equal(backupIfChanged(dir, 'same.txt', 'same', stamp), null);
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub/edited.txt'), 'mine');
    assert.equal(backupIfChanged(dir, 'sub/edited.txt', 'theirs', stamp), `.workflow/state/backups/${stamp}/sub/edited.txt`);
    assert.equal(readFileSync(path.join(dir, `.workflow/state/backups/${stamp}/sub/edited.txt`), 'utf8'), 'mine');
    const ignoreCase = (a, b) => a.toString().toLowerCase() === b.toString().toLowerCase();
    writeFileSync(path.join(dir, 'case.txt'), 'ABC');
    assert.equal(backupIfChanged(dir, 'case.txt', 'abc', stamp, ignoreCase), null);
    assert.throws(() => writeBackup(dir, 'x', 'y', 0o644, '../escape'), UnsafeWriteError);
    for (const name of ['../x', 'a/../../x', '/abs', 'a//b'])
      assert.throws(() => writeBackup(dir, name, 'y', 0o644, stamp), UnsafeWriteError, name);
    // A backup is create-only, and a taken stamp folder gets a suffix.
    assert.throws(() => writeBackup(dir, 'sub/edited.txt', 'again', 0o644, stamp), /EEXIST/);
    assert.equal(readFileSync(path.join(dir, `.workflow/state/backups/${stamp}/sub/edited.txt`), 'utf8'), 'mine');
    const at = new Date('2026-11-07T01:02:03Z');
    assert.equal(freshBackupStamp(dir, at), `${stamp}-2`);
    mkdirSync(path.join(dir, `.workflow/state/backups/${stamp}-2`));
    assert.equal(freshBackupStamp(dir, at), `${stamp}-3`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`an edit to the pre-commit hook alone is backed up and named (${SPEC}#req-f11)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    appendFileSync(path.join(dir, '.git/hooks/pre-commit'), '# local edit\n');
    const { out, status, stderr } = analyzeAndInit(dir);
    assert.equal(status, 0, stderr);
    const line = out.split('\n').find(l => l.startsWith('↻ Replaced .git/hooks/pre-commit; the previous copy is in '));
    assert.ok(line, out);
    const backup = line.split(' is in ')[1];
    assert.match(readFileSync(path.join(dir, backup), 'utf8'), /# local edit\n$/);
    assert.match(out, /^replaced=0 /m, 'replaced= counts skills, hooks and subagents only');
  });
});

test(`a symlinked pre-commit hook is left unchanged, and its target keeps its bytes (${SPEC}#req-f10)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-hook-outside-')));
    try {
      const target = path.join(outside, 'pre-commit');
      writeFileSync(target, '#!/bin/sh\n# DevOPs pre-commit hook\nexit 0\n');
      rmSync(path.join(dir, '.git/hooks/pre-commit'));
      symlinkSync(target, path.join(dir, '.git/hooks/pre-commit'));
      const { out, status, stderr } = analyzeAndInit(dir);
      assert.equal(status, 0, stderr);
      assert.match(out, /Left \.git\/hooks\/pre-commit unchanged: it is a symlink/);
      assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\n# DevOPs pre-commit hook\nexit 0\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
