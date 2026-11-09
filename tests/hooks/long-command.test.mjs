// specs/release/npm-package.md AC-31 (issue #426): a Bash command or file path longer than the OS
// per-argument limit (128 KB on Linux, MAX_ARG_STRLEN) reaches every command and file hook intact.
// run-hook.mjs hands the value to the hook on stdin, and the hooks hand it on to their helpers on
// stdin too, so no argv element carries it. These cases use the real hooks in a temp project, with
// a command of about 1 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = path.join(ROOT, 'hooks/claude-code/run-hook.mjs');
const PRE_TOOL = path.join(ROOT, 'hooks/universal/pre-tool');
const SPEC = 'specs/release/npm-package.md';
const MB = 1_000_000;

const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// `size` bytes of words with no quote, backslash, dot or slash, so no hook reads a path in them.
const filler = size => 'lorem ipsum '.repeat(Math.ceil(size / 12)).slice(0, size);

/** A project root holding copies of the real hooks in `files`, and their stub-free .claude/hooks. */
function realProject(files) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'long-command-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'left-pad-toy': '^1.0.0' } }));
  for (const f of files) {
    const dest = path.join(dir, '.claude/hooks', f);
    copyFileSync(path.join(PRE_TOOL, f), dest);
    chmodSync(dest, 0o755);
  }
  return dir;
}

/** A project root with stub hooks: `hooks` maps a file name to its shell body. */
function stubProject(hooks) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'long-command-stub-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
  for (const [name, body] of Object.entries(hooks)) {
    const file = path.join(dir, '.claude/hooks', name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

function runner(args, { input = '', root, env: extra = {} }) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, ...extra };
  delete env.STUB_GIT_TOPLEVEL;
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, env, input, encoding: 'utf8', maxBuffer: 16 * MB, timeout: 180_000 });
}

const bashPayload = command => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// Each Bash-wired hook, the files it needs beside it, a block trigger, and the message it prints.
// The trigger comes first, so a match is found early in a 1 MB command.
const BASH_HOOKS = [
  { hook: 'block-rm-rf.sh', files: ['block-rm-rf.sh'], trigger: 'rm -rf /etc; ', message: /DevOPs RM BLOCK/ },
  { hook: 'block-secrets-bash.sh', files: ['block-secrets-bash.sh', 'block-secrets.sh'], trigger: 'cat .env; ', message: /DevOPs SECRET BLOCK/ },
  { hook: 'deploy-gate.sh', files: ['deploy-gate.sh', 'graph-command-classifier.mjs'], trigger: 'vercel deploy --prod; ', message: /DEPLOY-GATE BLOCK/, wordBound: true },
  { hook: 'block-sealed-refs.sh', files: ['block-sealed-refs.sh', 'graph-command-classifier.mjs'], trigger: 'git push origin :v0.2.0; ', message: /SEALED-REF BLOCK/, wordBound: true },
  { hook: 'block-prod-write.sh', files: ['block-prod-write.sh'], trigger: "echo 'DROP TABLE users'; ", message: /PRODUCTION WRITE BLOCK/ },
  { hook: 'block-new-dependency.sh', files: ['block-new-dependency.sh', 'new-dependency-classifier.mjs'], trigger: 'npm install toy-new; ', message: /NEW-DEPENDENCY BLOCK/ },
  { hook: 'protect-gates-bash.sh', files: ['protect-gates-bash.sh', 'protect-gates.mjs'], trigger: "echo '{}' > .claude/settings.json; ", message: /DevOPs GATE BLOCK/ },
];

