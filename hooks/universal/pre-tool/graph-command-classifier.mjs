#!/usr/bin/env node
// REQ-M16: a finite literal-command classifier, never a shell interpreter.
// Bash owns messages/events. This helper only reads contained state/ref data.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(process.cwd());
const MAX_TEXT = 64 * 1024;
const statuses = new Set(['running', 'blocked', 'completed', 'failed', 'indeterminate']);
const sealed = new Set(['refs/tags/v0.2.0', 'refs/heads/phase-2-security-depth', 'refs/heads/stratum-merge']);
const within = (value) => value === root || value.startsWith(root + path.sep);
class UnsafePath extends Error {}

// No authority symlinks, special files or hard-linked files; absent ancestors
// are fine for logging, since the wrapper can create its own state directory.
function inspect(file, kind = 'file') {
  const resolved = path.resolve(file);
  if (!within(resolved)) throw new UnsafePath('path leaves project root');
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const directory = i < parts.length - 1 || kind === 'directory';
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new UnsafePath('redirected or nonregular project path');
    }
    if (!directory && stat.nlink !== 1) throw new UnsafePath('linked authority file');
    if (i === parts.length - 1) return stat;
  }
  return fs.lstatSync(root);
}

function readBounded(file, limit = MAX_TEXT) {
  const stat = inspect(file);
  if (!stat || stat.size > limit || !(stat.mode & 0o444)) throw new Error('missing, unreadable or oversized file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || opened.nlink !== 1) throw new Error('invalid opened file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

// Locate the end of a substitution without interpreting its content. Quotes
// inside $(...) belong to that nested shell, not the surrounding word.
function substitutionEnd(text, start, backtick = false) {
  let quote = null;
  let nesting = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (backtick) { if (c === '`') return i; continue; }
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '`') { i = substitutionEnd(text, i + 1, true); continue; }
    if (c === '$' && text[i + 1] === '(') { i = substitutionEnd(text, i + 2); continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (quote === '"') continue;
    if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: a backslash escapes the next character, even a quote.
      let j = i + 2;
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "'") { quote = "'"; continue; }
    if (c === '(') nesting++;
    if (c === ')' && --nesting === 0) return i;
  }
  throw new Error('unterminated command substitution');
}

function tokenize(text) {
  if (text.length > MAX_TEXT || text.includes('\0')) throw new Error('command exceeds parser bounds');
  const commands = [];
  let words = [];
  let word = null;
  let quote = null;
  const append = (value) => { word ??= { text: '', dynamic: false, substitutions: [] }; word.text += value; };
  const flush = () => { if (word) words.push(word); word = null; };
  const finish = (separator) => { flush(); if (words.length) commands.push({ words, separator }); words = []; };
  const unsupported = (c) => ![' ', '\t', '\n'].includes(c) && /[\p{White_Space}\p{Cf}]/u.test(c);
  // $'...' (ANSI-C quoting): decode only what bash decodes identically on every
  // supported version; anything else throws so decide() blocks. Decoded text is
  // literal: it never makes the word dynamic or reaches the separator branches.
  const ESCAPES = { a: 7, b: 8, e: 27, E: 27, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63 };
  const ansiC = (from) => {
    append('');
    for (let j = from; j < text.length; j++) {
      const ch = String.fromCodePoint(text.codePointAt(j));
      j += ch.length - 1;
      if (ch === "'") return j;
      if (ch !== '\\') { append(ch); continue; }
      const next = text[j + 1];
      let code;
      if (next !== undefined && Object.hasOwn(ESCAPES, next)) { code = ESCAPES[next]; j++; }
      else if (next === 'x') {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(j + 2, j + 4));
        if (!hex) throw new Error('unsupported ANSI-C escape');
        code = parseInt(hex[0], 16); j += 1 + hex[0].length;
      } else if (next !== undefined && /[0-7]/.test(next)) {
        const oct = /^[0-7]{1,3}/.exec(text.slice(j + 1, j + 4));
        code = parseInt(oct[0], 8); j += oct[0].length;
      } else throw new Error('unsupported ANSI-C escape');
      if (code === 0 || code >= 0x80) throw new Error('unsupported ANSI-C byte value');
      append(String.fromCharCode(code));
    }
    throw new Error('unterminated ANSI-C quote');
  };
  for (let i = 0; i < text.length; i++) {
    const c = String.fromCodePoint(text.codePointAt(i));
    i += c.length - 1;
    if (quote === "'") { if (c === "'") quote = null; else append(c); continue; }
    if (!quote && unsupported(c)) throw new Error('unsupported whitespace or format character');
    if (c === '\\') {
      if (i + 1 === text.length) throw new Error('unfinished escape');
      const next = String.fromCodePoint(text.codePointAt(++i));
      i += next.length - 1;
      if (!quote && unsupported(next)) throw new Error('unsupported whitespace or format character');
      if (next === '\n') continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) append('\\');
      append(next);
      continue;
    }
    if (c === '$' && text[i + 1] === '(' || c === '`') {
      const start = i + (c === '`' ? 1 : 2);
      const end = substitutionEnd(text, start, c === '`');
      append(''); word.dynamic = true; word.substitutions.push(text.slice(start, end));
      i = end;
      continue;
    }
    if (!quote && c === '$' && text[i + 1] === "'") { i = ansiC(i + 2); continue; }
    if (!quote && c === '$' && text[i + 1] === '"') throw new Error('unsupported locale translation quoting');
    if (c === '"') { append(''); quote = quote === '"' ? null : '"'; continue; }
    if (quote === '"') { append(c); if (c === '$') word.dynamic = true; continue; }
    if (c === "'") { append(''); quote = "'"; continue; }
    if (c === '#' && !word) {
      while (i + 1 < text.length && text[i + 1] !== '\n') {
        const next = String.fromCodePoint(text.codePointAt(i + 1));
        if (unsupported(next)) throw new Error('unsupported whitespace or format character');
        i += next.length;
      }
      continue;
    }
    if (';\n|&'.includes(c)) {
      let separator = c;
      if ((c === '|' || c === '&') && text[i + 1] === c) separator += text[++i];
      finish(separator);
      continue;
    }
    if (c === ' ' || c === '\t') { flush(); continue; }
    if (c === '<' || c === '>') throw new Error('unsupported unquoted shell redirection');
    if ('(){}'.includes(c)) throw new Error('unsupported shell grouping or expansion');
    append(c);
    if (c === '$' || c === '*' || c === '?' || c === '[' || c === '~') word.dynamic = true;
  }
  if (quote) throw new Error('unterminated quote');
  finish('');
  if (commands.length > 256 || commands.reduce((sum, item) => sum + item.words.length, 0) > 4096) {
    throw new Error('command exceeds parser bounds');
  }
  return commands;
}

// Program position is ONE computed thing: executable() strips every literal
// prefix and launcher and leaves the program word. Names are matched on the
// lowercased basename (APFS is case-insensitive, so VERCEL runs vercel), and a
// prefix word that is itself expanded is never treated as a prefix. Understood
// prefixes: NAME=value assignments, shell reserved words that introduce a command
// (!, {, do, then, else, elif, if, while, until), the wrappers env, command,
// builtin, npx, nohup, exec, nice, timeout, stdbuf and setsid, and the launchers
// caffeinate, time, xcrun, arch, script, unbuffer, chrt, ionice, taskset, strace
// and ltrace. A launcher option that is not in its table throws, so decide()
// blocks (fail closed). sudo, doas, xargs, su, find -exec and the shells are
// followed by wrapsConsequential, which re-enters this resolver on their rest.
const RESERVED = new Set(['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until']);
const NICE_OPTION = /^(-n.+|-[0-9]+|--adjustment=.+)$/;
const TIMEOUT_FLAGS = new Set(['--foreground', '--preserve-status', '-v', '--verbose']);
const STDBUF_SHORT = /^-[ioe]$/;
const STDBUF_LONG = /^-[ioe].+$|^--(input|output|error)=.+$/;
const SETSID_FLAGS = new Set(['-c', '--ctty', '-f', '--fork', '-w', '--wait']);
const lowerBase = (word) => path.basename(word.text).toLowerCase();
// Option tables: flags take no operand, valued letters take the rest of the word
// or the next word, long maps a name to whether it takes an operand.
const LAUNCHERS = {
  caffeinate: { flags: 'dimsu', valued: 'tw' },
  time: { flags: 'alph', valued: 'o' },
  unbuffer: { flags: '', valued: '' },
  chrt: { flags: '', valued: '', operands: 1 },
  ionice: { flags: '', valued: '' },
  taskset: { flags: '', valued: '', operands: 1 },
  strace: { flags: '', valued: '' },
  ltrace: { flags: '', valued: '' },
  xcrun: { flags: 'rvnk', valued: '', long: { sdk: true, toolchain: true, run: false, verbose: false, 'no-cache': false, 'kill-cache': false } },
};
const XCRUN_INFORMATIONAL = /^(-f|-h|-l|--find|--help|--version|--log|--show-.+)$/;
const ARCH_NAMES = new Set(['-arm64', '-arm64e', '-x86_64', '-x86_64h', '-i386', '-32', '-64']);

