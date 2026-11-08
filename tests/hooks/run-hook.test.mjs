// specs/release/npm-package.md REQ-15, AC-27 (issue #418): hooks/claude-code/run-hook.mjs runs one
// DevOPs hook for one Claude Code tool call. These cases run the runner with real stdin JSON
// against stub hooks in a temp .claude/hooks/. The end-to-end case runs the exact command that
// `devops init` wrote to .claude/settings.json, through `bash -c`, as Claude Code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from '../fixtures/stub-git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = path.join(ROOT, 'hooks/claude-code/run-hook.mjs');
const SPEC = 'specs/release/npm-package.md';

// A stand-in `git` for the runner's root lookup: prints STUB_GIT_TOPLEVEL, or fails as a non-repo.
const STUB_BIN = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-hook-git-')));
writeFileSync(path.join(STUB_BIN, 'git'), '#!/bin/sh\nif [ -n "$STUB_GIT_TOPLEVEL" ]; then printf \'%s\\n\' "$STUB_GIT_TOPLEVEL"; exit 0; fi\nexit 128\n');
chmodSync(path.join(STUB_BIN, 'git'), 0o755);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));

const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project root with stub hooks: `hooks` maps a file name to its shell body. */
function project(hooks = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-hook-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
  for (const [name, body] of Object.entries(hooks)) {
    const file = path.join(dir, '.claude/hooks', name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/**
 * Runs the runner. `root` is the project root for CLAUDE_PROJECT_DIR (null leaves it unset);
 * `gitTopLevel` is what the stub git reports (null: not a repository).
 */
function runner(args, { input = '', root = null, gitTopLevel = null, cwd } = {}) {
  const env = { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.STUB_GIT_TOPLEVEL;
  if (root !== null) env.CLAUDE_PROJECT_DIR = root;
  if (gitTopLevel !== null) env.STUB_GIT_TOPLEVEL = gitTopLevel;
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: cwd ?? root ?? ROOT, env, input, encoding: 'utf8',
  });
}
const payload = toolInput => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput });

test(`pre: a hook that exits 2 blocks, and its message reaches stderr (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'echo "blocked: $1" >&2; exit 2' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'rm -rf /' }) });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /blocked: rm -rf \//);
});

test(`pre: any other hook exit fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'exit 1' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'ls' }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HOOK: block-rm-rf\.sh exited 1 -- failing closed/);
});

test(`pre: a hook killed by a signal fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'kill -TERM $$' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'ls' }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /killed by SIGTERM -- failing closed/);
});

test(`pre: exit 0 passes, and the hook's stdout is passed through (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'echo ok; exit 0' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'ls' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok\n');
});

test(`pre: a missing hook fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({});
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'ls' }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hook missing: .*block-rm-rf\.sh -- failing closed/);
});

test(`pre: unparseable stdin fails closed, and so does empty stdin (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'exit 0' });
  for (const input of ['not json', '', '[1,2]', '"text"']) {
    const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input });
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /failing closed/);
  }
});

test(`pre: a command that is not a string fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'exit 0' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 5 }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a string -- failing closed/);
});

test(`an empty or absent field exits 0 and the hook does not run (${SPEC}#ac-27)`, () => {
  const dir = project({
    'block-rm-rf.sh': 'touch ran-command; exit 2',
    'block-secrets.sh': 'touch ran-file; exit 2',
  });
  const cases = [
    ['pre', 'block-rm-rf.sh', 'command', payload({ command: '' })],
    ['pre', 'block-rm-rf.sh', 'command', payload({})],
    ['pre', 'block-rm-rf.sh', 'command', JSON.stringify({ tool_name: 'Read' })],
    ['pre', 'block-secrets.sh', 'file', JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '' } })],
  ];
  for (const [phase, hook, input, body] of cases) {
    const r = runner([phase, hook, input], { root: dir, input: body });
    assert.equal(r.status, 0, `${hook} ${input} ${body}: ${r.stderr}`);
  }
  assert.equal(existsSync(path.join(dir, 'ran-command')), false, 'the command hook did not run');
  assert.equal(existsSync(path.join(dir, 'ran-file')), false, 'the file hook did not run');
});

