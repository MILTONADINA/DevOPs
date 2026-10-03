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
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else append(c); continue; }
    if (c === '\\') {
      if (i + 1 === text.length) throw new Error('unfinished escape');
      const next = text[++i];
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
    if (c === '"') { append(''); quote = quote === '"' ? null : '"'; continue; }
    if (quote === '"') { append(c); if (c === '$') word.dynamic = true; continue; }
    if (c === "'") { append(''); quote = "'"; continue; }
    if (c === '#' && !word) { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (';\n|&'.includes(c)) {
      let separator = c;
      if ((c === '|' || c === '&') && text[i + 1] === c) separator += text[++i];
      finish(separator);
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
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

// Only these literal prefixes are understood. Other programs (including
// script-file wrappers, aliases and eval) remain documented scope limits.
function executable(words) {
  let index = 0;
  let gitContextOverride = false;
  const assignment = () => {
    const value = words[index]?.text;
    if (!value || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return false;
    if (/^GIT_[A-Za-z0-9_]*=/.test(value)) gitContextOverride = true;
    index++;
    return true;
  };
  while (assignment()) { /* Assignment values stay inert. */ }
  if (words[index]?.text === 'env') {
    index++;
    while (words[index]) {
      const text = words[index].text;
      if (assignment()) continue;
      if (['-i', '--ignore-environment'].includes(text)) index++;
      else if (text === '-u' || text === '--unset') {
        if (!words[index + 1]) throw new Error('missing env option operand');
        index += 2;
      }
      else if (text.startsWith('--unset=')) index++;
      else if (text === '--') {
        index++;
        while (assignment()) { /* env still accepts NAME=value after --. */ }
        break;
      }
      else if (text.startsWith('-')) throw new Error('unsupported env prefix option');
      else break;
    }
  }
  if (words[index]?.text === 'command') {
    index++;
    if (words[index]?.text === '--') index++;
    else if (words[index]?.text.startsWith('-')) throw new Error('unsupported command prefix option');
  }
  if (words[index]?.text === 'npx') {
    index++;
    while (['--yes', '-y', '--no-install', '--'].includes(words[index]?.text)) index++;
    if (words[index]?.text.startsWith('-')) throw new Error('unsupported npx prefix option');
  }
  return { words: words.slice(index), gitContextOverride };
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

function gitCommand(words, base) {
  let context = base;
  let uncertain = false;
  let index = 1;
  while (words[index]?.text.startsWith('-')) {
    const arg = words[index++].text;
    if (arg === '-C') context = resolveDirectory(context, words[index++]);
    else if (arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace' || arg === '--config-env') {
      uncertain = true; index++;
    } else if (['--no-pager', '--paginate', '-p', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(arg)) {
      // These options neither choose refs nor redirect metadata.
    } else uncertain = true;
  }
  return { verb: words[index]?.text, args: words.slice(index + 1), context: uncertain ? null : context, uncertain };
}

function exactSealed(ref, namespace) {
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

function classify(text, mode, base = root, depth = 0) {
  if (depth > 8) throw new Error('nested substitutions exceed parser bounds');
  const facts = { consequential: false, deploy: false, sealedRef: null, ambiguous: false };
  const combine = (next) => {
    facts.consequential ||= next.consequential;
    facts.deploy ||= next.deploy;
    facts.sealedRef ||= next.sealedRef;
    facts.ambiguous ||= next.ambiguous;
  };
  let context = base;
  for (const entry of tokenize(text)) {
    for (const word of entry.words) for (const nested of word.substitutions) combine(classify(nested, mode, context, depth + 1));
    const { words, gitContextOverride } = executable(entry.words);
    if (!words.length && gitContextOverride) context = null;
    const name = words[0]?.text;
    if (name === 'cd') {
      context = words.length === 2 && entry.separator === '&&' ? resolveDirectory(context, words[1]) : null;
      continue;
    }
    if (name === 'git') {
      const command = gitCommand(words, gitContextOverride ? null : context);
      if (mode === 'sealed') {
        // Sealed classification uses destinations, never local-ref lookup.
        command.context = null;
      }
      combine(gitFacts(command));
    } else if (['vercel', 'wrangler'].includes(name)) {
      facts.consequential = true;
      facts.deploy ||= words.some((word) => word.text === 'deploy') || name === 'vercel' && words.some((word) => ['--prod', '--production'].includes(word.text));
    } else if (name === 'npm' && words[1]?.text === 'publish' || name === 'supabase' && words[1]?.text === 'db' && words[2]?.text === 'push') {
      facts.consequential = true; facts.deploy = true;
    } else if (name === 'gh') {
      if (words[1]?.text === 'pr' && words[2]?.text === 'merge') facts.consequential = true;
      if (words[1]?.text === 'release' && !['list', 'view', 'download', '--help', '-h'].includes(words[2]?.text)) { facts.consequential = true; facts.deploy = true; }
    }
    if (entry.separator === '||' || entry.separator === '|' || entry.separator === '&') context = null;
  }
  return facts;
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