// Walks short options letter by letter and long options by table. Unknown input
// sets unknown; a replace-string letter (xargs -I/-J/-i) sets replace.
function walkOptions(args, spec) {
  const seen = new Set();
  let at = 0;
  while (args[at]) {
    const arg = args[at].text;
    if (arg === '--') { at++; break; }
    if (arg.length < 2 || arg[0] !== '-') break;
    at++;
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0];
      const takes = spec.long?.[name];
      if (takes === undefined) return { at, seen, unknown: true };
      seen.add(name);
      if (takes && !arg.includes('=')) {
        if (!args[at]) return { at, seen, unknown: true };
        at++;
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (spec.replace?.includes(letter)) return { at, seen, unknown: true, replace: true };
      seen.add(letter);
      if (spec.valued.includes(letter)) {
        if (j === arg.length - 1) {
          if (!args[at]) return { at, seen, unknown: true };
          at++;
        }
        break; // Remaining characters, if any, are this option's value.
      }
      if (!spec.flags.includes(letter)) return { at, seen, unknown: true };
    }
  }
  return { at, seen, unknown: false };
}

// npm global options before the verb: flags take no operand, valued ones take the
// next word. An option in neither table makes the verb unsure.
const NPM_VALUED = new Set(['--prefix', '--workspace', '-w', '--loglevel', '--registry', '--userconfig', '--globalconfig', '--cache', '--tag', '--otp', '--scope', '--package', '-p', '--call', '-c', '--script-shell', '--node-options', '--access']);
const NPM_FLAGS = new Set(['-s', '--silent', '--verbose', '-d', '--dd', '--ddd', '-g', '--global', '-D', '--save-dev', '-S', '--save', '--no-save', '-ws', '--workspaces', '--include-workspace-root', '--no-workspaces', '-y', '--yes', '--no', '-f', '--force', '--dry-run', '--json', '-q', '--quiet', '--offline', '--prefer-offline', '--prefer-online', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', '--foreground-scripts', '--no-color', '--color', '--no-progress', '--progress', '--if-present', '-h', '--help', '-v', '--version', '-l', '--long', '-a', '--all']);
// Locates npm's verb after its global options: { at } is the verb word's index,
// { unsure: true } means an unknown option hides it, { at: -1 } that there is none.
function npmVerb(words, index) {
  for (let i = index + 1; words[i]; i++) {
    const text = words[i].text;
    if (!text.startsWith('-')) return { at: i, dynamic: words[i].dynamic };
    if (text === '--') return { at: -1 };
    const name = text.split('=')[0];
    if (NPM_VALUED.has(name) && !text.includes('=')) i++;
    else if (!NPM_FLAGS.has(name) && !text.includes('=') && !NPM_VALUED.has(name)) return { at: -1, unsure: true };
  }
  return { at: -1 };
}

function executable(words) {
  let index = 0;
  let gitContextOverride = false;
  const calls = []; // npm exec --call strings: shell text the caller must classify
  const assignment = () => {
    const value = words[index]?.text;
    if (!value || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return false;
    if (/^GIT_[A-Za-z0-9_]*=/.test(value)) gitContextOverride = true;
    index++;
    return true;
  };
  const operand = (what) => {
    if (!words[index]) throw new Error(`missing ${what} operand`);
    index++;
  };
  const launcher = (name) => {
    const spec = LAUNCHERS[name];
    index++;
    const walked = walkOptions(words.slice(index), spec);
    if (walked.unknown) throw new Error(`unsupported ${name} prefix option`);
    index += walked.at;
    for (let k = 0; k < (spec.operands ?? 0); k++) operand(`${name} argument`);
  };
  // Strips one prefix; returns false when the word at index is the program.
  const strip = () => {
    if (!words[index]) return false;
    if (assignment()) return true;
    const text = words[index].text;
    if (RESERVED.has(text)) { index++; return true; }
    // An expanded word is never a literal prefix name ($(echo "sudo ")env).
    if (words[index].dynamic) return false;
    const name = lowerBase(words[index]);
    if (LAUNCHERS[name] && name !== 'xcrun') { launcher(name); return true; }
    if (name === 'xcrun') {
      // xcrun --find/--show-sdk-path and friends only print; the rest runs a tool.
      for (let k = index + 1; words[k]?.text.startsWith('-'); k++) {
        if (XCRUN_INFORMATIONAL.test(words[k].text)) return false;
        if (['--sdk', '--toolchain'].includes(words[k].text)) k++;
      }
      launcher('xcrun');
      return true;
    }
    if (name === 'arch') {
      index++;
      for (;;) {
        const arg = words[index]?.text;
        if (arg === '--') { index++; break; }
        if (ARCH_NAMES.has(arg) || arg === '-c') index++;
        else if (arg === '-d' || arg === '-e') { index++; operand('arch option'); }
        else if (arg?.startsWith('-')) throw new Error('unsupported arch prefix option');
        else break;
      }
      return true;
    }
    if (name === 'script') {
      // BSD script: [-adkpqr] [-F pipe] [-t time] file command ...; without a
      // command it starts a shell that reads stdin, which cannot be classified.
      index++;
      const walked = walkOptions(words.slice(index), { flags: 'adkpqr', valued: 'Ft' });
      if (walked.unknown) throw new Error('unsupported script prefix option');
      index += walked.at;
      operand('script file');
      if (!words[index]) throw new Error('script without a command reads a shell from stdin');
      return true;
    }
    if (name === 'builtin') {
      index++;
      if (words[index]?.text.startsWith('-')) throw new Error('unsupported builtin prefix option');
      return true;
    }
    if (name === 'env') {
      index++;
      while (words[index]) {
        const arg = words[index].text;
        if (assignment()) continue;
        if (['-i', '--ignore-environment'].includes(arg)) index++;
        else if (arg === '-u' || arg === '--unset') {
          index++;
          operand('env option');
        }
        else if (arg.startsWith('--unset=')) index++;
        else if (arg === '--') {
          index++;
          while (assignment()) { /* env still accepts NAME=value after --. */ }
          break;
        }
        else if (arg.startsWith('-')) throw new Error('unsupported env prefix option');
        else break;
      }
      return true;
    }
    if (name === 'command') {
      index++;
      if (words[index]?.text === '--') index++;
      else if (words[index]?.text.startsWith('-')) throw new Error('unsupported command prefix option');
      return true;
    }
    if (name === 'npm') {
      // npm exec|x runs a package binary (or, with --call, a shell string): treat it
      // like npx. A hidden verb that could be exec fails closed.
      const verb = npmVerb(words, index);
      if (verb.unsure && words.slice(index + 1).some((word) => ['exec', 'x'].includes(word.text.toLowerCase()))) throw new Error('unsupported npm option before exec');
      if (verb.at < 0 || verb.dynamic || !['exec', 'x'].includes(words[verb.at].text.toLowerCase())) return false;
      index = verb.at + 1;
      for (;;) {
        const word = words[index];
        if (!word) break;
        const text = word.text;
        if (text === '--') { index++; break; }
        if (['--yes', '-y', '--no', '--workspaces', '-ws', '--include-workspace-root', '--no-workspaces'].includes(text)) index++;
        else if (['--package', '-p', '--workspace', '-w'].includes(text)) { index++; operand('npm exec option'); }
        else if (/^--(package|workspace)=/.test(text)) index++;
        else if (text === '--call' || text === '-c') {
          index++;
          if (!words[index] || words[index].dynamic) throw new Error('npm exec call string cannot be classified');
          calls.push(words[index++]);
        } else if (text.startsWith('--call=') || /^-c./.test(text)) {
          if (word.dynamic) throw new Error('npm exec call string cannot be classified');
          calls.push({ ...word, text: text.replace(/^--call=|^-c/, '') });
          index++;
        } else if (text.startsWith('-')) throw new Error('unsupported npm exec option');
        else break;
      }
      return true;
    }
    if (name === 'npx') {
      index++;
      while (['--yes', '-y', '--no-install', '--'].includes(words[index]?.text)) index++;
      if (words[index]?.text.startsWith('-')) throw new Error('unsupported npx prefix option');
      return true;
    }
    if (name === 'nohup' || name === 'exec') {
      index++;
      if (words[index]?.text.startsWith('-')) throw new Error(`unsupported ${name} prefix option`);
      return true;
    }
    if (name === 'nice') {
      index++;
      while (words[index]?.text.startsWith('-')) {
        const arg = words[index++].text;
        if (arg === '-n' || arg === '--adjustment') operand('nice option');
        else if (arg === '--') break;
        else if (!NICE_OPTION.test(arg)) throw new Error('unsupported nice prefix option');
      }
      return true;
    }
    if (name === 'timeout') {
      index++;
      while (words[index]?.text.startsWith('-')) {
        const arg = words[index++].text;
        if (arg === '-k' || arg === '-s' || arg === '--kill-after' || arg === '--signal') operand('timeout option');
        else if (arg === '--') break;
        else if (TIMEOUT_FLAGS.has(arg) || /^(-k.+|-s.+|--kill-after=.+|--signal=.+)$/.test(arg)) continue;
        else throw new Error('unsupported timeout prefix option');
      }
      operand('timeout duration');
      return true;
    }
    if (name === 'stdbuf') {
      index++;
      while (words[index]?.text.startsWith('-')) {
        const arg = words[index++].text;
        if (STDBUF_SHORT.test(arg)) operand('stdbuf option');
        else if (arg === '--') break;
        else if (!STDBUF_LONG.test(arg)) throw new Error('unsupported stdbuf prefix option');
      }
      return true;
    }
    if (name === 'setsid') {
      index++;
      while (words[index]?.text.startsWith('-')) {
        const arg = words[index++].text;
        if (arg === '--') break;
        if (!SETSID_FLAGS.has(arg)) throw new Error('unsupported setsid prefix option');
      }
      return true;
    }
    return false;
  };
  while (strip()) { /* Prefixes may nest in any order; assignment values stay inert. */ }
  return { words: words.slice(index), gitContextOverride, calls };
}

function resolveDirectory(base, token) {
  if (!base || !token || token.dynamic) return null;
  const candidate = path.resolve(base, token.text);
  if (!within(candidate)) return null;
  try {
    // Reject redirects instead of resolving a symlink to inspect another tree.
    if (!inspect(candidate, 'directory')) return null;
    const physical = fs.realpathSync(candidate);
    return within(physical) ? physical : null;
  } catch { return null; }
}

// A git alias can be defined for one command through -c, --config-env or the
// GIT_CONFIG_* environment and then names any verb, so sealed mode refuses it.
const aliasKey = (text) => /^alias\./i.test(text);
function gitCommand(words, base) {
  let context = base;
  let uncertain = false;
  let alias = false;
  let index = 1;
  while (words[index]?.text.startsWith('-')) {
    const arg = words[index++].text;
    if (arg === '-C') context = resolveDirectory(context, words[index++]);
    else if (arg === '-c' || arg === '--config-env') {
      uncertain = true;
      const value = words[index++];
      if (!value || value.dynamic || aliasKey(value.text)) alias = true;
    } else if (/^-c./.test(arg) || arg.startsWith('--config-env=')) {
      uncertain = true;
      if (words[index - 1].dynamic || aliasKey(arg.replace(/^-c|^--config-env=/, ''))) alias = true;
    } else if (arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      uncertain = true; index++;
    } else if (['--no-pager', '--paginate', '-p', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(arg)) {
      // These options neither choose refs nor redirect metadata.
    } else uncertain = true;
  }
  return { verb: words[index]?.text, args: words.slice(index + 1), context: uncertain ? null : context, uncertain, alias };
}

function exactSealed(raw, namespace) {
  // A spelling that normalises onto a sealed ref (refs/tags//v0.2.0,
  // ./refs/tags/v0.2.0, a trailing slash) is treated as that ref: real git
  // refuses most of them, so this is fail-closed by normalisation.
  // Compared lowercased: APFS resolves a loose ref case-insensitively, so
  // `git tag -d V0.2.0` deletes refs/tags/v0.2.0 there (harmless fail-closed elsewhere).
  const ref = path.posix.normalize(raw).replace(/\/+$/, '').toLowerCase();
  // tag/branch operands are names *within* that command's namespace, even
  // when their literal spelling happens to begin with "refs/".
  if (namespace) return sealed.has(`refs/${namespace}/${ref}`) ? `refs/${namespace}/${ref}` : null;
  if (ref.startsWith('refs/')) return sealed.has(ref) ? ref : null;
  for (const prefix of ['refs/tags/', 'refs/heads/']) {
    if (sealed.has(prefix + ref)) return prefix + ref;
  }
  return null;
}

function pushArguments(args) {
  const refs = [];
  let remoteSeen = false;
  let bulk = false;
  let uncertain = false;
  let forced = false;
  let mirror = false;
  let prune = false;
  let deleting = false;
  let literalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]; const value = token.text;
    if (!literalOnly && value === '--') { literalOnly = true; continue; }
    if (!literalOnly && value.startsWith('-')) {
      if (['--tags', '--follow-tags', '--all'].includes(value)) bulk = true;
      else if (value === '--mirror') { bulk = true; mirror = true; }
      else if (['--force', '--force-with-lease', '--force-if-includes'].includes(value)) forced = true;
      else if (value === '--delete') deleting = true;
      else if (value === '--prune') prune = true;
      else if (/^-[qvfnud]+$/.test(value)) { forced ||= value.includes('f'); deleting ||= value.includes('d'); }
      else if (['--repo', '--receive-pack', '--exec', '--push-option', '-o'].includes(value)) {
        if (value === '--repo') remoteSeen = true;
        if (!args[++i]) uncertain = true;
      } else if (value.startsWith('--repo=')) remoteSeen = true;
      else if (/^--(?:force-with-lease|force-if-includes|signed|recurse-submodules|receive-pack|exec|push-option)=/.test(value)) {
        // An option's value is never a refspec or a command for our lookup.
        if (value.startsWith('--force-')) forced = true;
      } else if (!['--force', '-f', '--delete', '-d', '--force-with-lease', '--force-if-includes', '--dry-run', '-n', '--quiet', '-q', '--verbose', '-v', '--porcelain', '--atomic', '--no-verify', '--set-upstream', '-u', '--prune', '--progress', '--no-follow-tags'].includes(value)) uncertain = true;
      continue;
    }
    if (!remoteSeen) { remoteSeen = true; continue; }
    if (value === 'tag') {
      const name = args[++i];
      if (!name) uncertain = true;
      else refs.push({ ...name, text: 'refs/tags/' + name.text });
    } else refs.push(token);
  }
  return { refs, bulk, uncertain, destructiveBulk: mirror || prune || bulk && (forced || deleting) || deleting && !refs.length };
}

// Lookup admits only ordinary in-project repositories. Git files/common-dir,
// alternate object stores, reftables and config includes get no branch exception.
// Ref/object trees are bounded and nonredirected before any Git process starts.
function containedGitDirectory(context) {
  if (!context) return null;
  let worktree = context;
  while (within(worktree)) {
    const dotgit = path.join(worktree, '.git');
    let found;
    try { found = fs.lstatSync(dotgit); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    if (found) {
      try {
        if (!inspect(dotgit, 'directory') || inspect(path.join(dotgit, 'commondir'))) return null;
        for (const config of ['config', 'config.worktree']) {
          const file = path.join(dotgit, config);
          if (inspect(file)) {
            const text = readBounded(file);
            if (/\[\s*include/i.test(text) || /^\s*(worktree|refstorage|alternaterefscommand)\s*=/im.test(text)) return null;
          }
        }
        for (const name of ['HEAD', 'packed-refs', 'shallow']) {
          const file = path.join(dotgit, name);
          if (inspect(file)) {
            const text = readBounded(file, name === 'packed-refs' ? 8 * 1024 * 1024 : MAX_TEXT).trim();
            if (name === 'HEAD' && text.startsWith('ref:') && (!/^ref: refs\/[A-Za-z0-9_./-]+$/.test(text) || text.includes('..'))) return null;
          }
        }
        if (inspect(path.join(dotgit, 'reftable'))) return null;
        let count = 0;
        const walk = (directory, depth = 0) => {
          if (depth > 16) throw new Error('metadata tree exceeds depth bound');
          if (!inspect(directory, 'directory')) return;
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (++count > 20000) throw new Error('metadata tree exceeds bounds');
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file, depth + 1);
            else {
              inspect(file);
              if (file.startsWith(path.join(dotgit, 'refs') + path.sep)) {
                const ref = readBounded(file).trim();
                if (ref.startsWith('ref:') && !/^ref: refs\/[A-Za-z0-9_./-]+$/.test(ref)) throw new Error('unsupported symbolic ref');
                if (ref.includes('..')) throw new Error('unsafe ref metadata');
              }
            }
          }
        };
        walk(path.join(dotgit, 'refs'));
        walk(path.join(dotgit, 'objects'));
        for (const name of ['alternates', 'http-alternates']) {
          if (inspect(path.join(dotgit, 'objects/info', name))) return null;
        }
        return { gitDir: dotgit, worktree };
      } catch { return null; }
    }
    if (worktree === root) break;
    worktree = path.dirname(worktree);
  }
  return null;
}

function branchOnly(name, context) {
  if (name === 'HEAD' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(name) || name.includes('..') || name.endsWith('.lock')) return false;
  const repository = containedGitDirectory(context);
  if (!repository) return false;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV'].includes(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  const exists = (ref) => {
    const result = spawnSync('git', ['--git-dir=' + repository.gitDir, '--work-tree=' + repository.worktree, 'show-ref', '--verify', '--quiet', '--', ref], {
      cwd: context, env, encoding: 'utf8', timeout: 2000, maxBuffer: MAX_TEXT,
    });
    return result.error || result.signal || ![0, 1].includes(result.status) ? null : result.status === 0;
  };
  return exists('refs/heads/' + name) === true && exists('refs/tags/' + name) === false;
}

// Consume only known mutation-option arities; values such as messages and
// signing identities are never targets. Unknown options withhold a verdict
// about the target instead of guessing how many arguments they consume.
function mutationArguments(verb, args) {
  const definitions = {
    tag: { short: 'asfdlvi', valued: 'mFu', flags: ['annotate', 'sign', 'force', 'delete', 'list', 'verify', 'ignore-case', 'create-reflog', 'no-sign'], values: ['message', 'file', 'local-user', 'format', 'sort', 'contains', 'no-contains', 'points-at', 'cleanup'] },
    branch: { short: 'dDfqlrav', valued: '', flags: ['delete', 'force', 'quiet', 'list', 'remotes', 'all', 'verbose', 'show-current'], values: ['format', 'sort', 'contains', 'no-contains', 'points-at'] },
    'update-ref': { short: 'dz', valued: 'm', flags: ['no-deref', 'create-reflog', 'stdin', 'batch-updates'], values: [] },
    'symbolic-ref': { short: 'dq', valued: 'm', flags: ['delete', 'quiet', 'short', 'no-recurse'], values: [] },
    reset: { short: 'q', valued: '', flags: ['hard', 'soft', 'mixed', 'merge', 'keep', 'quiet', 'no-refresh', 'refresh'], values: [] },
    'filter-branch': { short: 'f', valued: '', flags: ['force', 'prune-empty'], values: ['setup', 'subdirectory-filter', 'env-filter', 'tree-filter', 'index-filter', 'parent-filter', 'msg-filter', 'commit-filter', 'tag-name-filter', 'original', 'state-branch'] },
    // --refs introduces target refs, so its following words remain operands.
    'filter-repo': { short: '', valued: '', flags: ['force', 'partial', 'refs'], values: [] },
  };
  const definition = definitions[verb];
  if (!definition) return { flags: new Set(), operands: [], uncertain: false };
  const flags = new Set();
  const operands = [];
  let uncertain = false;
  let literalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]; const value = token.text;
    if (!literalOnly && value === '--') { literalOnly = true; continue; }
    if (literalOnly || !value.startsWith('-')) { operands.push(token); continue; }
    if (value.startsWith('--')) {
      const [name] = value.slice(2).split('=');
      if (definition.values.includes(name)) {
        if (!value.includes('=') && !args[++i]) uncertain = true;
      } else if (!value.includes('=') && definition.flags.includes(name)) flags.add(name);
      else uncertain = true;
      continue;
    }
    for (let j = 1; j < value.length; j++) {
      const flag = value[j];
      if (definition.valued.includes(flag)) {
        if (j === value.length - 1 && !args[++i]) uncertain = true;
        break; // Remaining characters, if any, are this option's value.
      }
      if (definition.short.includes(flag)) flags.add(flag);
      else uncertain = true;
    }
  }
  return { flags, operands, uncertain };
}