test(`stdin mode hands the hook --payload-stdin and the exact payload bytes (${SPEC}#ac-27)`, () => {
  const dir = project({ 'deploy-gate.sh': 'printf %s "$1" > arg.txt; cat > stdin.bin; exit 0' });
  const body = '  {"tool_name":"Bash","tool_input":{"command":"git push origin \\"main\\"; $(id) \u00e9"}}\n\t';
  const r = runner(['pre', 'deploy-gate.sh', 'stdin'], { root: dir, input: body });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, 'arg.txt'), 'utf8'), '--payload-stdin');
  assert.deepEqual(readFileSync(path.join(dir, 'stdin.bin')), Buffer.from(body, 'utf8'));
});

test(`command mode passes the command as one argument, and nothing in it runs (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'printf %s "$1" > arg.txt; printf %s "$#" > count.txt; exit 0' });
  const command = `echo "a  b"; touch ${dir}/semi && cat 'x' | $(touch ${dir}/subst) \`touch ${dir}/tick\` it's "q"`;
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, 'arg.txt'), 'utf8'), command);
  assert.equal(readFileSync(path.join(dir, 'count.txt'), 'utf8'), '1');
  for (const marker of ['semi', 'subst', 'tick']) assert.equal(existsSync(path.join(dir, marker)), false, `${marker} was not run`);
});

test(`file mode runs the hook once per distinct file field, in order (${SPEC}#ac-27)`, () => {
  const dir = project({
    'block-secrets.sh': 'printf "%s\\n" "$1" >> args.txt; exit 0',
    'gitleaks-scan.sh': 'printf "%s\\n" "$1" >> args.txt; exit 0',
  });
  const argsFile = path.join(dir, 'args.txt');
  const cases = [
    [{ tool_input: { file_path: '/p/a.env', notebook_path: '/p/n.ipynb' } }, ['/p/a.env', '/p/n.ipynb']],
    [{ tool_input: { file_path: '', notebook_path: '/p/n.ipynb' } }, ['/p/n.ipynb']],
    [{ tool_input: {}, tool_response: { filePath: '/p/r.ts' } }, ['/p/r.ts']],
    [{ tool_input: { file_path: '/p/a.ts', path: '/p/a.ts' } }, ['/p/a.ts']],
    [{ tool_input: { path: '/p/dir/x.ts' } }, ['/p/dir/x.ts']],
  ];
  for (const [body, expected] of cases) {
    rmSync(argsFile, { force: true });
    const r = runner(['pre', 'block-secrets.sh', 'file'], { root: dir, input: JSON.stringify(body) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(argsFile, 'utf8').split('\n').filter(Boolean), expected, JSON.stringify(body));
  }
  rmSync(argsFile, { force: true });
  const post = runner(['post', 'gitleaks-scan.sh', 'file'], { root: dir, input: JSON.stringify({ tool_input: {}, tool_response: { filePath: '/p/r.ts' } }) });
  assert.equal(post.status, 0, post.stderr);
  assert.deepEqual(readFileSync(argsFile, 'utf8').split('\n').filter(Boolean), ['/p/r.ts']);
});

test(`pre: a blocked notebook_path blocks even when file_path is benign (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-secrets.sh': 'case "$1" in *.env) echo "blocked: $1" >&2; exit 2;; esac; exit 0' });
  const r = runner(['pre', 'block-secrets.sh', 'file'], {
    root: dir,
    input: JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { file_path: '/p/benign.txt', notebook_path: '/p/secret.env' } }),
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /blocked: \/p\/secret\.env/);
});

test(`pre: a non-zero exit on any file field fails closed, even when another field passes (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-secrets.sh': 'case "$1" in *.broken) exit 1;; esac; exit 0' });
  const r = runner(['pre', 'block-secrets.sh', 'file'], {
    root: dir,
    input: JSON.stringify({ tool_input: { file_path: '/p/ok.txt', notebook_path: '/p/x.broken' } }),
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /HOOK: block-secrets\.sh exited 1 -- failing closed/);
});

test(`pre: a NUL byte in the command fails closed from the runner, with no stack trace (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'exit 0' });
  const r = runner(['pre', 'block-rm-rf.sh', 'command'], { root: dir, input: payload({ command: 'ls\u0000 -la' }) });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^HOOK: .+ -- failing closed\n/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no uncaught exception');
});

test(`post: an error in the runner is printed and exits 0, except for gitleaks-scan.sh, which exits 2 (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-secrets.sh': 'exit 0', 'gitleaks-scan.sh': 'exit 0' });
  const body = JSON.stringify({ tool_input: { file_path: '/p/a\u0000.ts' } });
  const other = runner(['post', 'block-secrets.sh', 'file'], { root: dir, input: body });
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stderr, /^HOOK: .+/);
  assert.doesNotMatch(other.stderr, /failing closed/);
  const leak = runner(['post', 'gitleaks-scan.sh', 'file'], { root: dir, input: body });
  assert.equal(leak.status, 2, leak.stderr);
});

