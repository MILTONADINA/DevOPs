// specs/release/npm-package.md AC-28: the agent cannot change its own gates or approvals.
// hooks/universal/pre-tool/protect-gates.sh (file tools) and protect-gates-bash.sh (Bash) call
// protect-gates.mjs. These cases run the real hooks against a temp project; the end-to-end case
// runs the commands that `devops init` wrote to .claude/settings.json, through `bash -c`.
// The file-tool check compares file identity, so links, letter case and Unicode forms reach the
// same decision. The Bash check is text-only and is a convenience guard, not a boundary: the
// "documented limits" case pins what it does not catch (docs/HOOKS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from '../fixtures/stub-git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FILE_HOOK = path.join(ROOT, 'hooks/universal/pre-tool/protect-gates.sh');
const BASH_HOOK = path.join(ROOT, 'hooks/universal/pre-tool/protect-gates-bash.sh');
const SPEC = 'specs/release/npm-package.md';
const BLOCK = /^DevOPs GATE BLOCK: .+ holds DevOPs gates or approvals; change it yourself outside the agent$/m;

const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project with the gate files a DevOPs install writes, and one ordinary agent file. */
function project() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-gates-')));
  dirs.push(dir);
  return populate(dir);
}

/** Writes the gate layout into a directory, which is created when it does not exist. */
function populate(dir) {
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const d of ['.claude/hooks', '.claude/agents', '.workflow/state/originals', 'src', 'docs']) mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/block-rm-rf.sh',
    '.workflow/state/approvals.jsonl', '.workflow/state/install-manifest.json', '.workflow/state/originals/x.md']) {
    writeFileSync(path.join(dir, f), '{}\n');
  }
  return dir;
}

/** Runs the file hook on one target path, with the project root in CLAUDE_PROJECT_DIR. */
function fileHook(dir, target) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  return spawnSync('bash', [FILE_HOOK, target], { cwd: dir, env, encoding: 'utf8' });
}

/** Runs the Bash hook on one command. */
function bashHook(dir, command) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  return spawnSync('bash', [BASH_HOOK, command], { cwd: dir, env, encoding: 'utf8' });
}

const blocked = (r, label) => {
  assert.equal(r.status, 2, `${label} should be blocked: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, BLOCK, label);
};
const allowed = (r, label) => assert.equal(r.status, 0, `${label} should pass: ${r.stdout}${r.stderr}`);

test(`file tools: a write to a gate or approval file is blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(fileHook(dir, path.join(dir, '.workflow/state/approvals.jsonl')), 'approvals.jsonl');
  blocked(fileHook(dir, path.join(dir, '.claude/settings.json')), 'settings.json');
  blocked(fileHook(dir, path.join(dir, '.claude/settings.local.json')), 'settings.local.json');
  blocked(fileHook(dir, path.join(dir, '.claude/hooks/block-rm-rf.sh')), '.claude/hooks/block-rm-rf.sh');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/install-manifest.json')), 'install-manifest.json');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/originals/x.md')), 'originals/x.md');
});

test(`file tools: a new hook or a gate file not yet on disk is blocked too (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(fileHook(dir, path.join(dir, '.claude/hooks/new-hook.sh')), 'a new file under .claude/hooks');
  rmSync(path.join(dir, '.workflow/state/approvals.jsonl'));
  blocked(fileHook(dir, path.join(dir, '.workflow/state/approvals.jsonl')), 'approvals.jsonl before it exists');
  // A directory that does not exist yet is matched by its parent and name, so a file under it is blocked too.
  rmSync(path.join(dir, '.workflow/state/originals'), { recursive: true });
  blocked(fileHook(dir, path.join(dir, '.workflow/state/originals/new.md')), 'a new file under originals that does not exist yet');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/originals/deeper/new.md')), 'a deeper new file under originals');
});

test(`file tools: a symlink, a dot-dot path and a dangling link to a gate file are blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  symlinkSync('.claude/settings.json', path.join(dir, 'link.json'));
  symlinkSync('.claude', path.join(dir, 'alias'));
  symlinkSync('.claude/settings.local.json', path.join(dir, 'dangling-local.json'));
  rmSync(path.join(dir, '.claude/settings.local.json'));
  blocked(fileHook(dir, path.join(dir, 'link.json')), 'a symlink to settings.json');
  blocked(fileHook(dir, path.join(dir, 'alias/settings.json')), 'a path through a symlinked directory');
  blocked(fileHook(dir, `${dir}/./.claude/../.claude/settings.json`), 'a dot-dot path to settings.json');
  blocked(fileHook(dir, path.join(dir, 'dangling-local.json')), 'a dangling symlink to a gate file');
});