// A fetch/pull refspec writes its destination ref; a sealed, wildcard or
// expanded destination, --refmap and --prune-tags cannot be excluded.
function fetchFacts(verb, args, facts) {
  let remote = false;
  for (const token of args) {
    const value = token.text;
    if (verb === 'fetch' && (/^-[A-Za-z]*P/.test(value) || /^--(prune-tags|refmap)(=|$)/.test(value))) { facts.ambiguous = true; continue; }
    if (value.startsWith('-')) continue;
    if (!remote) { remote = true; continue; }
    if (token.dynamic) { facts.ambiguous = true; continue; }
    const spec = value.replace(/^\+/, '');
    const colon = spec.indexOf(':');
    const destination = colon < 0 ? '' : spec.slice(colon + 1);
    if (!destination) continue;
    facts.sealedRef ||= exactSealed(destination);
    if (destination.includes('*')) facts.ambiguous = true;
  }
  return facts;
}

// checkout -B, switch -C/--force-create and worktree add -B reset a branch.
function forceCreateFacts(verb, args, facts) {
  const letter = verb === 'switch' ? 'C' : 'B';
  for (let i = 0; i < args.length; i++) {
    const value = args[i].text;
    if (value === '--') break;
    let name;
    let matched = false;
    if (verb === 'switch' && value === '--force-create') { matched = true; name = args[i + 1]; }
    else if (verb === 'switch' && value.startsWith('--force-create=')) { matched = true; name = { ...args[i], text: value.slice(15) }; }
    else if (!value.startsWith('--') && value.startsWith('-') && value.indexOf(letter, 1) > 0) {
      matched = true;
      const attached = value.slice(value.indexOf(letter, 1) + 1);
      name = attached ? { ...args[i], text: attached } : args[i + 1];
    }
    if (!matched) continue;
    if (!name || name.dynamic) facts.ambiguous = true;
    else facts.sealedRef ||= exactSealed(name.text, 'heads');
  }
  return facts;
}