test(`a hook name outside the allowlist, or with a path part, is refused (${SPEC}#ac-27)`, () => {
  const dir = project({ 'evil.sh': 'touch ran; exit 0', 'block-rm-rf.sh': 'exit 0' });
  for (const name of ['evil.sh', '../evil.sh', 'sub/block-rm-rf.sh', 'block-rm-rf.sh/../evil.sh', '']) {
    const r = runner(['pre', name, 'command'], { root: dir, input: payload({ command: 'ls' }) });
    assert.equal(r.status, 2, `${JSON.stringify(name)}: ${r.stderr}`);
    assert.match(r.stderr, /is not one run-hook\.mjs runs -- failing closed/);
  }
  assert.equal(existsSync(path.join(dir, 'ran')), false, 'the refused hook did not run');
});

test(`an unknown phase or input fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'exit 0' });
  const body = payload({ command: 'ls' });
  assert.equal(runner(['during', 'block-rm-rf.sh', 'command'], { root: dir, input: body }).status, 2);
  assert.equal(runner(['pre', 'block-rm-rf.sh', 'argv'], { root: dir, input: body }).status, 2);
  assert.equal(runner(['pre', 'block-rm-rf.sh'], { root: dir, input: body }).status, 2);
});

test(`post: a non-zero hook exit is printed and exits 0 (${SPEC}#ac-27)`, () => {
  const dir = project({ 'gitleaks-scan.sh': 'exit 1' });
  const r = runner(['post', 'gitleaks-scan.sh', 'file'], { root: dir, input: JSON.stringify({ tool_input: { file_path: '/p/a.ts' } }) });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /HOOK: gitleaks-scan\.sh exited 1/);
});