test(`file tools: a symlink chain that reaches .claude through .. is blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  symlinkSync('.claude/agents', path.join(dir, 'sub'));
  symlinkSync('sub/..', path.join(dir, 'up'));
  // The kernel reaches up/settings.json as .claude/settings.json: the same file. (The JS realpathSync
  // collapses sub/.. lexically and cannot show this; realpathSync.native follows the kernel.)
  assert.equal(realpathSync.native(path.join(dir, 'up/settings.json')), realpathSync.native(path.join(dir, '.claude/settings.json')));
  blocked(fileHook(dir, path.join(dir, 'up/settings.json')), 'up/settings.json through sub/..');
  blocked(fileHook(dir, path.join(dir, 'up/hooks/block-rm-rf.sh')), 'up/hooks/block-rm-rf.sh through sub/..');
  allowed(fileHook(dir, path.join(dir, 'up/agents/foo.md')), 'up/agents/foo.md is an ordinary agent file');
});

test(`file tools: a hard link to a gate file is blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  linkSync(path.join(dir, '.claude/settings.json'), path.join(dir, 'src/hl.json'));
  assert.equal(statSync(path.join(dir, 'src/hl.json')).ino, statSync(path.join(dir, '.claude/settings.json')).ino);
  blocked(fileHook(dir, path.join(dir, 'src/hl.json')), 'a hard link to settings.json');
});

test(`file tools: a hard link to a file inside a protected directory is blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  linkSync(path.join(dir, '.claude/hooks/block-rm-rf.sh'), path.join(dir, 'src/hl.sh'));
  linkSync(path.join(dir, '.workflow/state/originals/x.md'), path.join(dir, 'src/hl.md'));
  assert.equal(statSync(path.join(dir, 'src/hl.sh')).ino, statSync(path.join(dir, '.claude/hooks/block-rm-rf.sh')).ino);
  blocked(fileHook(dir, path.join(dir, 'src/hl.sh')), 'a hard link to .claude/hooks/block-rm-rf.sh');
  blocked(fileHook(dir, path.join(dir, 'src/hl.md')), 'a hard link to .workflow/state/originals/x.md');
  writeFileSync(path.join(dir, 'src/app.ts'), 'export {};\n');
  allowed(fileHook(dir, path.join(dir, 'src/app.ts')), 'an ordinary file beside them');
});

test(`file tools: a symlink inside a protected directory that points out of it is blocked, and so is its target (${SPEC}#ac-28)`, () => {
  const dir = project();
  writeFileSync(path.join(dir, 'src/real.sh'), '#!/bin/sh\n');
  writeFileSync(path.join(dir, 'src/real.md'), '# real\n');
  symlinkSync(path.join(dir, 'src/real.sh'), path.join(dir, '.claude/hooks/a.sh'));
  symlinkSync(path.join(dir, 'src/real.md'), path.join(dir, '.workflow/state/originals/a.md'));
  blocked(fileHook(dir, path.join(dir, '.claude/hooks/a.sh')), 'the symlink .claude/hooks/a.sh');
  blocked(fileHook(dir, path.join(dir, 'src/real.sh')), 'src/real.sh, the target of that symlink');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/originals/a.md')), 'the symlink .workflow/state/originals/a.md');
  blocked(fileHook(dir, path.join(dir, 'src/real.md')), 'src/real.md, the target of that symlink');
});

test(`file tools: a link in a protected directory to a directory or a missing file protects what it reaches (${SPEC}#ac-28)`, () => {
  const dir = project();
  mkdirSync(path.join(dir, 'src/lib/sub'), { recursive: true });
  writeFileSync(path.join(dir, 'src/lib/old.js'), 'old\n');
  symlinkSync(path.join(dir, 'src/lib'), path.join(dir, '.claude/hooks/lib'));
  symlinkSync(path.join(dir, 'src/future.sh'), path.join(dir, '.claude/hooks/future.sh'));
  mkdirSync(path.join(dir, 'src/out'));
  symlinkSync(path.join(dir, 'src/out'), path.join(dir, '.workflow/state/originals/o'));
  blocked(fileHook(dir, path.join(dir, 'src/lib/new.js')), 'a new file in a directory a hooks link points to');
  blocked(fileHook(dir, path.join(dir, 'src/lib/sub/new.js')), 'a new file deeper in that directory');
  blocked(fileHook(dir, path.join(dir, '.claude/hooks/lib/new.js')), 'the same file through the link');
  blocked(fileHook(dir, path.join(dir, 'src/future.sh')), 'the missing target of a dangling hooks link');
  blocked(fileHook(dir, path.join(dir, 'src/out/new.md')), 'a new file in a directory an originals link points to');
  allowed(fileHook(dir, path.join(dir, 'src/other.js')), 'a file no link reaches');
});