for (const { hook, files, trigger, message, wordBound } of BASH_HOOKS) {
  // The graph classifier keeps its 4096-word bound (its analysis is quadratic in the words of one
  // command, and a hook past Claude Code's timeout lets the call through), so its hooks refuse a 1 MB
  // command of 166,000 words at once, with the bound as the reason. Every other hook decides it.
  test(`${hook}: a 1 MB harmless command ${wordBound ? 'is refused at once for its word count' : 'exits 0'} (${SPEC}#ac-31)`, () => {
    const dir = realProject(files);
    const started = process.hrtime.bigint();
    const r = runner(['pre', hook, 'command'], { root: dir, input: bashPayload(`echo ${filler(MB)}`) });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (wordBound) {
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`.slice(0, 500));
      assert.match(r.stderr, /exceeds parser bounds/);
      assert.ok(seconds < 20, `took ${seconds.toFixed(1)} s`);
    } else {
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(0, 500));
    }
    assert.doesNotMatch(r.stderr, /failing closed/);
  });

  test(`${hook}: a 1 MB command with its block trigger exits 2 with the hook's message (${SPEC}#ac-31)`, () => {
    const dir = realProject(files);
    const r = runner(['pre', hook, 'command'], { root: dir, input: bashPayload(`${trigger}echo ${filler(MB)}`) });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`.slice(0, 500));
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /failing closed/);
  });
}

test(`block-secrets.sh (file mode) blocks .env and passes a normal path (${SPEC}#ac-31)`, () => {
  const dir = realProject(['block-secrets.sh']);
  const blocked = runner(['pre', 'block-secrets.sh', 'file'], {
    root: dir, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/p/app/.env' } }),
  });
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /DevOPs SECRET BLOCK/);
  const passed = runner(['pre', 'block-secrets.sh', 'file'], {
    root: dir, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/p/src/index.ts' } }),
  });
  assert.equal(passed.status, 0, passed.stderr);
});

test(`a NUL byte in a 1 MB command fails closed in pre, and the hook does not run (${SPEC}#ac-31)`, () => {
  const dir = stubProject({ 'block-rm-rf.sh': 'touch ran; exit 0' });
  const command = `${filler(MB / 2)}\u0000${filler(MB / 2)}`;
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(command) });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^HOOK: .+ -- failing closed\n/);
  assert.equal(existsSync(path.join(dir, 'ran')), false, 'the hook did not run');
});

test(`a 1 MB command reaches the hook byte for byte, with $0 still the hook path (${SPEC}#ac-31)`, () => {
  const dir = stubProject({ 'block-rm-rf.sh': 'printf %s "$1" > arg.txt; printf %s "$0" > zero.txt; printf %s "$#" > count.txt; exit 0' });
  // Leading and trailing spaces, a newline, a backslash, command substitution text and non-ASCII
  // bytes all stay as written. Nothing in it runs.
  const command = `  $(touch ${dir}/subst) \`touch ${dir}/tick\` \\n é\n${filler(MB)}\t  `;
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(command) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, 'arg.txt'), 'utf8'), command);
  assert.equal(readFileSync(path.join(dir, 'zero.txt'), 'utf8'), path.join(dir, '.claude/hooks/block-rm-rf.sh'));
  assert.equal(readFileSync(path.join(dir, 'count.txt'), 'utf8'), '1');
  for (const marker of ['subst', 'tick']) assert.equal(existsSync(path.join(dir, marker)), false, `${marker} was not run`);
});

// The same text with a newline every 12 characters: grep reads a multi-line input only up to its first
// match, so a trigger found early closes the pipe, and an echo | grep -q check then reads no match.
const multiline = size => 'lorem ipsum\n'.repeat(Math.ceil(size / 12)).slice(0, size);

