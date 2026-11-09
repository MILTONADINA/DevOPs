#!/usr/bin/env node
// hooks/universal/pre-tool/protect-gates.mjs
//
// Decides whether an agent tool call may change DevOPs's gates or approvals (specs/release/
// npm-package.md AC-28). Called by protect-gates.sh and protect-gates-bash.sh, beside it.
//
//   protect-gates.mjs <path>              a file tool's absolute target path: exit 2 when it is a gate or
//                                         approval file or directory. A relative path or one with a leading ~
//                                         exits 2 too. Judged by file identity
//                                         ({dev, ino}), so links, letter case and Unicode forms count.
//   protect-gates.mjs <command> --command a Bash command: exit 2 when its text names a gate path, or
//                                         moves a bare .claude or .workflow, and it is not a plain
//                                         read. A convenience guard, not a security boundary: see
//                                         docs/HOOKS.md for what it does not catch.
//   protect-gates.mjs --stdin [--command] the same check, with the path or command read from stdin, so a
//                                         command longer than an argument can be checked (AC-31).
//                                         The two gate hooks use this form (AC-31).
//
// Exit 0 allows. Exit 2 blocks, and so does any internal error. Node only, no dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

// Files and directories the agent cannot change, relative to the project root.
const PROTECTED_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.workflow/state/approvals.jsonl',
  '.workflow/state/install-manifest.json',
];
// A directory and everything under it.
const PROTECTED_DIRS = ['.claude/hooks', '.workflow/state/originals'];
// The exact relative forms the Bash check looks for in the command text.
const GATE_PATHS = [...PROTECTED_FILES, ...PROTECTED_DIRS];
// A bare tree name: with a mover (below) it names the whole tree the command moves or copies.
const BARE_NAMES = ['.claude', '.workflow', '.workflow/state'];
const MOVERS = new Set(['mv', 'rm', 'cp', 'ln', 'tar', 'rsync']);