test(`file tools: a symlinked tree in a protected directory is one entry, not walked (${SPEC}#ac-28)`, () => {
  const dir = project();
  const big = path.join(dir, 'vendor/big');
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 5100; i += 1) writeFileSync(path.join(big, `f${i}.js`), '');
  symlinkSync(big, path.join(dir, '.claude/hooks/node_modules'));
  symlinkSync(path.join(dir, '.claude/hooks'), path.join(dir, '.claude/hooks/loop'));
  writeFileSync(path.join(dir, 'src/app.ts'), 'export {};\n');
  allowed(fileHook(dir, path.join(dir, 'src/app.ts')), 'an edit elsewhere with a large linked tree and a loop under hooks');
});

test(`file tools: a protected directory walk fails closed past 8 levels or 5000 entries (${SPEC}#ac-28)`, () => {
  const dir = project();
  writeFileSync(path.join(dir, 'src/app.ts'), 'export {};\n');
  // Eight nested levels under .claude/hooks: an entry at depth 8 is walked, and nothing deeper exists.
  const seven = path.join(dir, '.claude/hooks', ...Array.from({ length: 7 }, (_, i) => `l${i + 1}`));
  mkdirSync(seven, { recursive: true });
  writeFileSync(path.join(seven, 'ok.txt'), 'ok\n');
  allowed(fileHook(dir, path.join(dir, 'src/app.ts')), 'a walk within 8 levels');
  // One level more: an entry at depth 9 is past the limit, so the check fails closed.
  mkdirSync(path.join(seven, 'l8'));
  writeFileSync(path.join(seven, 'l8', 'deep.txt'), 'deep\n');
  const deep = fileHook(dir, path.join(dir, 'src/app.ts'));
  assert.equal(deep.status, 2, `a walk past 8 levels: ${deep.stdout}${deep.stderr}`);
  assert.match(deep.stderr, /failing closed/);
  // 5000 entries: a directory with 5000 files and the existing hook, past the limit.
  const wide = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-gates-wide-')));
  dirs.push(wide);
  populate(wide);
  mkdirSync(path.join(wide, '.claude/hooks/bulk'));
  for (let i = 0; i < 5000; i += 1) writeFileSync(path.join(wide, '.claude/hooks/bulk', `f${i}.txt`), '');
  writeFileSync(path.join(wide, 'src/app.ts'), 'export {};\n');
  const many = fileHook(wide, path.join(wide, 'src/app.ts'));
  assert.equal(many.status, 2, `a walk past 5000 entries: ${many.stdout}${many.stderr}`);
  assert.match(many.stderr, /failing closed/);
});

test(`a long s (U+017F) spelling of a gate name is blocked on every platform (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(fileHook(dir, path.join(dir, '.claude/\u017Fettings.json')), '.claude/\u017Fettings.json');
  blocked(fileHook(dir, path.join(dir, '.claude/hook\u017F/a.sh')), '.claude/hook\u017F/a.sh');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/in\u017Ftall-manifest.json')), 'in\u017Ftall-manifest.json');
});

test(`a project root with an accent: the NFD spelling of a target is blocked (${SPEC}#ac-28)`, t => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-gates-accent-')));
  dirs.push(base);
  const nfc = 'Dise\u00f1o-caf\u00e9'.normalize('NFC');
  const root = populate(path.join(base, nfc));
  // The same directory, spelled in NFD. Where the file system keeps the two apart, there is nothing to check.
  const viaNfd = path.join(base, nfc.normalize('NFD'));
  if (!existsSync(path.join(viaNfd, '.claude/settings.json'))) {
    t.skip('this file system keeps NFC and NFD names apart');
    return;
  }
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const run = target => spawnSync('bash', [FILE_HOOK, target], { cwd: root, env, encoding: 'utf8' });
  blocked(run(path.join(viaNfd, '.claude/settings.json')), 'an NFD path to settings.json under an NFC root');
  blocked(run(path.join(viaNfd, '.workflow/state/approvals.jsonl')), 'an NFD path to approvals.jsonl under an NFC root');
});

