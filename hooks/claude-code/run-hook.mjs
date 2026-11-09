#!/usr/bin/env node
// hooks/claude-code/run-hook.mjs
//
// Runs one DevOPs hook for one Claude Code tool call (specs/release/npm-package.md REQ-15,
// issue #418). `devops init` copies this file to .claude/hooks/run-hook.mjs and names it in
// .claude/settings.json:
//
//   node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/run-hook.mjs" <pre|post> <hook-file> <input>
//
// Claude Code sends the tool call as JSON on stdin. <input> says what the hook takes:
//   stdin    the hook gets --payload-stdin and the raw stdin bytes;
//   command  the hook gets tool_input.command as its one argument ($1);
//   file     the hook runs once for each distinct non-empty one of tool_input.file_path,
//            tool_input.notebook_path, tool_input.path and tool_response.filePath, with that
//            string as its one argument ($1). For a Glob call that is also tool_input.pattern (a
//            path glob); for a Grep call it is tool_input.glob (a file filter). Grep's
//            tool_input.pattern is a regex, not a path, and is never passed.
//   The value of a command or file input is not put on argv: an argument is capped at 128 KB on
//   Linux (MAX_ARG_STRLEN), and a command can be longer. It goes to bash on stdin, which sets $1
//   from it and sources the hook, so $0 is still the hook's path and `dirname "$0"` still works.
//   A value holding a NUL byte cannot be passed that way, and fails closed in pre.
// An absent or empty field inside tool_input means the call has nothing to check: exit 0, and the
// hook does not run. A missing tool_input itself is different: a pre command or file hook fails closed.
//
// pre: exit 0 passes and exit 2 blocks. The first non-zero result from any run decides. All the pre runs
// of one call get 30 s together; a run still going then is killed and the call fails closed. Anything
// else (a signal, a missing hook, unparseable stdin, an unresolvable root, an error thrown while
// running) fails closed: exit 2 with "failing closed" on stderr.
// post: always exit 0, except gitleaks-scan.sh's exit 2, which passes through so Claude Code
// shows the leak. Any other non-zero hook exit is printed to stderr.
//
// The hook runs with spawnSync. bash reads a command or file value from stdin as data (it runs no
// shell over it), so the value is never parsed by a shell. Node only, no dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PHASES = ['pre', 'post'];
const INPUTS = ['stdin', 'command', 'file'];
// The hooks init wires through this file. Any other name is refused.
const HOOKS = [
  'deploy-gate.sh',
  'block-sealed-refs.sh',
  'block-prod-write.sh',
  'block-rm-rf.sh',
  'block-new-dependency.sh',
  'block-secrets.sh',
  'block-secrets-bash.sh',
  'protect-gates.sh',
  'protect-gates-bash.sh',
  'gitleaks-scan.sh',
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absent = value => value === undefined || value === null || value === '';
// The extra file-mode field a search call names: Glob's pattern is a path glob, Grep's glob is a file
// filter. Grep's pattern is a regex, so it is never a path and is not read here.
const globField = (toolName, toolInput) => {
  if (toolName === 'Glob') return toolInput.pattern;
  if (toolName === 'Grep') return toolInput.glob;
  return undefined;
};
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const isDirectory = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

// Returns the exit code. A pre refusal is 2; a post refusal is reported and is 0.
function refuse(phase, reason) {
  if (phase === 'pre') {
    process.stderr.write(`HOOK: ${reason} -- failing closed\n`);
    return 2;
  }
  process.stderr.write(`HOOK: ${reason}\n`);
  return 0;
}

// CLAUDE_PROJECT_DIR when set, else the top of the git work tree the current directory is in.
function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (git.error || git.status !== 0 || git.stdout.trim() === '') return null;
  return path.resolve(git.stdout.trim());
}

// Bash reads the value up to a NUL byte from stdin, sets "$1" from it, then sources the hook with
// "$0" set to the hook's path, so the hook sees the same $1 and $0 it would see from argv.
const VALUE_FROM_STDIN = 'IFS= read -r -d "" __devops_arg; set -- "$__devops_arg"; unset __devops_arg; . "$0"';

// Runs the hook once with one argument. Returns its exit code under the rules in the header.
// A pre hook that runs past Claude Code's hook timeout (60 s or more) lets the tool call through, so
// run-hook.mjs gives all the pre runs of one call 30 s together and fails closed when they use it up.
// DEVOPS_HOOK_BUDGET_MS may lower the budget (tests do), never raise it: a lower budget only blocks
// sooner. A helper a hook started may outlive the hook; it can no longer change the decision.
const PRE_BUDGET_MS = 30_000;
// A hook's message may quote a long command, so its output may be large.
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const preBudgetMs = () => {
  const lowered = Number(process.env.DEVOPS_HOOK_BUDGET_MS);
  return Number.isInteger(lowered) && lowered > 0 ? Math.min(lowered, PRE_BUDGET_MS) : PRE_BUDGET_MS;
};
let preDeadline = null;