// Plain reads: when a gate path is named, these pass if the command has no chain. less, though,
// writes a log file with -o, -O or --log-file, and runs commands with +cmd or a lesskey file (-k).
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'grep', 'ls', 'stat', 'wc', 'diff', 'jq']);
// git steps that stage or commit the owner's own change, and the status read.
const GIT_PLAIN = new Set(['add', 'commit', 'status']);
// A pipe stage that only reads its input. sort takes no -o, --output or --compress-program.
const FILTER_STAGE = /\|\s*(?:(?:head|tail|wc|grep)(?:\s+[^|;&<>()`]*)?|sort(?:\s+-[nrufbdhiMVsz]+)*)\s*$/;
const MAX_LINKS = 40;
// The walk of a protected directory: entries up to this many levels below it, and at most this many
// entries in all. Past either limit the check fails closed.
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;

// Names compare folded on every platform: NFD, U+017F as s, then upper and lower case. The protected
// names are ASCII, so a name that folds to one of them is refused on any volume; the cost is small.
function foldName(name) {
  return name.normalize('NFD').replace(/\u017f/g, 's').toUpperCase().toLowerCase();
}

const isAbsent = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

// The components of a path below its root. Windows takes either separator.
const partsOf = text => text.split(WINDOWS ? /[\\/]+/ : /\/+/).filter(part => part !== '');

// Joins components onto a base string without normalising, so `..` and links resolve in order.
function joinRaw(base, parts) {
  let out = base;
  for (const part of parts) out = out.endsWith(path.sep) ? out + part : out + path.sep + part;
  return out;
}

function splitParts(p) {
  const { root } = path.parse(p);
  return { root, parts: partsOf(p.slice(root.length)) };
}

function lstatExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

// The stat of a path, following links, or null when the path does not exist.
function statOrNull(p) {
  try {
    return fs.statSync(p, { bigint: true });
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

const isDirectory = p => statOrNull(p)?.isDirectory() === true;

// The {dev, ino} of a path as one key, following links. null when the path does not exist.
function identityOf(p) {
  const st = statOrNull(p);
  return st === null ? null : `${st.dev}:${st.ino}`;
}

// The real path the kernel reaches for an absolute path: links followed, no `.` or `..` left. The
// deepest existing component is found with lstat and resolved with realpath (the native one, which
// follows the kernel). The components after it do not exist yet: `.` is dropped and `..` takes off
// the one before it, as it will once those directories are made. A dangling link is followed.
// An absent component is ENOENT or ENOTDIR; any other error is thrown, and the caller fails closed.
function realTarget(input, depth = 0) {
  if (depth > MAX_LINKS) throw new Error(`too many symbolic links at ${input}`);
  const { root, parts } = splitParts(input);
  let k = parts.length;
  while (k > 0 && !lstatExists(joinRaw(root, parts.slice(0, k)))) k -= 1;
  const anchor = joinRaw(root, parts.slice(0, k));
  let real;
  try {
    real = fs.realpathSync.native(anchor);
  } catch (error) {
    if (!isAbsent(error) || !fs.lstatSync(anchor).isSymbolicLink()) throw error;
    // A dangling link: its target, then the components after it, is the path to resolve.
    const link = fs.readlinkSync(anchor);
    const next = path.isAbsolute(link) ? link : joinRaw(joinRaw(root, parts.slice(0, k - 1)), [link]);
    return realTarget(joinRaw(next, parts.slice(k)), depth + 1);
  }
  if (k < parts.length && !isDirectory(real)) throw new Error(`${input}: ${real} is not a directory`);
  let out = real;
  let dotdot = false;
  for (const part of parts.slice(k)) {
    if (part === '.') continue;
    if (part === '..') {
      dotdot = true;
      out = path.dirname(out);
    } else {
      out = path.join(out, part);
    }
  }
  return dotdot ? realTarget(out, depth + 1) : out;
}

// The identity of a real path: the key of its deepest existing prefix, and the components after it.
// An existing path has no components after it.
function locate(real) {
  const { root, parts } = splitParts(real);
  for (let k = parts.length; k >= 0; k -= 1) {
    const key = identityOf(joinRaw(root, parts.slice(0, k)));
    if (key !== null) return { key, rest: parts.slice(k) };
  }
  throw new Error(`no existing ancestor of ${real}`);
}

// The keys of every existing prefix of a real path: the path itself and each of its ancestors.
function chainKeys(real) {
  const { root, parts } = splitParts(real);
  const keys = new Set();
  for (let k = parts.length; k >= 0; k -= 1) {
    const key = identityOf(joinRaw(root, parts.slice(0, k)));
    if (key !== null) keys.add(key);
  }
  return keys;
}

// Component lists compare equal, or one starts with the other, under foldName.
function sameParts(a, b) {
  return a.length === b.length && startsWith(a, b);
}
function startsWith(a, b) {
  return a.length >= b.length && b.every((part, i) => foldName(a[i]) === foldName(part));
}

// A protected file: the target is that file (same identity), or it is the same not-yet-existing path.
function matchesFile(target, file) {
  if (file.rest.length === 0) return target.rest.length === 0 && target.key === file.key;
  return target.key === file.key && sameParts(target.rest, file.rest);
}

// A protected directory: the target is in it (it or an existing ancestor has its identity), or
// it is under the same not-yet-existing path.
function matchesDir(target, chain, dir) {
  if (dir.rest.length === 0) return chain.has(dir.key);
  return target.key === dir.key && startsWith(target.rest, dir.rest);
}

// The real path of a target with its last component left unresolved: the parent is resolved and the
// basename appended, so a symbolic link is the path itself. null when the path ends in . or .., which
// names a directory that realTarget has already resolved.
function unresolvedLeaf(abs) {
  const { root, parts } = splitParts(abs);
  const last = parts[parts.length - 1];
  if (last === undefined || last === '.' || last === '..') return null;
  return path.join(realTarget(joinRaw(root, parts.slice(0, -1))), last);
}

// What the protected directories hold. `holders` maps the identity of every real entry (lstat, so a
// hard link has its file's identity) to the directory it is in. `linkRoots` lists, for every symbolic
// link in them, the real path it points to (a dangling link included), with that directory: a target
// at or under a link root is reached through the gate directory. Only real directories are walked,
// so a link to a large tree, or a loop, costs one entry. A tree nested past MAX_DEPTH levels, or
// with more than MAX_ENTRIES entries, throws, and the caller fails closed.
function protectedContents(root) {
  const holders = new Map();
  const linkRoots = [];
  let count = 0;
  const visit = (dir, rel, depth) => {
    for (const name of fs.readdirSync(dir)) {
      if (depth + 1 > MAX_DEPTH) throw new Error(`${rel} is nested more than ${MAX_DEPTH} levels deep; remove the extra levels outside the agent`);
      count += 1;
      if (count > MAX_ENTRIES) throw new Error(`${rel} holds more than ${MAX_ENTRIES} entries; move them out of ${rel} outside the agent`);
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        linkRoots.push({ parts: partsOf(realTarget(full)), rel });
        // The link's target by identity too, so a hard link to a linked file is caught. A linked
        // directory is not walked: links nested inside a linked tree are not followed.
        const target = statOrNull(full);
        if (target !== null && !holders.has(`${target.dev}:${target.ino}`)) holders.set(`${target.dev}:${target.ino}`, rel);
        continue;
      }
      const key = `${st.dev}:${st.ino}`;
      if (!holders.has(key)) holders.set(key, rel);
      if (st.isDirectory()) visit(full, rel, depth + 1);
    }
  };
  for (const rel of PROTECTED_DIRS) {
    const dir = realTarget(under(root, rel));
    if (isDirectory(dir)) visit(dir, rel, 0);
  }
  return { holders, linkRoots };
}

// The protected name a real path spells under the root, compared folded. A gate that does not exist
// yet has no identity to compare, so its spelling is what is checked.
function protectedName(real, root) {
  const base = partsOf(root);
  const parts = partsOf(real);
  if (!startsWith(parts, base)) return null;
  const rest = parts.slice(base.length);
  for (const rel of PROTECTED_FILES) {
    if (sameParts(rest, rel.split('/'))) return rel;
  }
  for (const rel of PROTECTED_DIRS) {
    if (startsWith(rest, rel.split('/'))) return rel;
  }
  return null;
}

// CLAUDE_PROJECT_DIR, else the git top level, else the current directory, resolved like a path.
function projectRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  let dir = process.cwd();
  if (fromEnv) {
    dir = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
  } else {
    const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (!git.error && git.status === 0 && git.stdout.trim() !== '') dir = git.stdout.trim();
  }
  const root = realTarget(dir);
  if (!isDirectory(root)) throw new Error(`project root ${dir} is not a directory`);
  return root;
}

const under = (root, rel) => joinRaw(root, rel.split('/'));

// The block message for a file tool's absolute path, or null when the path may be changed. A relative
// path, or one that starts with ~, is refused: the file tools take absolute paths, and this check does
// not guess where another one would land.
function fileBlock(input) {
  if (!path.isAbsolute(input)) {
    return `DevOPs GATE BLOCK: ${input} is not an absolute path; file tools take absolute paths -- failing closed`;
  }
  const root = projectRoot();
  const real = realTarget(input);
  const target = locate(real);
  const chain = chainKeys(real);
  for (const rel of PROTECTED_FILES) {
    if (matchesFile(target, locate(realTarget(under(root, rel))))) return gateMessage(rel);
  }
  for (const rel of PROTECTED_DIRS) {
    if (matchesDir(target, chain, locate(realTarget(under(root, rel))))) return gateMessage(rel);
  }
  // A spelling of a gate that does not exist yet: it has no identity, so its folded name is compared.
  const named = protectedName(real, root);
  if (named !== null) return gateMessage(named);
  // The path with its last component left unresolved: a symbolic link that sits in a protected
  // directory is inside it, even when it points out.
  const leaf = unresolvedLeaf(input);
  if (leaf !== null) {
    const leafTarget = locate(leaf);
    const leafChain = chainKeys(leaf);
    for (const rel of PROTECTED_DIRS) {
      if (matchesDir(leafTarget, leafChain, locate(realTarget(under(root, rel))))) return gateMessage(rel);
    }
  }
  // The contents of the protected directories: an existing target with the identity of an entry in
  // them (a hard link) is blocked, and so is any target, existing or not, at or under the real path a
  // link in them points to (the link's target is reached through the gate directory).
  const { holders, linkRoots } = protectedContents(root);
  if (target.rest.length === 0) {
    const holder = holders.get(target.key);
    if (holder !== undefined) return gateMessage(holder);
  }
  const realParts = partsOf(real);
  for (const link of linkRoots) {
    if (startsWith(realParts, link.parts)) return gateMessage(link.rel);
  }
  return null;
}

function gateMessage(rel) {
  return `DevOPs GATE BLOCK: ${rel} holds DevOPs gates or approvals; change it yourself outside the agent`;
}

// Each quoted segment becomes `q`, so a quoted word is still one word and what it holds is not read
// as an operator. An unterminated quote is left as written, so what follows it is still checked.
function maskQuoted(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "'" || ch === '"') {
      const close = closingQuote(text, i);
      if (close === -1) return out + text.slice(i);
      out += 'q';
      i = close + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// The index of the quote that closes the one at `open`, or -1. Double quotes honour backslash.
function closingQuote(text, open) {
  const quote = text[open];
  for (let j = open + 1; j < text.length; j += 1) {
    if (quote === '"' && text[j] === '\\') {
      j += 1;
    } else if (text[j] === quote) {
      return j;
    }
  }
  return -1;
}

// The command with its quote and backslash characters deleted: the text the gate-path match reads.
const deleteQuotes = text => text.replace(/['"\\]/g, '');

// less writes a copy of its input with -o, -O or --log-file; it runs a command with +cmd, and reads
// key bindings from a lesskey file with -k. Those options make it a write or a program, not a read.
function lessReads(command) {
  return deleteQuotes(command).trim().split(/[\s;&|()<>`]+/).slice(1)
    .every(word => !/^\+|^--(log-file|LOG-FILE|lesskey)|^-[^-]*[oOk]/.test(word));
}