test(`file tools: a path that is not a gate file passes (${SPEC}#ac-28)`, () => {
  const dir = project();
  for (const target of ['src/app.ts', 'docs/x.md', '.claude/agents/foo.md', '.workflow/state/events.jsonl', 'src/settings.json']) {
    allowed(fileHook(dir, path.join(dir, target)), target);
  }
});

test(`file tools: a path that is not absolute, or starts with ~, fails closed (${SPEC}#ac-28)`, () => {
  const dir = project();
  for (const target of ['settings.json', '~/x', '~/.claude/settings.json', '.claude/settings.json', 'src/app.ts']) {
    const r = fileHook(dir, target);
    assert.equal(r.status, 2, `${target} should fail closed: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, `DevOPs GATE BLOCK: ${target} is not an absolute path; file tools take absolute paths -- failing closed\n`, target);
  }
});

test(`file tools: an empty path passes; an internal error fails closed (${SPEC}#ac-28)`, () => {
  const dir = project();
  allowed(fileHook(dir, ''), 'empty path');
  // A root that is a symbolic loop cannot be resolved, which is an internal error.
  symlinkSync('loop', path.join(dir, 'loop'));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: path.join(dir, 'loop') };
  const broken = spawnSync('bash', [FILE_HOOK, path.join(dir, 'src/app.ts')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(broken.status, 2, broken.stderr);
  assert.match(broken.stderr, /failing closed/);
});

test(`the project root is CLAUDE_PROJECT_DIR, else the git top level (${SPEC}#ac-28)`, () => {
  const dir = project();
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  // From src/, the absolute path names the protected file, and the root is the git top level.
  const r = spawnSync('bash', [FILE_HOOK, path.join(dir, '.claude/settings.json')], { cwd: path.join(dir, 'src'), env, encoding: 'utf8' });
  blocked(r, 'absolute path from a subdirectory of the git work tree');
});

test(`the names match case-insensitively and by Unicode form, on every platform (${SPEC}#ac-28)`, () => {
  const dir = project();
  // The gates named here may not exist on this file system: an absent name is compared by its folded spelling.
  rmSync(path.join(dir, '.workflow/state/approvals.jsonl'));
  blocked(fileHook(dir, path.join(dir, '.CLAUDE/Settings.json')), '.CLAUDE/Settings.json');
  blocked(fileHook(dir, path.join(dir, '.workflow/state/Approvals.jsonl')), 'Approvals.jsonl, absent');
  blocked(fileHook(dir, path.join(dir, '.claude/hook\u017F/new.sh')), '.claude/hookſ/new.sh, absent');
  blocked(fileHook(dir, path.join(dir, '.workflow/\uFB06ate/approvals.jsonl')), 'a ligature that folds to st, absent');
  blocked(bashHook(dir, 'echo x > .CLAUDE/SETTINGS.JSON'), 'a Bash redirect in capitals');
  blocked(bashHook(dir, 'echo x > .workflow/state/in\u017Ftall-manifest.json'), 'a Bash redirect with a long s');
});

test(`Bash: a command that writes a gate file is blocked; plain reads pass (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(bashHook(dir, 'echo x >> .workflow/state/approvals.jsonl'), 'echo >> approvals.jsonl');
  blocked(bashHook(dir, 'echo x>.workflow/state/approvals.jsonl'), 'echo >approvals.jsonl with no space');
  blocked(bashHook(dir, 'rm .claude/settings.json'), 'rm settings.json');
  blocked(bashHook(dir, 'cp x .claude/hooks/block-rm-rf.sh'), 'cp into .claude/hooks');
  blocked(bashHook(dir, 'cat .claude/settings.json | tee x'), 'cat piped to tee');
  blocked(bashHook(dir, './.claude/../.claude/settings.json'), 'a dot-dot path to settings.json');
  allowed(bashHook(dir, 'cat .claude/settings.json'), 'cat settings.json');
  allowed(bashHook(dir, 'ls'), 'ls');
  allowed(bashHook(dir, 'head -n 3 .workflow/state/approvals.jsonl'), 'head of approvals.jsonl');
  allowed(bashHook(dir, 'grep -i secret .claude/hooks/block-rm-rf.sh'), 'grep -i in .claude/hooks');
  allowed(bashHook(dir, 'git status'), 'git status');
  allowed(bashHook(dir, 'git status -- .claude/settings.json'), 'git status of settings.json');
  blocked(bashHook(dir, 'git diff --output=.claude/settings.json HEAD~1'), 'git diff --output writes the file');
  blocked(bashHook(dir, 'git log -p -- .claude/settings.json'), 'git log can run an external diff');
  blocked(bashHook(dir, 'rg --pre ./x.sh deny .claude/settings.json'), 'rg --pre runs a program');
  allowed(bashHook(dir, 'echo hello'), 'echo that names nothing protected');
  allowed(bashHook(dir, 'npm run test'), 'npm run test');
});

test(`Bash: a read-only first word does not excuse a chained or redirected command (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(bashHook(dir, 'cat .claude/settings.json | tee x'), 'pipe');
  blocked(bashHook(dir, 'cat .claude/settings.json; rm x'), 'semicolon');
  blocked(bashHook(dir, 'cat .claude/settings.json && rm x'), 'and-and');
  blocked(bashHook(dir, 'cat .claude/settings.json > out.txt'), 'redirection');
  blocked(bashHook(dir, 'git diff .claude/settings.json | sh'), 'git diff piped');
  blocked(bashHook(dir, 'ls $(cat .claude/settings.json)'), 'substitution');
  blocked(bashHook(dir, 'cat ".$(touch x)" .claude/settings.json'), 'substitution inside double quotes');
  blocked(bashHook(dir, 'cat .claude/settings.json | sort -o out.txt'), 'sort -o writes its output file');
  blocked(bashHook(dir, 'cat .claude/settings.json | sort --compress-program=./x.sh'), 'sort runs a program');
});

test(`Bash: the plain reads and the git steps that the owner needs pass (${SPEC}#ac-28)`, () => {
  const dir = project();
  allowed(bashHook(dir, "echo '{}' > .vscode/settings.json"), "echo '{}' > .vscode/settings.json");
  allowed(bashHook(dir, 'git add .claude/settings.json'), 'git add .claude/settings.json');
  allowed(bashHook(dir, 'git commit -m "docs: explain .claude/settings.json"'), 'git commit -m with the path in the message');
  allowed(bashHook(dir, "jq '.hooks | keys' .claude/settings.json"), 'jq with a quoted filter');
  allowed(bashHook(dir, 'cat .claude/settings.json 2>&1 | head'), 'cat with 2>&1 piped to head');
  allowed(bashHook(dir, "grep -E 'a|b' .claude/settings.json"), 'grep with a quoted alternation');
  allowed(bashHook(dir, 'cat .claude/settings.json | grep -E "a|b" | wc -l'), 'a read piped to grep and wc');
  allowed(bashHook(dir, 'cat .claude/settings.json | sort -n | head'), 'a read piped to sort and head');
  allowed(bashHook(dir, 'less .claude/settings.json'), 'less of settings.json');
  allowed(bashHook(dir, 'jq -i . .claude/settings.json'), 'jq has no -i; it writes nothing');
  allowed(bashHook(dir, 'ls .claude/hooks | head'), 'ls of .claude/hooks piped to head');
});

test(`Bash: the commands that name a gate and can write or run are blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(bashHook(dir, 'echo x > .claude/"hooks"/a.sh'), 'a quoted .claude/"hooks" path');
  blocked(bashHook(dir, 'mv .claude .claude.orig'), 'mv of the bare .claude directory');
  blocked(bashHook(dir, 'mv .workflow/state st'), 'mv of .workflow/state');
  blocked(bashHook(dir, 'tar -C .claude -xf x.tar hooks'), 'tar into the bare .claude directory');
  blocked(bashHook(dir, 'rsync -a x/ .claude/'), 'rsync into .claude/');
  blocked(bashHook(dir, 'ln -s .claude sub'), 'ln of the bare .claude directory');
  blocked(bashHook(dir, 'rg --pre ./x.sh a .claude/settings.json'), 'rg --pre runs a program');
  blocked(bashHook(dir, 'rg --hostname-bin ./x.sh deny .claude/settings.json'), 'rg --hostname-bin runs a program');
  blocked(bashHook(dir, 'rg deny .claude/settings.json'), 'rg is not a plain read');
  blocked(bashHook(dir, '"rm" cat .claude/settings.json'), 'a quoted command word');
  blocked(bashHook(dir, 'less -O out.txt .claude/settings.json'), 'less -O writes a log file');
  blocked(bashHook(dir, 'less -oout.txt .claude/settings.json'), 'less -o with the file attached');
  blocked(bashHook(dir, 'less "-o" out.txt .claude/settings.json'), 'a quoted less -o');
  blocked(bashHook(dir, 'less +!./x.sh .claude/settings.json'), 'less +cmd runs a command');
  blocked(bashHook(dir, 'echo x >> .workflow/state/approvals.jsonl'), 'echo >> approvals.jsonl');
});

test(`Bash: the check is text-only, so the documented limits pass (${SPEC}#ac-28)`, () => {
  const dir = project();
  // Documented in docs/HOOKS.md: a cd followed by a relative write, a path built at run time.
  allowed(bashHook(dir, 'cd .workflow/state && echo x >> approvals.jsonl'), 'a cd, then a relative append');
  allowed(bashHook(dir, 'cd .claude && echo x > hooks/a.sh'), 'a cd into .claude, then a relative write');
  allowed(bashHook(dir, 'D=.claude; echo x > $D/settings.json'), 'a path built at run time');
});

// The hooks under hooks/universal/ that the end-to-end case profiles.
const PROFILE_HOOKS = ['universal/pre-tool/protect-gates.sh', 'universal/pre-tool/protect-gates-bash.sh'];

test(`end to end: the commands init wrote block a gate-file write and pass ls (${SPEC}#ac-28)`, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-gates-e2e-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.workflow'));
  writeFileSync(path.join(dir, '.workflow/profile.yml'), `skills:\nhooks:\n${PROFILE_HOOKS.map(h => `  - ${h}\n`).join('')}subagents:\n`);
  const gitBin = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-gates-e2e-git-')));
  dirs.push(gitBin);
  writeStubGit(gitBin);
  const PATH = `${path.dirname(process.execPath)}${path.delimiter}${gitBin}${path.delimiter}${process.env.PATH}`;
  const init = spawnSync(process.execPath, [path.join(ROOT, 'scripts/devops-cli.js'), 'init', '--no-agile-graph'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH },
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.ok(existsSync(path.join(dir, '.claude/hooks/protect-gates.mjs')), 'init copies the protect-gates.mjs companion');
  const settings = JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  const groups = settings.hooks?.PreToolUse ?? [];
  const writeGate = groups.filter(g => g.matcher === 'Write|Edit|MultiEdit|NotebookEdit').flatMap(g => g.hooks.map(h => h.command))
    .find(command => command.includes('protect-gates.sh'));
  const bashGate = groups.filter(g => g.matcher === 'Bash').flatMap(g => g.hooks.map(h => h.command))
    .find(command => command.includes('protect-gates-bash.sh'));
  assert.ok(writeGate, `init wires protect-gates.sh on the write tools; PreToolUse is ${JSON.stringify(groups)}`);
  assert.ok(bashGate, 'init wires protect-gates-bash.sh on Bash');

  // Claude Code runs a hook command with the shell and the tool call on stdin.
  const through = (command, toolName, toolInput) => spawnSync('bash', ['-c', command], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd: dir, session_id: 'e2e' }),
  });
  const write = through(writeGate, 'Write', { file_path: path.join(dir, '.workflow/state/approvals.jsonl'), content: '{"approved":true}\n' });
  assert.equal(write.status, 2, `a Write to approvals.jsonl through ${writeGate}: ${write.stdout}${write.stderr}`);
  assert.match(write.stderr, BLOCK);
  const edit = through(writeGate, 'Edit', { file_path: path.join(dir, '.claude/settings.json'), old_string: 'a', new_string: 'b' });
  assert.equal(edit.status, 2, `an Edit of settings.json: ${edit.stdout}${edit.stderr}`);
  const append = through(bashGate, 'Bash', { command: 'echo x >> .workflow/state/approvals.jsonl' });
  assert.equal(append.status, 2, `a Bash append to approvals.jsonl through ${bashGate}: ${append.stdout}${append.stderr}`);
  // Reads stay allowed: no group whose matcher includes Read names the gate.
  const readGroups = groups.filter(g => /(^|\|)Read(\||$)/.test(g.matcher ?? ''));
  assert.ok(!readGroups.some(g => g.hooks.some(h => h.command.includes('protect-gates'))), 'reads are not checked');
  const ls = through(bashGate, 'Bash', { command: 'ls' });
  assert.equal(ls.status, 0, `ls through ${bashGate}: ${ls.stdout}${ls.stderr}`);
});
