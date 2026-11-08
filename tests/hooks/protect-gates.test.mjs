// specs/release/npm-package.md AC-28: the agent cannot change its own gates or approvals.
// hooks/universal/pre-tool/protect-gates.sh (file tools) and protect-gates-bash.sh (Bash) call
// protect-gates.mjs. These cases run the real hooks against a temp project; the end-to-end case
// runs the commands that `devops init` wrote to .claude/settings.json, through `bash -c`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  mkdirSync(path.join(dir, '.git'));
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
  blocked(fileHook(dir, '.workflow/state/approvals.jsonl'), 'approvals.jsonl, relative');
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
});

test(`file tools: a symlink, a dot-dot path and a dangling link to a gate file are blocked (${SPEC}#ac-28)`, () => {
  const dir = project();
  symlinkSync('.claude/settings.json', path.join(dir, 'link.json'));
  symlinkSync('.claude', path.join(dir, 'alias'));
  symlinkSync('.claude/settings.local.json', path.join(dir, 'dangling-local.json'));
  rmSync(path.join(dir, '.claude/settings.local.json'));
  blocked(fileHook(dir, path.join(dir, 'link.json')), 'a symlink to settings.json');
  blocked(fileHook(dir, path.join(dir, 'alias/settings.json')), 'a path through a symlinked directory');
  blocked(fileHook(dir, './.claude/../.claude/settings.json'), './.claude/../.claude/settings.json');
  blocked(fileHook(dir, path.join(dir, 'dangling-local.json')), 'a dangling symlink to a gate file');
});

test(`file tools: a path that is not a gate file passes (${SPEC}#ac-28)`, () => {
  const dir = project();
  for (const target of ['src/app.ts', 'docs/x.md', '.claude/agents/foo.md', path.join(dir, 'src/app.ts'), 'settings.json', '.workflow/state/events.jsonl']) {
    allowed(fileHook(dir, target), target);
  }
});

test(`file tools: an empty path passes; an internal error fails closed (${SPEC}#ac-28)`, () => {
  const dir = project();
  allowed(fileHook(dir, ''), 'empty path');
  // A root that is a symbolic loop cannot be resolved, which is an internal error.
  symlinkSync('loop', path.join(dir, 'loop'));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: path.join(dir, 'loop') };
  const broken = spawnSync('bash', [FILE_HOOK, 'src/app.ts'], { cwd: dir, env, encoding: 'utf8' });
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
  // From src/, a relative path is taken from the git top level, so it names the protected file.
  const r = spawnSync('bash', [FILE_HOOK, '.claude/settings.json'], { cwd: path.join(dir, 'src'), env, encoding: 'utf8' });
  blocked(r, 'relative path from a subdirectory of the git work tree');
});

test(`on darwin the names match case-insensitively; elsewhere they are case-sensitive (${SPEC}#ac-28)`, () => {
  const dir = project();
  const r = fileHook(dir, '.CLAUDE/Settings.json');
  if (process.platform === 'darwin' || process.platform === 'win32') blocked(r, '.CLAUDE/Settings.json');
  else allowed(r, '.CLAUDE/Settings.json on a case-sensitive file system');
});

test(`Bash: a command that writes a gate file is blocked; plain reads pass (${SPEC}#ac-28)`, () => {
  const dir = project();
  blocked(bashHook(dir, 'echo x >> .workflow/state/approvals.jsonl'), 'echo >> approvals.jsonl');
  blocked(bashHook(dir, 'echo x>.workflow/state/approvals.jsonl'), 'echo >approvals.jsonl with no space');
  blocked(bashHook(dir, 'cd .workflow/state && echo x >> approvals.jsonl'), 'cd and append');
  blocked(bashHook(dir, 'rm .claude/settings.json'), 'rm settings.json');
  blocked(bashHook(dir, 'cp x .claude/hooks/block-rm-rf.sh'), 'cp into .claude/hooks');
  blocked(bashHook(dir, 'cat .claude/settings.json | tee x'), 'cat piped to tee');
  blocked(bashHook(dir, 'jq -i . .claude/settings.json'), 'jq -i');
  blocked(bashHook(dir, './.claude/../.claude/settings.json'), 'a dot-dot path to settings.json');
  allowed(bashHook(dir, 'cat .claude/settings.json'), 'cat settings.json');
  allowed(bashHook(dir, 'ls'), 'ls');
  allowed(bashHook(dir, 'head -n 3 .workflow/state/approvals.jsonl'), 'head of approvals.jsonl');
  allowed(bashHook(dir, 'grep -i secret .claude/hooks/block-rm-rf.sh'), 'grep -i in .claude/hooks');
  allowed(bashHook(dir, 'git status'), 'git status');
  allowed(bashHook(dir, 'git diff -- .claude/settings.json'), 'git diff of settings.json');
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