function gitFacts(command) {
  const { verb, args, context, uncertain } = command;
  const values = args.map((arg) => arg.text);
  const facts = { consequential: false, deploy: false, sealedRef: null, ambiguous: false };
  if (verb === 'push') {
    facts.consequential = true;
    const push = pushArguments(args);
    facts.deploy = uncertain || push.uncertain || push.bulk || !push.refs.length;
    for (const token of push.refs) {
      const ref = token.text.replace(/^\+/, '');
      const colon = ref.indexOf(':');
      const target = colon < 0 ? ref : ref.slice(colon + 1);
      facts.sealedRef ||= exactSealed(target);
      if (token.dynamic || !target || /[<>]/.test(ref)) { facts.deploy = true; facts.ambiguous = true; continue; }
      if (target.startsWith('refs/heads/')) continue;
      // A colon destination is inferred remotely from its source; a local
      // branch of that name cannot establish the remote destination namespace.
      if (colon >= 0 || target.startsWith('refs/') || !branchOnly(target, context)) facts.deploy = true;
    }
    // Ordinary --tags/--follow-tags/--all retain the old sealed-hook allow;
    // implicit bulk destinations are not enumerated. Forced/mirror/prune
    // ambiguity is refused. All bulk modes still need a deploy marker.
    if (push.destructiveBulk || push.uncertain) facts.ambiguous = true;
    return facts;
  }
  if (verb === 'config' && values.some(aliasKey)) facts.ambiguous = true;
  if (verb === 'fetch' || verb === 'pull') return fetchFacts(verb, args, facts);
  if (verb === 'checkout' || verb === 'switch' || verb === 'worktree' && values[0] === 'add') return forceCreateFacts(verb, args, facts);
  if (verb === 'replace') {
    for (const token of args) {
      facts.sealedRef ||= exactSealed(token.text);
      if (token.dynamic) facts.ambiguous = true;
    }
    return facts;
  }
  if (verb === 'symbolic-ref') {
    const symbolic = mutationArguments(verb, args);
    const writes = symbolic.uncertain || symbolic.flags.has('d') || symbolic.flags.has('delete') || symbolic.operands.length >= 2;
    facts.consequential = writes;
    if (symbolic.uncertain) facts.ambiguous = true;
    else if (writes && symbolic.operands[0]) {
      facts.sealedRef ||= exactSealed(symbolic.operands[0].text);
      if (symbolic.operands[0].dynamic) facts.ambiguous = true;
    }
    return facts;
  }
  const parsed = mutationArguments(verb, args);
  const deleting = ['d', 'D', 'delete'].some((flag) => parsed.flags.has(flag));
  const forced = ['f', 'force'].some((flag) => parsed.flags.has(flag));
  const destructiveTag = verb === 'tag' && (deleting || forced || parsed.uncertain);
  const destructiveBranch = verb === 'branch' && (deleting || forced || parsed.uncertain);
  const destructive = destructiveTag || destructiveBranch || verb === 'update-ref' || (verb === 'reset' && values.includes('--hard')) || ['filter-branch', 'filter-repo'].includes(verb);
  facts.consequential = ['commit', 'tag'].includes(verb) || destructive;
  if (!destructive) return facts;
  if (parsed.uncertain) { facts.ambiguous = true; return facts; }
  let operands = parsed.operands;
  if (verb === 'update-ref') operands = operands.slice(0, 1);
  // tag -f NAME COMMIT and branch -f NAME START mutate NAME only; deletes
  // can take multiple names. Reset/filter refusals preserve the old safety rule.
  if ((destructiveTag || destructiveBranch) && !deleting) operands = operands.slice(0, 1);
  for (const token of operands) {
    facts.sealedRef ||= exactSealed(token.text, destructiveTag ? 'tags' : destructiveBranch ? 'heads' : undefined);
    if (token.dynamic) facts.ambiguous = true;
  }
  if (verb === 'update-ref' && values.includes('--stdin')) facts.ambiguous = true;
  return facts;
}