// True when the command is a plain read: a read-only first word, no chaining, no redirection other
// than 2>&1, and any pipe only into head, tail, wc, grep or sort. git add, commit and status count too.
function isPlainRead(command) {
  // Command substitution is live inside double quotes, so it is checked before quotes are masked.
  if (command.includes('$(') || command.includes('`')) return false;
  let text = maskQuoted(command).replace(/2>&1/g, ' ');
  let previous;
  do {
    previous = text;
    text = text.replace(FILTER_STAGE, '');
  } while (text !== previous);
  if (/[>|;&()`\n\r]/.test(text)) return false;
  const [first, second] = text.trim().split(/\s+/);
  if (first === 'less') return lessReads(command);
  if (READ_COMMANDS.has(first)) return true;
  return first === 'git' && GIT_PLAIN.has(second);
}

// The bare tree name (.claude, .workflow or .workflow/state) that a mover command names, or undefined.
function bareMover(command) {
  const words = deleteQuotes(command).split(/[\s;&|()<>`]+/).filter(word => word !== '');
  if (!words.some(word => MOVERS.has(word))) return undefined;
  for (const word of words) {
    const key = foldName(word.replace(/^(\.\/)+/, '').replace(/\/+$/, ''));
    const name = BARE_NAMES.find(bare => foldName(bare) === key);
    if (name !== undefined) return name;
  }
  return undefined;
}