for (const { hook, files, trigger, message } of BASH_HOOKS) {
  test(`${hook}: a 1 MB multi-line command with its block trigger first exits 2 (${SPEC}#ac-31)`, () => {
    const dir = realProject(files);
    const r = runner(['pre', hook, 'command'], { root: dir, input: bashPayload(`${trigger}echo\n${multiline(MB)}`) });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`.slice(0, 500));
    assert.match(r.stderr, message);
  });
}

test(`block-rm-rf.sh: a 1 MB command ending in rm -rf / exits 2 with the rm-rf refusal (${SPEC}#ac-31)`, () => {
  const dir = realProject(['block-rm-rf.sh']);
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(`echo ${filler(MB)}; rm -rf /`) });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`.slice(0, 500));
  assert.match(r.stderr, /'rm -rf \/' or equivalent/);
});

test(`a 1 MB command is not on the hook's argv: the hook sees it on stdin only (${SPEC}#ac-31)`, () => {
  // ps shows the hook process's argument list. A value on argv would show up there, and an argument
  // over 128 KB cannot be passed on Linux at all.
  const dir = stubProject({ 'block-rm-rf.sh': 'ps -ww -o command= -p $$ > argv.txt; exit 0' });
  const marker = 'ARGV-MARKER-426';
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(`${marker} ${filler(MB)}`) });
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(path.join(dir, 'argv.txt'), 'utf8');
  assert.match(argv, /bash/, 'ps listed the hook process (an empty listing would prove nothing)');
  assert.doesNotMatch(argv, new RegExp(marker), 'the command is not in the hook process argv');
  assert.ok(argv.length < 4096, `the hook argv is short (${argv.length} chars)`);
});

test(`a blocked 1 MB command is logged as valid JSON with at most 4096 characters of it (${SPEC}#ac-31)`, () => {
  const dir = realProject(['block-prod-write.sh']);
  const r = runner(['pre', 'block-prod-write.sh', 'command'], { root: dir, input: bashPayload(`echo 'DROP TABLE users'; ${filler(MB)}`) });
  assert.equal(r.status, 2, r.stderr.slice(0, 300));
  const events = readFileSync(path.join(dir, '.workflow/state/events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(events.length, 1);
  const event = JSON.parse(events[0]);
  assert.equal(event.event, 'prod_write_blocked');
  assert.ok(event.command.length <= 4096 + 40, `the logged command is cut (${event.command.length} chars)`);
  assert.match(event.command, /\.\.\.\[\d+ chars\]$/, 'the cut says how long the command was');
  assert.ok(event.command.startsWith("echo 'DROP TABLE users'"));
});

test(`deploy-gate.sh refuses a command over 4 MiB with the parser's reason (${SPEC}#ac-31)`, () => {
  const dir = realProject(['deploy-gate.sh', 'graph-command-classifier.mjs']);
  const over = runner(['pre', 'deploy-gate.sh', 'command'], { root: dir, input: bashPayload(`echo ${filler(4 * 1024 * 1024 + 1000)}`) });
  assert.equal(over.status, 2, over.stderr.slice(0, 300));
  assert.match(over.stderr, /command exceeds parser bounds/);
});

test(`the --stdin forms of the classifiers decide as their argv forms do (${SPEC}#ac-31)`, () => {
  const dir = realProject(['new-dependency-classifier.mjs', 'protect-gates.mjs']);
  const cases = [
    ['new-dependency-classifier.mjs', ['npm install toy-new'], 2],
    ['new-dependency-classifier.mjs', ['npm install left-pad-toy'], 0],
    ['new-dependency-classifier.mjs', ['echo hi'], 0],
  ];
  for (const [file, [text], expected] of cases) {
    const argv = spawnSync(process.execPath, [path.join(dir, '.claude/hooks', file), text], { cwd: dir, encoding: 'utf8' });
    const stdin = spawnSync(process.execPath, [path.join(dir, '.claude/hooks', file), '--stdin'], { cwd: dir, input: text, encoding: 'utf8' });
    assert.equal(argv.status, expected, `${file} argv ${text}: ${argv.stderr}`);
    assert.equal(stdin.status, expected, `${file} --stdin ${text}: ${stdin.stderr}`);
  }
  const gate = path.join(dir, '.claude/hooks/protect-gates.mjs');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  const gateCases = [
    [['--command'], 'echo "{}" > .claude/settings.json', 2],
    [['--command'], 'cat .claude/settings.json', 0],
    [[], path.join(dir, '.claude/settings.json'), 2],
    [[], path.join(dir, 'src/index.ts'), 0],
  ];
  for (const [flags, text, expected] of gateCases) {
    const argv = spawnSync(process.execPath, [gate, text, ...flags], { cwd: dir, env, encoding: 'utf8' });
    const stdin = spawnSync(process.execPath, [gate, '--stdin', ...flags], { cwd: dir, env, input: text, encoding: 'utf8' });
    assert.equal(argv.status, expected, `argv ${text}: ${argv.stderr}`);
    assert.equal(stdin.status, expected, `--stdin ${text}: ${stdin.stderr}`);
  }
});

// The pattern checks of block-rm-rf.sh and block-prod-write.sh read grep's own status: a grep that
// fails (status 2 and above) blocks instead of reading as no match.
for (const { hook, command } of [
  { hook: 'block-rm-rf.sh', command: 'rm -rf /etc' },
  { hook: 'block-prod-write.sh', command: 'psql -c "DROP TABLE users"' },
]) {
  test(`${hook}: a grep that fails blocks instead of reading as no match (${SPEC}#ac-31)`, () => {
    const dir = realProject([hook]);
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'grep'), '#!/bin/sh\nexit 2\n');
    chmodSync(path.join(bin, 'grep'), 0o755);
    const r = spawnSync('bash', [path.join(dir, '.claude/hooks', hook), command], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /grep failed with status 2/);
  });
}