// Facts for one command whose program word is recognised; null otherwise.
function programFacts(words, context, mode) {
  // npx/npm exec accept name@version (vercel@latest): the program is the bare name.
  const name = words[0] ? lowerBase(words[0]).replace(/@[^@/]*$/, '') : undefined;
  const facts = { consequential: false, deploy: false, sealedRef: null, ambiguous: false };
  if (name === 'git') {
    const command = gitCommand(words, context);
    // Sealed classification uses destinations, never local-ref lookup.
    if (mode === 'sealed') command.context = null;
    const gitResult = gitFacts(command);
    // A per-command alias (-c alias.*, --config-env) can name any verb, in either
    // mode (an alias runs a push or a `!shell` command); filter-branch/filter-repo
    // rewrite every ref.
    if (command.alias) gitResult.wrapper = true;
    if (mode === 'sealed' && ['filter-branch', 'filter-repo'].includes(command.verb)) gitResult.ambiguous = true;
    return gitResult;
  }
  if (['vercel', 'wrangler'].includes(name)) {
    facts.consequential = true;
    facts.deploy ||= words.some((word) => word.text === 'deploy') || name === 'vercel' && words.some((word) => ['--prod', '--production'].includes(word.text));
  } else if (name === 'npm') {
    const verb = npmVerb(words, 0);
    // A hidden or expanded verb may be publish.
    if (verb.at >= 0 && !verb.dynamic ? words[verb.at].text === 'publish' : verb.unsure && words.some((word) => word.text === 'publish') || verb.dynamic) { facts.consequential = true; facts.deploy = true; }
  } else if (name === 'supabase' && words[1]?.text === 'db' && words[2]?.text === 'push') {
    facts.consequential = true; facts.deploy = true;
  } else if (name === 'gh') {
    if (words[1]?.text === 'pr' && words[2]?.text === 'merge') facts.consequential = true;
    if (words[1]?.text === 'release' && !['list', 'view', 'download', '--help', '-h'].includes(words[2]?.text)) { facts.consequential = true; facts.deploy = true; }
  } else if (name !== 'supabase') return null;
  return facts;
}