test(`post: gitleaks-scan.sh exit 2 passes through so Claude Code sees the leak (${SPEC}#ac-27)`, () => {
  const dir = project({ 'gitleaks-scan.sh': 'echo leak >&2; exit 2' });
  const r = runner(['post', 'gitleaks-scan.sh', 'file'], { root: dir, input: JSON.stringify({ tool_input: { file_path: '/p/a.ts' } }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /leak/);
});

test(`the root is CLAUDE_PROJECT_DIR, else the git top level, and an unresolvable root fails closed (${SPEC}#ac-27)`, () => {
  const dir = project({ 'block-rm-rf.sh': 'pwd > where.txt; exit 0' });
  const body = payload({ command: 'ls' });
  const fromGit = runner(['pre', 'block-rm-rf.sh', 'command'], { gitTopLevel: dir, cwd: dir, input: body });
  assert.equal(fromGit.status, 0, fromGit.stderr);
  assert.equal(readFileSync(path.join(dir, 'where.txt'), 'utf8').trim(), dir, 'the hook ran in the root');
  const unresolved = runner(['pre', 'block-rm-rf.sh', 'command'], { cwd: dir, input: body });
  assert.equal(unresolved.status, 2);
  assert.match(unresolved.stderr, /cannot resolve the project root .* -- failing closed/);
});

// Every hook under hooks/universal/, as a profile lists it (the wiring table covers each one).
const PROFILE_HOOKS = [
  'universal/pre-tool/block-new-dependency.sh', 'universal/pre-tool/block-prod-write.sh',
  'universal/pre-tool/block-rm-rf.sh', 'universal/pre-tool/block-sealed-refs.sh',
  'universal/pre-tool/block-secrets.sh', 'universal/pre-tool/budget-brake.sh',
  'universal/pre-tool/client-boundary.sh', 'universal/pre-tool/deploy-gate.sh',
  'universal/pre-tool/external-content-boundary.sh', 'universal/pre-tool/loop-detection.sh',
  'universal/post-tool/auto-format.sh', 'universal/post-tool/gitleaks-scan.sh',
  'universal/post-tool/sync-lr-refined-date.sh', 'universal/session-end/rotate-session-key.sh',
  'universal/session-end/write-baton.sh', 'universal/session-start/graph-preflight.sh',
  'universal/session-start/load-baton.sh',
];

test(`end to end: the command init wrote blocks rm -rf / and passes ls (${SPEC}#ac-27)`, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-hook-e2e-')));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.workflow'));
  writeFileSync(path.join(dir, '.workflow/profile.yml'), `skills:\nhooks:\n${PROFILE_HOOKS.map(h => `  - ${h}\n`).join('')}subagents:\n`);
  const gitBin = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-hook-e2e-git-')));
  dirs.push(gitBin);
  writeStubGit(gitBin);
  const PATH = `${path.dirname(process.execPath)}${path.delimiter}${gitBin}${path.delimiter}${process.env.PATH}`;
  const init = spawnSync(process.execPath, [path.join(ROOT, 'scripts/devops-cli.js'), 'init', '--no-agile-graph'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH },
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);

  const settings = JSON.parse(readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  const bash = (settings.hooks?.PreToolUse ?? []).filter(group => group.matcher === 'Bash').flatMap(group => group.hooks.map(h => h.command));
  const rmRf = bash.find(command => command.includes('block-rm-rf.sh'));
  assert.ok(rmRf, `init wires block-rm-rf.sh on Bash; the Bash commands are ${JSON.stringify(bash)}`);

  // Claude Code runs a hook command with the shell, and the tool call on stdin.
  const through = (command, toolCommand) => spawnSync('bash', ['-c', command], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH, CLAUDE_PROJECT_DIR: dir },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: toolCommand }, cwd: dir, session_id: 'e2e' }),
  });
  const blocked = through(rmRf, 'rm -rf /');
  assert.equal(blocked.status, 2, `rm -rf / through ${rmRf}: ${blocked.stdout}${blocked.stderr}`);
  for (const command of bash) {
    const r = through(command, 'ls');
    assert.equal(r.status, 0, `ls through ${command}: ${r.stdout}${r.stderr}`);
  }
  // node missing from Claude Code's PATH exits 127, which Claude Code does not treat as a block.
  const noNode = spawnSync('/bin/bash', ['-c', rmRf], {
    cwd: dir, encoding: 'utf8', env: { PATH: path.join(dir, 'no-such-bin'), CLAUDE_PROJECT_DIR: dir },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }),
  });
  assert.equal(noNode.status, 2, `without node on PATH: ${noNode.stdout}${noNode.stderr}`);
});