// The block message for a Bash command, or null when the command may run. Text only: nothing on
// disk is read, so a command that changes directory and then writes a relative path is not seen.
function commandBlock(command) {
  const folded = foldName(deleteQuotes(command));
  const named = GATE_PATHS.find(gate => folded.includes(foldName(gate))) ?? bareMover(command);
  if (named === undefined || isPlainRead(command)) return null;
  return `DevOPs GATE BLOCK: this command names ${named}, which holds DevOPs gates or approvals; change it yourself outside the agent`;
}

function main(argv) {
  const fromStdin = argv[0] === '--stdin';
  const words = fromStdin ? argv.slice(1) : argv;
  // Positional: <target> [--command]. Stdin: --stdin [--command], with the target read from stdin.
  const valid = fromStdin
    ? words.length <= 1 && (words.length === 0 || words[0] === '--command')
    : words.length >= 1 && words.length <= 2 && (words.length === 1 || words[1] === '--command');
  if (!valid) {
    process.stderr.write('DevOPs GATE BLOCK: usage: protect-gates.mjs <path> | <command> --command | --stdin [--command] -- failing closed\n');
    return 2;
  }
  const isCommand = (fromStdin ? words[0] : words[1]) === '--command';
  let target;
  try {
    target = fromStdin ? fs.readFileSync(0, 'utf8') : words[0];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DevOPs GATE BLOCK: protect-gates could not read its input: ${reason} -- failing closed\n`);
    return 2;
  }
  if (target === '') return 0;
  try {
    const message = isCommand ? commandBlock(target) : fileBlock(target);
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