function runOnce(phase, hookFile, hookPath, root, input, raw, arg) {
  const fail = reason => refuse(phase, reason);
  let limits = {};
  if (phase === 'pre') {
    preDeadline ??= Date.now() + preBudgetMs();
    const left = preDeadline - Date.now();
    if (left <= 0) return fail(`${hookFile} did not finish within the ${preBudgetMs() / 1000} s hook budget`);
    limits = { timeout: left, killSignal: 'SIGKILL' };
  }
  let run;
  if (input === 'stdin') {
    run = spawnSync('bash', [hookPath, arg], { cwd: root, input: raw, stdio: 'pipe', maxBuffer: OUTPUT_LIMIT, ...limits });
  } else {
    // A NUL byte ends the value early on the way to bash, so it is refused here. Thrown, as before,
    // so main() reports it: failing closed in pre, printed in post.
    if (arg.includes('\u0000')) throw new Error(`the tool call's ${input === 'command' ? 'command' : 'file path'} contains a NUL byte`);
    run = spawnSync('bash', ['-c', VALUE_FROM_STDIN, hookPath], {
      cwd: root,
      input: Buffer.concat([Buffer.from(arg, 'utf8'), Buffer.from([0])]),
      stdio: 'pipe', maxBuffer: OUTPUT_LIMIT,
      ...limits,
    });
  }
  // The hook's stderr comes back through its own pipe, not run-hook.mjs's: a helper that outlives a
  // killed hook then holds only that pipe, so Claude Code is not left waiting on run-hook.mjs's output.
  if (run.stderr && run.stderr.length > 0) process.stderr.write(run.stderr);
  if (run.error?.code === 'ETIMEDOUT') return fail(`${hookFile} did not finish within the ${preBudgetMs() / 1000} s hook budget`);
  if (run.error) return fail(`could not run ${hookFile}: ${run.error.message}`);
  if (run.stdout && run.stdout.length > 0) process.stdout.write(run.stdout);
  if (run.signal) return fail(`${hookFile} was killed by ${run.signal}`);

  if (run.status === 0) return 0;
  if (phase === 'pre') {
    return run.status === 2 ? 2 : fail(`${hookFile} exited ${run.status}`);
  }
  if (hookFile === 'gitleaks-scan.sh' && run.status === 2) return 2;
  process.stderr.write(`HOOK: ${hookFile} exited ${run.status}\n`);
  return 0;
}

function runHook() {
  const [phase, hookFile, input, ...rest] = process.argv.slice(2);
  if (!PHASES.includes(phase)) return refuse('pre', `unknown phase ${JSON.stringify(phase)}; expected pre or post`);
  const fail = reason => refuse(phase, reason);

  if (rest.length > 0 || !INPUTS.includes(input)) {
    return fail('usage: run-hook.mjs <pre|post> <hook-file> <stdin|command|file>');
  }
  if (typeof hookFile !== 'string' || hookFile.includes('/') || hookFile.includes('..') || !HOOKS.includes(hookFile)) {
    return fail(`hook ${JSON.stringify(hookFile)} is not one run-hook.mjs runs`);
  }

  let raw;
  try {
    raw = fs.readFileSync(0);
  } catch (error) {
    return fail(`cannot read the tool call from stdin (${error.code ?? error.message})`);
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail('stdin is not JSON');
  }
  if (!isObject(payload)) return fail('stdin JSON is not an object');
  // An absent or null tool_input is a missing field. A command or file hook reads it, so the call
  // fails closed; a stdin hook reads the raw payload itself, so it runs after a warning. Post hooks
  // are not changed. A tool_input that is present but not an object fails below.
  const toolInputAbsent = payload.tool_input === undefined || payload.tool_input === null;
  if (toolInputAbsent && phase === 'pre' && input !== 'stdin') return fail('tool_input is missing from the tool call');
  if (toolInputAbsent && phase === 'pre') {
    process.stderr.write(`HOOK: warning: tool_input is missing from the tool call; ${hookFile} runs without it\n`);
  }
  const toolInput = toolInputAbsent ? {} : payload.tool_input;
  if (!isObject(toolInput)) return fail('tool_input is not an object');
  const toolResponse = isObject(payload.tool_response) ? payload.tool_response : {};

  // One argument per run: the stdin payload, the command, or each distinct file field present.
  let args;
  if (input === 'stdin') {
    args = ['--payload-stdin'];
  } else {
    const fields = input === 'command'
      ? [toolInput.command]
      : [toolInput.file_path, toolInput.notebook_path, toolInput.path, toolResponse.filePath, globField(payload.tool_name, toolInput)];
    const present = fields.filter(value => !absent(value));
    if (present.length === 0) return 0; // nothing in this call for the hook to check
    if (present.some(value => typeof value !== 'string')) {
      return fail(`the tool call's ${input === 'command' ? 'command' : 'file path'} is not a string`);
    }
    args = [...new Set(present)];
  }

  const root = projectRoot();
  if (root === null) return fail('cannot resolve the project root (CLAUDE_PROJECT_DIR is unset and this is not a git work tree)');
  if (!isDirectory(root)) return fail(`project root ${root} is not a directory`);
  const hookPath = path.join(root, '.claude', 'hooks', hookFile);
  if (!isFile(hookPath)) return fail(`hook missing: ${hookPath}`);

  // pre: the first non-zero result decides. post: exit 2 only when gitleaks-scan.sh reports a leak.
  let code = 0;
  for (const arg of args) {
    const result = runOnce(phase, hookFile, hookPath, root, input, raw, arg);
    if (phase === 'pre' && result !== 0) return result;
    if (result === 2) code = 2;
  }
  return code;
}

// Any error thrown while running (a NUL byte in an argument, for one) fails closed in pre. In post
// it is printed, and exits 0 except for gitleaks-scan.sh, which passes its leak through as 2.
function main() {
  const [phase, hookFile] = process.argv.slice(2);
  try {
    return runHook();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (phase === 'post') {
      process.stderr.write(`HOOK: ${reason}\n`);
      return hookFile === 'gitleaks-scan.sh' ? 2 : 0;
    }
    process.stderr.write(`HOOK: ${reason} -- failing closed\n`);
    return 2;
  }
}

process.exitCode = main();
