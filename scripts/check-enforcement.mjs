// specs/graph/enforcement-traceability.md: finite, read-only reference integrity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isAlias, isCollection, isMap, isScalar } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMALL = 262144, BASE_CAP = 1048576;
const REQ = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class Failure extends Error { constructor(category) { super(category); this.category = category; } }
function check(ok, category) { if (!ok) throw new Failure(category); }
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function contained(name, category = 'input', directory = false) {
  check(typeof name === 'string' && name.length <= 1024, 'input');
  const file = path.resolve(ROOT, name), relative = path.relative(ROOT, file);
  check(relative && !relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative), category);
  try {
    let current = ROOT;
    check(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), category);
    const parts = relative.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const state = fs.lstatSync(current, { bigint: true });
      check(!state.isSymbolicLink(), category);
      if (i < parts.length - 1 || directory) check(state.isDirectory(), category);
      else check(state.isFile() && state.nlink === 1n, category);
    }
    return file;
  } catch (error) { if (error instanceof Failure) throw error; throw new Failure(category); }
}
function read(name, cap = SMALL) {
  const file = contained(name);
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    check(before.size <= BigInt(cap), 'input');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    check(same(before, fs.fstatSync(fd, { bigint: true })), 'input');
    const bytes = Buffer.alloc(cap + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    check(used <= cap && BigInt(used) === before.size && same(before, fs.fstatSync(fd, { bigint: true })) &&
      same(before, fs.lstatSync(file, { bigint: true })), 'input');
    contained(name);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
  } catch (error) { if (error instanceof Failure) throw error; throw new Failure('input'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(text) {
  try { return JSON.parse(text); } catch { throw new Failure('structure'); }
}
function literalPath(value) {
  check(typeof value === 'string' && value.length <= 1024, 'input');
  check(value.length > 0 && !/[\\\x00-\x1f\x7f:?#*\[\]]/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..'), 'reference');
}

// Preserve physical lines while hiding comments/fences. No Markdown is executed.
function visible(text) {
  const lines = [], rawLines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null, comment = false;
  for (const raw of rawLines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      lines.push({ text: '', physical: raw }); continue;
    }
    if (!comment) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        fence = open[1]; lines.push({ text: '', physical: raw }); continue;
      }
    }
    let rest = raw, output = '';
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->');
        if (end === -1) { rest = ''; break; }
        rest = rest.slice(end + 3); comment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) { output += rest; rest = ''; break; }
        output += rest.slice(0, start); rest = rest.slice(start + 4);
        if (rest.startsWith('>')) rest = rest.slice(1);
        else if (rest.startsWith('->')) rest = rest.slice(2);
        else comment = true;
      }
    }
    lines.push({ text: output, physical: raw });
  }
  check(!comment && !fence, 'structure');
  return lines;
}
function requirements(file, entries) {
  let active = null, count = 0;
  const ids = new Set();
  function finish() {
    if (!active) return;
    check(active.values.length === 1, 'structure');
    entries.push({ key: `${file}#${active.id}`, value: active.values[0] }); active = null;
  }
  for (const row of visible(read(file))) {
    const line = row.text;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length, token = heading[2].trim().split(/[ \t]/)[0];
      if (active && level <= active.level) finish();
      if (token.startsWith('REQ-')) {
        check((level === 2 || level === 3) && REQ.test(token) && !active && !ids.has(token), 'structure');
        ids.add(token); count++; active = { id: token, level, values: [] };
      }
    }
    // Comment removal must not manufacture a complete physical annotation line.
    const annotation = line === row.physical ? /^\*\*Enforced by:\*\* (.*)$/.exec(line) : null;
    if (annotation && active) active.values.push(annotation[1]);
  }
  finish(); return count;
}
function specFiles() {
  const all = [];
  function walk(relative, depth) {
    check(depth <= 16, 'input');
    const directory = contained(relative, 'input', true);
    const handle = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const child = relative + '/' + entry.name;
        check(child.length <= 1024 && !entry.isSymbolicLink(), 'input');
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (entry.name.endsWith('.md')) {
          contained(child); all.push(child); check(all.length <= 512, 'input');
        }
      }
    } finally { handle.closeSync(); }
  }
  for (const scope of ['specs/graph', 'specs/security']) {
    const before = all.length; walk(scope, 0); check(all.length > before, 'structure');
  }
  return all.sort();
}
function tiers() {
  const source = visible(read('docs/SECURITY.md')), lines = source.map(row => row.text);
  const headers = ['Tier', 'When', 'Runs today', 'Gate today', 'Planned, not wired'];
  const entries = []; let tables = 0;
  function cells(line) {
    const trimmed = line.trim();
    check(trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.includes('\\|'), 'structure');
    return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    // Unrelated tables are prose: validate row grammar only after selecting this header.
    const preview = lines[i].trim().split('|').slice(1).map(cell => cell.trim());
    if (!headers.every((value, j) => preview[j] === value)) continue;
    const row = cells(lines[i]);
    tables++; check(tables === 1 && row.length === 6 && row[5] === 'Enforced by:', 'structure');
    const separator = cells(lines[++i] ?? '');
    check(separator.length === 6 && separator.every(cell => /^:?-+:?$/.test(cell)), 'structure');
    const keys = new Set();
    while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const data = cells(source[++i].physical);
      check(data.length === 6 && /^[123]$/.test(data[0]) && !keys.has(data[0]), 'structure');
      keys.add(data[0]);
      const value = /^Enforced by: (.+)$/.exec(data[5]); check(value, 'structure');
      entries.push({ key: `docs/SECURITY.md#tier-${data[0]}`, value: value[1] });
    }
    check(keys.size === 3, 'structure');
  }
  check(tables === 1, 'structure'); return entries;
}