// Fail-closed rules for a command whose program word is not one of the tables
// above (sudo, doas, xargs, find -exec, shells, eval, source, interpreters, ...).
// Applied in deploy and sealed modes, which run on every Bash call, so the
// rules are scoped to program position, launcher chains and shells reading
// stdin; dynamic arguments after an ordinary program (curl -s $URL) stay allowed.
//  - Program words match on the lowercased basename; launchers are followed, and
//    a dynamic, unresolvable or unknown-option program word blocks.
//  - sudo, doas, xargs, chroot and find -exec re-enter the same resolver on the
//    words they hand on; an empty remainder means the program arrives on stdin
//    (xargs env) and blocks; a bare xargs (it runs echo) is allowed.
//  - echo, printf, :, true and test, and text filters (cat, grep, ...), only
//    print or filter their words: they end the scan, so harmless text is allowed.
//  - Shells, source and . block when they read stdin, a normalised /dev/ or
//    /proc/ path or an expanded operand; a literal script file is a scope limit.
//  - xargs and shell combined short options are parsed letter by letter; an
//    unknown letter blocks.
//  - Sealed mode also refuses any program but a reader with an operand under a .git
//    segment (gitWrite), tracks cd into .git (cwdWrites), and refuses find/xargs writers.
//  - A git alias for one command and npm exec|x (launcher; --call strings classified)
//    are handled in both modes.
//  - Inline interpreter code that names both a guarded program and a guarded
//    verb or ref is blocked; payloads built by concatenation or encoding are a
//    scope limit.
const WRAPPERS = new Set(['sudo', 'doas', 'xargs', 'su', 'watch', 'parallel', 'chroot', 'runuser']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'mksh']);
// Text filters that merely name a shell as data (ls | grep sh).
const FILTERS = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'sed', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'less', 'more', 'jq', 'which', 'type', 'whereis', 'ls', 'file', 'diff', 'cmp']);
// Heads whose words are only printed or tested, never run.
const INERT = new Set(['echo', 'printf', ':', 'true', 'test']);
const normalPath = (text) => path.posix.normalize(text.replace(/^\/\/+/, '/'));
// Any normalised path under /dev/ or /proc/ is a pseudo-file (stdin by another name).
const pseudoFile = (text) => {
  const normal = normalPath(text);
  return /^\/(dev|proc)\//.test(normal) || /^(\.\.\/)+(dev|proc)\//.test(normal);
};
const SUDO_OPTIONS = {
  flags: 'AbBEHKklnPSsvViue', valued: 'ugphCDRTrtU',
  long: { user: true, group: true, host: true, prompt: true, chdir: true, 'close-from': true, role: true, type: true, 'other-user': true, 'command-timeout': true, 'login-class': true, shell: false, login: false, 'preserve-env': false, 'non-interactive': false, 'set-home': false, background: false, stdin: false, askpass: false, 'reset-timestamp': false, 'remove-timestamp': false, list: false, validate: false, edit: false, 'preserve-groups': false, 'stop-processing-args': false },
};
const XARGS_OPTIONS = {
  flags: '0rtpxo', valued: 'nLPsEdaRSl', replace: 'IJi',
  long: { null: false, verbose: false, 'no-run-if-empty': false, interactive: false, 'open-tty': false, exit: false, 'show-limits': false, 'max-args': true, 'max-procs': true, 'max-lines': true, 'max-chars': true, delimiter: true, 'arg-file': true, eof: true, 'process-slot-var': true },
};
const SHELL_OPERAND = /^--(rcfile|init-file)$/;
const WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'truncate', 'dd', 'install', 'ln', 'touch', 'unlink', 'shred', 'mkdir', 'rsync', 'ditto']);
// Programs that only read their operands. Any other program with an operand under
// a .git segment is refused in sealed mode (the writers cannot be enumerated:
// tar -cf, curl -o, sqlite3 .output and rsync all overwrite packed-refs).
const READERS = new Set([...FILTERS, 'stat', 'du', 'readlink', 'realpath', 'basename', 'dirname', 'od', 'xxd', 'hexdump', 'strings', 'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum', 'cksum', 'tree', 'bat', 'nl', 'rev', 'tac', 'comm', 'paste', 'fold', 'column', 'pwd', '[', '[[']);
// Programs whose own words are followed into what they run; they are judged there.
const FOLLOWED = new Set(['sudo', 'doas', 'xargs', 'chroot', 'find', 'eval', 'source', '.', 'fish', 'watch', 'su', 'runuser', ...SHELLS]);
// Does a reader or writer word name a path through a .git segment, however spelled
// (case-insensitive on APFS, $PWD/.git/x, -o.git/x, of=.git/x, a glob that matches)?
function globMatchesGit(segment) {
  if (!segment.startsWith('.') || !/[*?[]/.test(segment)) return false;
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') source += '.*';
    else if (c === '?') source += '.';
    else if (c === '[' && segment.indexOf(']', i + 2) > 0) {
      const end = segment.indexOf(']', i + 2);
      source += '[' + segment.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`, 'i').test('.git'); } catch { return true; }
}
const gitWord = (word) => word.text.toLowerCase().split(/[/=\s]/).some((segment) => segment === '.git' || /^-[a-z]+\.git$/.test(segment)) || word.text.split('/').some(globMatchesGit);
// The current directory named by an expansion alone ("$(pwd)", $PWD) is the project
// itself, .git included. Other expansions are a scope limit.
const wholeProject = (word) => word.dynamic && !word.text.includes('/') && (/^\$\{?(old)?pwd\}?$/i.test(word.text) || word.substitutions.some((text) => /^\s*pwd\s*$/.test(text)));
const sedInPlace = (word) => /^-[A-Za-z]*i|^--in-place/.test(word.text);
// Does this program write to the operands it is given (which may arrive on stdin)?
function selfWrites(head, rest) {
  if (WRITERS.has(head) || head === 'tee') return true;
  if (head === 'sed') return rest.some(sedInPlace);
  if (head === 'sort') return rest.some((word) => /^-[A-Za-z]*o|^--output/.test(word.text));
  if (head === 'less') return rest.some((word) => /^-[Oo]/.test(word.text));
  if (['awk', 'gawk'].includes(head)) return rest.some((word) => /^-i/.test(word.text));
  if (head === 'uniq') return rest.filter((word) => !word.text.startsWith('-')).length >= 2;
  return false;
}
const INTERPRETERS = /^(perl|python[0-9.]*|ruby|node|osascript|awk|gawk|expect)$/;
const INLINE_CODE = { perl: /^-[A-Za-z]*[eE]/, ruby: /^-[A-Za-z]*e/, python: /^-[A-Za-z]*c/, node: /^(-[A-Za-z]*[ep]|--eval|--print)/, osascript: /^-[A-Za-z]*e/ };
const sealedNames = [...sealed].map((ref) => ref.split('/').slice(2).join('/').toLowerCase());
// A guarded program token plus a guarded verb or ref token in inline code.
const GUARDED_TOKENS = {
  deploy: [[/\b(vercel|wrangler)\b/, /\bdeploy\b|--prod/], [/\bnpm\b/, /\bpublish\b/], [/\bgit\b/, /\bpush\b/], [/\bgh\b/, /\brelease\b/], [/\bsupabase\b/, /\bpush\b/]],
  sealed: [[/\bgit\b/, new RegExp(`${sealedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|update-ref|symbolic-ref|filter-`)]],
};
// A literal word that makes an unknown program with an expanded argument suspect.
const DEPLOY_WORDS = new Set(['deploy', '--prod', '--production', 'publish', 'push', 'release']);
const SEALED_WORDS = new Set([...sealedNames, ...sealed, 'update-ref', 'symbolic-ref', 'filter-branch', 'filter-repo']);

const GIT_PATH_IN_CODE = /(?<![a-z0-9_])\.git(?![a-z0-9_])/;
function interpreterPayload(head, rest, mode) {
  if (!INTERPRETERS.test(head)) return false;
  const family = head.replace(/[0-9.]+$/, '');
  const inline = ['awk', 'gawk', 'expect'].includes(head) || rest.some((word) => INLINE_CODE[family]?.test(word.text));
  if (!inline) return false;
  const text = rest.map((word) => word.text).join(' ').toLowerCase();
  // Sealed mode also refuses inline code that names a .git path (os.remove('.git/x')),
  // with no git token needed; awk is judged on its program word, not its operands.
  const code = ['awk', 'gawk'].includes(head) ? (rest.find((word) => !word.text.startsWith('-'))?.text ?? '').toLowerCase() : text;
  if (mode === 'sealed' && GIT_PATH_IN_CODE.test(code)) return true;
  return GUARDED_TOKENS[mode].some(([program, verb]) => program.test(text) && verb.test(text));
}

// Does this program, run in sealed mode, write under a .git segment? Heads that
// recurse into what they run (FOLLOWED) are judged on the inner command; a
// recognised reader only counts when it writes; every other program with an
// operand under .git is refused, as is a write to the whole project.
function gitWrite(head, rest, inGit = false) {
  if (head === 'git' || head === 'cd' || INERT.has(head) || FOLLOWED.has(head) && head !== 'find') return false;
  if (head === 'find') return findWrites(rest, inGit);
  if (rest.some(wholeProject) && selfWrites(head, rest)) return true;
  if (READERS.has(head)) return selfWrites(head, rest) && rest.some(gitWord);
  return rest.some(gitWord);
}
// find writes through -delete, -exec/-execdir/-ok/-okdir of a program that is not a
// reader, and -fprint/-fls files; any word under .git (or the cwd being .git) counts.
function findWrites(rest, inGit) {
  if (!inGit && !rest.some(gitWord)) return false;
  if (rest.some((word) => /^-(delete|fprint0?|fprintf|fls)$/.test(word.text))) return true;
  for (let i = 0; i < rest.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(rest[i].text)) continue;
    let end = rest.findIndex((word, k) => k > i && [';', '+'].includes(word.text));
    if (end < 0) end = rest.length;
    let clause;
    try { clause = executable(rest.slice(i + 1, end)).words; } catch { return true; }
    const head = clause[0] && !clause[0].dynamic ? lowerBase(clause[0]) : null;
    if (!head || !(READERS.has(head) || INERT.has(head)) || selfWrites(head, clause.slice(1))) return true;
    i = end;
  }
  return false;
}

function wrapsConsequential(words, mode, context, depth, piped = false, appended = false) {
  if (!words.length) return false; // assignment-only command: no program word
  const triggers = (facts) => facts.wrapper || (mode === 'sealed' ? Boolean(facts.sealedRef || facts.ambiguous) : facts.consequential);
  const script = (text) => {
    try { return triggers(classify(text, mode, context, depth + 1)); }
    catch { return true; } // a script that does not parse cannot be shown harmless
  };
  const head = lowerBase(words[0]);
  const rest = words.slice(1);
  const dynamicRest = rest.some((word) => word.dynamic);
  if (interpreterPayload(head, rest, mode)) return true;
  if (mode === 'sealed' && gitWrite(head, rest)) return true;
  // Words after an inert head or a filter are text, never programs.
  if (INERT.has(head) || FILTERS.has(head)) return false;

  // The words a wrapper hands on start with a program: resolve them the same
  // way. Blocks when they do not resolve, are expanded, or are empty.
  const follow = (remainder, viaXargs = appended) => {
    let resolved;
    try { resolved = executable(remainder); } catch { return true; }
    if (resolved.calls.some((call) => script(call.text))) return true;
    const next = resolved.words;
    if (!next.length) return resolved.calls.length ? false : true;
    if (next[0].dynamic && !['[', '[['].includes(next[0].text)) return true;
    // xargs hands its stdin lines to a writer as operands, which may name .git.
    if (mode === 'sealed' && viaXargs && selfWrites(lowerBase(next[0]), next.slice(1))) return true;
    const facts = programFacts(next, resolved.gitContextOverride ? null : context, mode);
    // xargs appends its stdin data to the argument list, so any recognised
    // program there is incomplete; elsewhere only a triggering command blocks.
    if (facts) return viaXargs || facts.wrapper || (mode === 'sealed' ? triggers(facts) : lowerBase(next[0]) === 'git' ? facts.deploy : facts.consequential);
    return wrapsConsequential(next, mode, context, depth, false, viaXargs);
  };

  // A wrapper passes on words that are only known at run time.
  if (WRAPPERS.has(head) && dynamicRest) return true;

  if (head === 'xargs') {
    const walked = walkOptions(rest, XARGS_OPTIONS);
    if (walked.unknown) return true; // includes every replace-string form
    const remainder = rest.slice(walked.at);
    return remainder.length ? follow(remainder, true) : false; // bare xargs runs echo
  }
  // sudo -s/-i and doas -s hand a shell string on, or read a script from stdin.
  if (head === 'sudo' || head === 'doas') {
    const walked = walkOptions(rest, SUDO_OPTIONS);
    if (walked.unknown) return true;
    const remainder = rest.slice(walked.at);
    if (['s', 'i', 'shell', 'login'].some((option) => walked.seen.has(option))) {
      return !remainder.length || remainder.some((word) => word.dynamic) || script(remainder.map((word) => word.text).join(' '));
    }
    return follow(remainder);
  }
  if (head === 'chroot') {
    const walked = walkOptions(rest, { flags: '', valued: '', long: { userspec: true, groups: true, 'skip-chdir': false } });
    if (walked.unknown) return true;
    return follow(rest.slice(walked.at + 1));
  }
  if (head === 'find') {
    // Each -exec/-execdir/-ok/-okdir clause runs up to its ; or + terminator.
    for (let i = 0; i < rest.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(rest[i].text)) continue;
      let end = rest.findIndex((word, k) => k > i && [';', '+'].includes(word.text));
      if (end < 0) end = rest.length;
      if (follow(rest.slice(i + 1, end))) return true;
      i = end;
    }
    return false;
  }
  // These take a shell string (watch 'cmd', su -c 'cmd', parallel 'cmd' ::: x).
  if (['watch', 'su', 'parallel', 'runuser'].includes(head) && rest.some((word) => !/^-/.test(word.text) && script(word.text))) return true;
  // fish takes its script from -c/-C/--command[=..]/--init-command[=..].
  if (head === 'fish') {
    const scripts = rest.map((word) => word.text.replace(/^--(init-)?command=/, '')).filter((text) => !/^-/.test(text));
    const informational = rest.length === 1 && ['--version', '--help', '-v', '-h'].includes(rest[0].text);
    return dynamicRest || scripts.some(script) || scripts.some(pseudoFile) || !informational && !scripts.length;
  }
  // source/. run a file or, for a pseudo-file or an expanded name, unseen text.
  if (['source', '.'].includes(head) && rest.some((word) => word.dynamic || pseudoFile(word.text) || mode === 'sealed' && gitWord(word))) return true;
  if (SHELLS.has(head)) {
    const flag = rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text));
    if (flag >= 0) {
      // The script is the first non-option word after -c; -o and -O take an
      // operand and `--` ends the options.
      let at = flag + 1;
      let unknown = false;
      // The -c word itself can end in -o or -O (bash -co pipefail 'script').
      if (/[oO]$/.test(rest[flag].text)) { if (rest[at]?.dynamic) unknown = true; at++; }
      while (rest[at] && /^[-+]/.test(rest[at].text)) {
        const option = rest[at];
        at++;
        if (option.dynamic) unknown = true;
        if (option.text === '--') break;
        if (/^[-+][A-Za-z]*[oO]$/.test(option.text)) { if (rest[at]?.dynamic) unknown = true; at++; }
      }
      // A script built by expansion cannot be classified from its visible text.
      // Words after the script are its positional arguments (bash -c 'rm "$@"' _ .git/x).
      if (mode === 'sealed' && rest.slice(at + 1).some(gitWord)) return true;
      return unknown || Boolean(rest[at]?.dynamic) || script(rest[at]?.text ?? '(');
    }
    // With no -c and no literal script-file operand the shell reads its script
    // from stdin (or a pseudo-file, or a name only known at run time).
    let at = 0;
    let stdin = false;
    while (rest[at] && /^[-+]/.test(rest[at].text)) {
      const text = rest[at].text;
      if (/^-[A-Za-z]*s[A-Za-z]*$/.test(text)) stdin = true;
      if (text === '-' || text === '--') { at++; break; }
      at += (/^[-+][A-Za-z]*[oO]$/.test(text) || SHELL_OPERAND.test(text)) ? 2 : 1;
    }
    const informational = rest.length === 1 && ['--version', '--help'].includes(rest[0].text);
    return !informational && (stdin || !rest[at] || rest[at].dynamic || pseudoFile(rest[at].text) || mode === 'sealed' && rest.slice(at).some(gitWord));
  }
  if (head === 'eval' && (dynamicRest || script(rest.map((word) => word.text).join(' ')))) return true;

  // Backstop for a head nobody listed: a shell fed by a pipe behind an unknown
  // launcher reads the pipe.
  if (piped) {
    for (let i = 1; i < words.length; i++) {
      const name = lowerBase(words[i]);
      if ((SHELLS.has(name) || ['fish', 'source', '.'].includes(name)) && wrapsConsequential(words.slice(i), mode, context, depth, false)) return true;
    }
  }
  // Backstop: a recognised program anywhere after the unknown head counts as
  // passed on. Bare `foo vercel` stays allowed in deploy mode.
  const wrapperHead = WRAPPERS.has(head);
  for (let i = 0; i < words.length; i++) {
    const name = lowerBase(words[i]);
    const facts = programFacts(words.slice(i), context, mode);
    if (!facts) continue;
    const wrappedBefore = words.slice(0, i).some((word) => WRAPPERS.has(lowerBase(word)));
    const claimed = i === 0 || wrapperHead || wrappedBefore || (mode === 'sealed' || name === 'git' ? true : facts.deploy || words.length > i + 1);
    if (claimed && (facts.wrapper || (mode === 'sealed' ? triggers(facts) : name === 'git' ? facts.deploy : facts.consequential))) return true;
  }
  // Backstop for launchers nobody listed (foo $X deploy --prod): an expanded
  // word followed by a guarded literal.
  const firstDynamic = rest.findIndex((word) => word.dynamic);
  const literals = mode === 'sealed' ? SEALED_WORDS : DEPLOY_WORDS;
  return firstDynamic >= 0 && rest.slice(firstDynamic + 1).some((word) => literals.has(word.text.toLowerCase()));
}

function classify(text, mode, base = root, depth = 0) {
  if (depth > 8) throw new Error('nested substitutions exceed parser bounds');
  const facts = { consequential: false, deploy: false, sealedRef: null, ambiguous: false, wrapper: false };
  const combine = (next) => {
    facts.wrapper ||= Boolean(next.wrapper);
    facts.consequential ||= next.consequential;
    facts.deploy ||= next.deploy;
    facts.sealedRef ||= next.sealedRef;
    facts.ambiguous ||= next.ambiguous;
  };
  let context = base;
  let piped = false;
  // Where later words run, as far as a literal cd shows: a real directory, or null
  // when it cannot be known. Only sealed mode needs it (writes inside .git).
  let cwd = base;
  const underGit = (directory) => Boolean(directory) && path.relative(root, directory).split(path.sep).some((segment) => segment.toLowerCase() === '.git');
  for (const entry of tokenize(text)) {
    const wasPiped = piped;
    piped = entry.separator === '|';
    for (const word of entry.words) for (const nested of word.substitutions) combine(classify(nested, mode, context, depth + 1));
    const { words, gitContextOverride, calls } = executable(entry.words);
    // An environment-supplied git config (GIT_CONFIG_*) can define an alias, in
    // either mode. Words that are only printed do not count.
    if (!INERT.has(words[0] ? lowerBase(words[0]) : '') && entry.words.some((word) => /^GIT_CONFIG(_COUNT|_KEY_[0-9]+|_VALUE_[0-9]+|_PARAMETERS|_GLOBAL|_SYSTEM)?=/.test(word.text))) facts.wrapper = true;
    for (const call of calls) combine(classify(call.text, mode, context, depth + 1));
    // A program word that is not a literal name (expansion, substitution, glob, ~)
    // cannot be matched against the tables; `[` and `[[` are the test builtins.
    if (words[0]?.dynamic && !['[', '[['].includes(words[0].text)) throw new Error('dynamic command word');
    if (!words.length && gitContextOverride) context = null;
    const name = words[0]?.text;
    if (['cd', 'pushd', 'popd'].includes(name)) {
      context = name === 'cd' && words.length === 2 && entry.separator === '&&' ? resolveDirectory(context, words[1]) : null;
      // A target spelled through .git is the git directory even before it exists.
      if (words.slice(1).some(gitWord)) cwd = path.join(root, '.git');
      else cwd = name !== 'popd' && words.length === 2 && !words[1].dynamic && !words[1].text.startsWith('-') && entry.words.length === words.length ? physicalDirectory(cwd, words[1].text) : null;
      continue;
    }
    if (mode === 'sealed' && cwdWrites(words, cwd, underGit(cwd))) facts.wrapper = true;
    const known = programFacts(words, gitContextOverride ? null : context, mode);
    if (known) combine(known);
    else if (wrapsConsequential(words, mode, context, depth, wasPiped)) facts.wrapper = true;
    if (entry.separator === '||' || entry.separator === '|' || entry.separator === '&') context = null;
  }
  return facts;
}

// The real directory a literal cd lands in, or null when it cannot be known (an
// unknown directory before it, a symlink that does not resolve, a missing target).
function physicalDirectory(from, target) {
  try {
    const physical = fs.realpathSync(path.resolve(from ?? root, target));
    return from || path.isAbsolute(target) ? physical : null;
  } catch { return null; }
}

// Sealed mode, after a cd: inside .git every program but a reader refuses; when the
// directory is unknown a known writer with a relative operand cannot be judged.
function cwdWrites(words, cwd, inGit) {
  const head = words[0] ? lowerBase(words[0]) : '';
  if (!head || head === 'git' || INERT.has(head)) return false;
  const rest = words.slice(1);
  if (head === 'find') return inGit && findWrites(rest, true);
  if (inGit) return !READERS.has(head) || selfWrites(head, rest);
  if (cwd) return false;
  // Unknown cwd: look through a wrapper (sudo rm x) for a writer with a relative operand.
  const relative = (operands) => operands.some((word) => !word.text.startsWith('-') && !word.text.startsWith('/'));
  if (READERS.has(head)) return selfWrites(head, rest) && relative(rest);
  return words.some((word, i) => selfWrites(lowerBase(word), words.slice(i + 1)) && relative(words.slice(i + 1)));
}

function cycleAuthority() {
  const directory = path.join(root, '.workflow/state/graph-cycles');
  if (!inspect(directory, 'directory')) throw new Error('deploy requires exactly one valid running cycle (found 0)');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 1024) throw new Error('cycle authority exceeds bounds');
  const running = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new UnsafePath('redirected cycle authority');
    if (!entry.isDirectory()) continue;
    const record = JSON.parse(readBounded(path.join(directory, entry.name, 'run.json')));
    if (!record || Array.isArray(record) || record.schema_version !== 1 || typeof record.cycleId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.cycleId) || record.cycleId !== entry.name || !statuses.has(record.status) || record.args?.cycleId !== undefined && record.args.cycleId !== record.cycleId) {
      throw new Error('invalid cycle authority record');
    }
    if (record.status === 'running') running.push(record.cycleId);
  }
  if (running.length !== 1) throw new Error(`deploy requires exactly one valid running cycle (found ${running.length})`);
  return running[0];
}

function decide(mode, command) {
  const result = { decision: 'allow', reason: '', cycle: null, sealedRef: null, marker: null, logAllowed: true };
  try { inspect(path.join(root, '.workflow/state/events.jsonl')); }
  catch { result.logAllowed = false; }
  const block = (reason) => ({ ...result, decision: 'block', reason });
  let facts;
  try { facts = classify(command, mode); }
  catch (error) { return block('unsupported command syntax: ' + error.message); }
  if (facts.wrapper) return block('unrecognised command wrapper');
  if (mode === 'sealed') {
    result.sealedRef = facts.sealedRef;
    if (facts.sealedRef) return block('destructive operation targets sealed ref ' + facts.sealedRef);
    if (facts.ambiguous) return block('ambiguous Git mutation cannot exclude a sealed ref');
    return result;
  }
  if (!facts.consequential) return result;
  try {
    if (inspect(path.join(root, '.workflow/state/graph-halt'))) return block('graph kill switch is active (.workflow/state/graph-halt exists) -- only the user clears it, with /graph-resume');
  } catch { result.logAllowed = false; return block('unsafe or unreadable graph halt authority'); }
  if (!facts.deploy) return result;
  try {
    result.cycle = cycleAuthority();
    result.marker = `.workflow/state/graph-approvals/${result.cycle}.deploy`;
    if (!inspect(path.join(root, result.marker))) return block('production-deploy command with no approval marker at ' + result.marker);
  } catch (error) {
    if (error instanceof UnsafePath) result.logAllowed = false;
    return block('invalid deploy authority: ' + error.message);
  }
  return { ...result, decision: 'approved' };
}

try {
  const [mode, command, ...extra] = process.argv.slice(2);
  if (!['deploy', 'sealed'].includes(mode) || typeof command !== 'string' || extra.length) throw new Error('expected <deploy|sealed> <one command argv>');
  process.stdout.write(JSON.stringify(decide(mode, command)) + '\n');
} catch (error) {
  process.stderr.write('graph-command-classifier.mjs: ' + error.message + '\n');
  process.exitCode = 1;
}