test(`block-rm-rf.sh decides without temp files: no here-string can fail open (${SPEC}#ac-31)`, { skip: process.platform !== 'darwin' && 'sandbox-exec is macOS only' }, () => {
  const dir = realProject(['block-rm-rf.sh']);
  // bash writes a here-string to a temp file; this sandbox denies every temp folder.
  const profile = '(version 1)(allow default)(deny file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))';
  const hook = path.join(dir, '.claude/hooks/block-rm-rf.sh');
  for (const command of ['rm -rf /', 'rm -rf /etc', ':(){ :|:& };:']) {
    const r = spawnSync('sandbox-exec', ['-p', profile, '/bin/bash', hook, command], { cwd: '/', encoding: 'utf8' });
    assert.equal(r.status, 2, `${command}: ${r.stderr}`);
  }
});

test(`a pre hook that outlasts its time budget blocks (${SPEC}#ac-31)`, () => {
  // A hook past Claude Code's hook timeout would let the call through, so run-hook.mjs blocks first.
  const dir = stubProject({ 'block-rm-rf.sh': 'sleep 20; exit 0' });
  const started = process.hrtime.bigint();
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload('ls'), env: { DEVOPS_HOOK_BUDGET_MS: '1000' } });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /did not finish within the 1 s hook budget[\s\S]*failing closed/);
  assert.ok(seconds < 10, `took ${seconds.toFixed(1)} s`);
});

test(`an invalid budget value leaves the 30 s budget in place (${SPEC}#ac-31)`, () => {
  const dir = stubProject({ 'block-rm-rf.sh': 'sleep 1; exit 0' });
  for (const value of ['abc', '0', '-5', '1.5']) {
    const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload('ls'), env: { DEVOPS_HOOK_BUDGET_MS: value } });
    assert.equal(r.status, 0, `${value}: ${r.stderr}`);
  }
});

test(`block-rm-rf.sh decides a command with many paths: an outside target still blocks, a long message does not (${SPEC}#ac-31)`, () => {
  const dir = realProject(['block-rm-rf.sh']);
  const many = Array.from({ length: 1000 }, (_, i) => `ab${i}`).join(' ');
  const blocked = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(`rm -rf ${many} /etc`) });
  assert.equal(blocked.status, 2, blocked.stderr.slice(0, 300));
  assert.match(blocked.stderr, /DevOPs RM BLOCK/);
  const message = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const allowed = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: bashPayload(`rm -rf dist && git commit -m "${message}"`) });
  assert.equal(allowed.status, 0, allowed.stderr.slice(0, 300));
});