const TAGS = new Set(['str', 'null', 'bool', 'int', 'float', 'map', 'seq'].map(tag => 'tag:yaml.org,2002:' + tag));
function yaml(text) {
  try {
    const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
      resolveKnownTags: false, merge: false, prettyErrors: false, logLevel: 'error' });
    check(!doc.errors.length && !doc.warnings.length && doc.directives.yaml.version === '1.2', 'structure');
    function inspect(node) {
      if (node === null) return;
      check(!isAlias(node) && (isScalar(node) || isCollection(node)) && (!node.tag || TAGS.has(node.tag)), 'structure');
      if (isMap(node)) {
        for (const pair of node.items) {
          check(isScalar(pair.key) && typeof pair.key.value === 'string', 'structure'); inspect(pair.key); inspect(pair.value);
        }
      } else if (isCollection(node)) { for (const item of node.items) inspect(item); }
    }
    inspect(doc.contents);
    const value = doc.toJS({ maxAliasCount: 0, mapAsMap: false });
    check(object(value) && object(value.jobs), 'structure'); return value;
  } catch { throw new Failure('structure'); }
}

// Reviewed literal command templates; the selected settings never define these allow rules.
const WRAPPERS = [
  ['SessionStart', null, 'bash "${CLAUDE_PROJECT_DIR:-.}/', '" || true'],
  ['SessionStart', null, 'ROOT="${CLAUDE_PROJECT_DIR:-.}"; (cd "$ROOT" && bash ', ') || true'],
  ['PreToolUse', 'Bash', "jq -r '.tool_input.command // empty' | { cmd=$(cat); [ -z \"$cmd\" ] && exit 0; ROOT=\"${CLAUDE_PROJECT_DIR:-}\"; if [ -z \"$ROOT\" ]; then ROOT=$(git rev-parse --show-toplevel 2>/dev/null); [ -n \"$ROOT\" ] && echo \"HOOK WARNING: CLAUDE_PROJECT_DIR unset; project root resolved from cwd: $ROOT\" >&2; fi; [ -n \"$ROOT\" ] || { echo \"HOOK: cannot resolve the project root (CLAUDE_PROJECT_DIR unset and cwd $(pwd) is not inside a git repo) -- failing closed\" >&2; exit 2; }; cd \"$ROOT\" || { echo \"HOOK: cannot cd to project root $ROOT -- failing closed\" >&2; exit 2; }; H=", '; [ -f "$H" ] || { echo "HOOK MISSING: $ROOT/$H -- failing closed" >&2; exit 2; }; bash "$H" "$cmd"; }'],
  ['PostToolUse', 'Write|Edit', "jq -r '.tool_input.file_path // .tool_response.filePath // empty' | { read -r f; [ -z \"$f\" ] && exit 0; ROOT=\"${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}\"; if [ -z \"$ROOT\" ] || ! cd \"$ROOT\" 2>/dev/null; then echo \"sync-lr-refined-date: could not resolve the project root (CLAUDE_PROJECT_DIR='${CLAUDE_PROJECT_DIR:-}'), skipping\" >&2; exit 0; fi; H=", '; [ -f "$H" ] || { echo "sync-lr-refined-date: hook missing at $ROOT/$H, skipping" >&2; exit 0; }; bash "$H" "$f" || true; }'],
];
function resolver() {
  const workflows = new Map(); let settings;
  function getSettings() {
    if (settings) return settings;
    settings = json(read('.claude/settings.json'));
    check(object(settings) && object(settings.hooks), 'structure');
    for (const groups of Object.values(settings.hooks)) {
      check(Array.isArray(groups), 'structure');
      for (const group of groups) {
        check(object(group) && (!Object.hasOwn(group, 'matcher') || typeof group.matcher === 'string') && Array.isArray(group.hooks), 'structure');
        for (const hook of group.hooks) check(object(hook) && typeof hook.type === 'string' &&
          (hook.type !== 'command' || typeof hook.command === 'string'), 'structure');
      }
    }
    return settings;
  }
  return value => {
    if (value === 'PROCESS') return 'process';
    if (value === 'UNENFORCED') return 'unenforced';
    const refs = value.split('; ');
    check(refs.length <= 32, 'input');
    check(value.length > 0 && new Set(refs).size === refs.length, 'reference');
    for (const ref of refs) {
      check(ref.length <= 1024, 'input');
      if (ref.startsWith('test:')) {
        const name = ref.slice(5); literalPath(name);
        check((name.startsWith('tests/') && name.endsWith('.test.mjs')) ||
          (name.startsWith('runtime/test/') && name.endsWith('.test.ts')), 'reference');
        contained(name, 'reference');
      } else if (ref.startsWith('job:')) {
        const match = /^job:(\.github\/workflows\/[^/#]+\.yml)#([A-Za-z_][A-Za-z0-9_-]*)$/.exec(ref);
        check(match, 'reference'); const [, name, id] = match; literalPath(name);
        if (!workflows.has(name)) workflows.set(name, yaml(read(name)));
        const jobs = workflows.get(name).jobs;
        check(Object.hasOwn(jobs, id) && object(jobs[id]), 'reference');
      } else if (ref.startsWith('hook:')) {
        const match = /^hook:([^:]+):([^:]+):(hooks\/.+\.sh)$/.exec(ref);
        check(match, 'reference'); const [, event, matcher, name] = match; literalPath(name);
        check(name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part)), 'reference');
        contained(name, 'reference');
        const parsed = getSettings(), commands = WRAPPERS.filter(([e, m]) => e === event && (m ?? '-') === matcher)
          .map(([, , prefix, suffix]) => prefix + name + suffix);
        const groups = Object.hasOwn(parsed.hooks, event) ? parsed.hooks[event] : [];
        check(groups.some(group => (matcher === '-' ? !Object.hasOwn(group, 'matcher') : group.matcher === matcher) &&
          group.hooks.some(hook => hook.type === 'command' && commands.includes(hook.command))), 'reference');
      } else throw new Failure('reference');
    }
    return 'mechanical';
  };
}
function baseline(name) {
  const data = json(read(name, BASE_CAP));
  check(object(data) && Object.keys(data).sort().join(',') === 'enforced,schema_version' &&
    data.schema_version === 1 && Array.isArray(data.enforced), 'structure');
  let previous;
  for (const key of data.enforced) {
    check(typeof key === 'string', 'structure'); check(key.length <= 1024, 'input');
    const match = /^(specs\/(?:graph|security)\/.+\.md)#(REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*)$/.exec(key);
    check(/^docs\/SECURITY\.md#tier-[123]$/.test(key) || match, 'structure');
    if (match) {
      check(!/[\\\x00-\x1f\x7f:?#*\[\]]/.test(match[1]) &&
        !match[1].split('/').some(part => !part || part === '.' || part === '..'), 'structure');
    }
    check(previous === undefined || previous < key, 'structure'); previous = key;
  }
  return data.enforced;
}
function main() {
  const args = process.argv.slice(2);
  check(args.length === 0 || (args.length === 2 && args[0] === '--ratchet' && args[1] && !args[1].startsWith('--')), 'usage');
  const entries = [], scopes = new Map([['specs/graph', 0], ['specs/security', 0]]);
  let reqs = 0;
  for (const file of specFiles()) {
    const count = requirements(file, entries);
    const scope = file.startsWith('specs/graph/') ? 'specs/graph' : 'specs/security';
    scopes.set(scope, scopes.get(scope) + count); reqs += count; check(reqs <= 8192, 'input');
  }
  check([...scopes.values()].every(count => count > 0), 'structure');
  entries.push(...tiers());
  const resolve = resolver(), counts = { mechanical: 0, process: 0, unenforced: 0 }, keys = [];
  for (const entry of entries) {
    const kind = resolve(entry.value); counts[kind]++;
    if (kind === 'mechanical') keys.push(entry.key);
  }
  keys.sort(); const current = baseline('governance/enforcement-baseline.json');
  check(current.length === keys.length && current.every((key, i) => key === keys[i]), 'ratchet');
  if (args.length) { const currentSet = new Set(current); check(baseline(args[1]).every(key => currentSet.has(key)), 'ratchet'); }
  process.stdout.write(`enforcement: references valid reqs=${reqs} tiers=3 mechanical=${counts.mechanical} process=${counts.process} unenforced=${counts.unenforced}\n`);
}
try { main(); }
catch (error) {
  process.stderr.write(`enforcement: ${error instanceof Failure ? error.category : 'input'}\n`);
  process.exitCode = 1;
}
