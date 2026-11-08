#!/usr/bin/env node
// hooks/universal/pre-tool/protect-gates.mjs
//
// Decides whether an agent tool call may change DevOPs's gates or approvals (specs/release/
// npm-package.md AC-28). Called by protect-gates.sh and protect-gates-bash.sh, beside it.
//
//   protect-gates.mjs <path>              a file tool's target path: exit 2 when protected
//   protect-gates.mjs <command> --command a Bash command: exit 2 when it names a protected path
//                                         and is not a plain read (a heuristic, see docs/HOOKS.md)
//
// Exit 0 allows. Exit 2 blocks, and so does any internal error. Node only, no dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';
const fold = value => (FOLD_CASE ? value.toLowerCase() : value);

const PROTECTED_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.workflow/state/approvals.jsonl',
  '.workflow/state/install-manifest.json',
];
// A directory and everything under it.
const PROTECTED_DIRS = ['.claude/hooks', '.workflow/state/originals'];
// Relative forms the Bash check looks for anywhere in the command text.
const COMMAND_NAMES = [...PROTECTED_FILES, ...PROTECTED_DIRS];
// A bare file name that names a protected file in any directory.
const PROTECTED_BASENAMES = ['settings.json', 'settings.local.json', 'approvals.jsonl', 'install-manifest.json'];

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'grep', 'rg', 'ls', 'stat', 'wc', 'diff']);
// Only `git status`: diff, log and show accept --output=<file> and can run an external diff
// program configured in .git/config, which the agent can write.
const GIT_READS = new Set(['status']);
// Any of these leads into another command or a write: a redirection, a pipe, a list, a
// background job, a subshell, a substitution or a newline.
const CHAINS = /[>|;&()`\n\r]|\$\(/;
const MAX_LINKS = 40;

// CLAUDE_PROJECT_DIR, else the git top level, else the current directory.
function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (!git.error && git.status === 0 && git.stdout.trim() !== '') return path.resolve(git.stdout.trim());
  return process.cwd();
}

// Resolves symlinks one component at a time, as the kernel does, so `link/..` means the parent
// of the link's target. A component that does not exist yet is kept as written. A dangling link
// is followed to its target. `abs` is absolute and is not normalised first.
function realish(abs) {
  let cur = path.parse(abs).root;
  const queue = abs.slice(cur.length).split(path.sep).filter(part => part !== '');
  let links = 0;
  while (queue.length > 0) {
    const part = queue.shift();
    if (part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, part);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        cur = next;
        continue;
      }
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      cur = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) throw new Error(`too many symbolic links at ${next}`);
    const target = path.resolve(cur, fs.readlinkSync(next));
    const targetRoot = path.parse(target).root;
    queue.unshift(...target.slice(targetRoot.length).split(path.sep).filter(item => item !== ''));
    cur = targetRoot;
  }
  return cur;
}

// Joins `rel` onto an absolute `base` without normalising, so `..` and symlinks resolve in order.
function under(base, rel) {
  return `${base.endsWith(path.sep) ? base : base + path.sep}${rel}`;
}

// A file-tool path, as the real path it would write: `~` expanded, relative paths taken from root.
function resolveTarget(root, input) {
  let text = input;
  if (text === '~' || /^~[\\/]/.test(text)) text = os.homedir() + text.slice(1);
  return realish(path.isAbsolute(text) ? text : under(root, text));
}

function isProtected(real, protectedFiles, protectedDirs) {
  const value = fold(real);
  if (protectedFiles.some(file => value === fold(file))) return true;
  return protectedDirs.some(dir => {
    const folded = fold(dir);
    return value === folded || value.startsWith(folded + path.sep);
  });
}

function protectedPaths(root) {
  return {
    files: PROTECTED_FILES.map(rel => realish(under(root, rel))),
    dirs: PROTECTED_DIRS.map(rel => realish(under(root, rel))),
  };
}

function relativeTo(root, real) {
  const rel = path.relative(root, real);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? real : rel.split(path.sep).join('/');
}

// The block message for a file tool's path, or null when the path may be changed.
function fileBlock(root, input) {
  const { files, dirs } = protectedPaths(root);
  const real = resolveTarget(root, input);
  if (!isProtected(real, files, dirs)) return null;
  return `DevOPs GATE BLOCK: ${relativeTo(root, real)} holds DevOPs gates or approvals; change it yourself outside the agent`;
}

// True when the command is a plain read: a read-only first word, no chaining, no redirection.
function isPlainRead(command) {
  if (CHAINS.test(command)) return false;
  const words = command.trim().split(/\s+/);
  const [first, second] = words;
  // rg --pre runs a program on each file it searches.
  if (first === 'rg' && words.some(word => /^--pre(=|$)/.test(word))) return false;
  if (READ_COMMANDS.has(first)) return true;
  if (first === 'jq') return !words.some(word => /^-[A-Za-z]*i[A-Za-z]*$/.test(word));
  return first === 'git' && GIT_READS.has(second);
}

// The block message for a Bash command, or null when the command may run.
function commandBlock(root, command) {
  const folded = fold(command);
  const named = COMMAND_NAMES.find(rel => folded.includes(fold(rel)));
  const { files, dirs } = protectedPaths(root);
  const pieces = command.split(/[\s;&|<>()`'"=,]+/).filter(piece => piece !== '');
  const found = named ?? pieces.find(piece => {
    if (PROTECTED_BASENAMES.some(name => fold(piece.split('/').pop()) === fold(name))) return true;
    try {
      return isProtected(resolveTarget(root, piece), files, dirs);
    } catch {
      return false; // a token that cannot be a path names nothing
    }
  });
  if (found === undefined || isPlainRead(command)) return null;
  return `DevOPs GATE BLOCK: this command names ${found}, which holds DevOPs gates or approvals; change it yourself outside the agent`;
}

function main(argv) {
  const [target, flag, ...rest] = argv;
  if (target === undefined || rest.length > 0 || (flag !== undefined && flag !== '--command')) {
    process.stderr.write('DevOPs GATE BLOCK: usage: protect-gates.mjs <path> | <command> --command -- failing closed\n');
    return 2;
  }
  if (target === '') return 0;
  try {
    const root = realish(projectRoot());
    const message = flag === '--command' ? commandBlock(root, target) : fileBlock(root, target);
    if (message === null) return 0;
    process.stderr.write(`${message}\n`);
    return 2;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DevOPs GATE BLOCK: protect-gates could not check the path: ${reason} -- failing closed\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
