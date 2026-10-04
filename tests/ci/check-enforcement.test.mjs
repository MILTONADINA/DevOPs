// specs/graph/enforcement-traceability.md REQ-1..7 / AC-1..7.
// Source-reference CLI only: all named tests, hooks and workflow commands stay inert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-enforcement.mjs');
const PRIVATE = 'MR17_PRIVATE_SOURCE_SENTINEL';
const ARGUMENT = 'MR17_PRIVATE_ARGUMENT_SENTINEL';
const GRAPH = 'specs/graph/owned.md', SECURITY = 'specs/security/owned.md';
const BASELINE = 'governance/enforcement-baseline.json', SETTINGS = '.claude/settings.json';
const WORKFLOW = '.github/workflows/owned.yml', TEST = 'tests/owned/example.test.mjs';
const GKEY = GRAPH + '#REQ-G1', TKEY = 'docs/SECURITY.md#tier-2';
const TEST_REF = 'test:' + TEST, JOB_REF = 'job:' + WORKFLOW + '#scan';
const BASE_KEYS = [TKEY, GKEY].sort();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requirement = (id, value, level = 2) => `${'#'.repeat(level)} ${id} — owned requirement\nTHE CHECKER SHALL treat this as inert data.\n**Enforced by:** ${value}\n`;
const table = (second = JOB_REF) => `# Security\n\n| Tier | When | Runs today | Gate today | Planned, not wired | Enforced by: |\n|---|---|---|---|---|---|\n| 1 | file write | nothing automatic | none | unwired detector | Enforced by: UNENFORCED |\n| 2 | PR | fixture job | fixture gate | future | Enforced by: ${second} |\n| 3 | scheduled | partial only | not a whole-row guarantee | future | Enforced by: UNENFORCED |\n`;
function feature() { assert.ok(existsSync(SCRIPT), 'FEATURE_ABSENT: scripts/check-enforcement.mjs is not implemented'); }
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, 'owned fixture mutation must have one target');
  return source.replace(from, to);
}
function tree(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), st = lstatSync(file);
    const identity = [st.mode, st.ino, st.nlink];
    if (st.isDirectory()) return [[file, 'directory', identity], ...tree(file)];
    return [[file, identity, st.isSymbolicLink() ? ['symlink', readlinkSync(file)] : digest(readFileSync(file))]];
  });
}
function withFixture(fn) {
  feature();
  const yaml = path.join(ROOT, 'node_modules/yaml/package.json');
  assert.ok(existsSync(yaml), 'fixture prerequisite: locked yaml must be installed');
  assert.equal(JSON.parse(readFileSync(yaml, 'utf8')).version, '2.9.1', 'locked parser prerequisite');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'enforcement-cli-')));
  const root = path.join(outer, 'project'), elsewhere = path.join(outer, 'different-cwd');
  mkdirSync(root); mkdirSync(elsewhere);
  const file = (relative, data) => {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data); return target;
  };
  const baseline = (keys = BASE_KEYS) => file(BASELINE, JSON.stringify({ schema_version: 1, enforced: keys }) + '\n');
  const sentinel = path.join(root, 'source-was-executed');
  try {
    file('package.json', '{"type":"module"}\n');
    const script = file('scripts/check-enforcement.mjs', readFileSync(SCRIPT));
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    file(GRAPH, requirement('REQ-G1', TEST_REF));
    file(SECURITY, requirement('REQ-S1', 'PROCESS'));
    file('docs/SECURITY.md', table()); baseline();
    file(TEST, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(PRIVATE)});\nthrow new Error(${JSON.stringify(PRIVATE)});\n`);
    file(WORKFLOW, `name: Owned\non: workflow_dispatch\njobs:\n  scan:\n    runs-on: ubuntu-24.04\n    if: \${{ false }}\n    steps:\n      - run: 'echo ${PRIVATE} > source-was-executed'\n`);
    const originalSettings = JSON.parse(readFileSync(path.join(ROOT, SETTINGS), 'utf8'));
    file(SETTINGS, JSON.stringify(originalSettings));
    const wrappers = [
      ['SessionStart', '-', 'hooks/universal/session-start/graph-preflight.sh'],
      ['SessionStart', '-', 'hooks/universal/session-start/load-baton.sh'],
      ['PreToolUse', 'Bash', 'hooks/universal/pre-tool/block-sealed-refs.sh'],
      ['PreToolUse', 'Bash', 'hooks/universal/pre-tool/deploy-gate.sh'],
      ['PostToolUse', 'Write|Edit', 'hooks/universal/post-tool/sync-lr-refined-date.sh'],
    ].map(([event, matcher, hook]) => {
      const blocks = originalSettings.hooks[event].filter(block => (block.matcher ?? '-') === matcher);
      const entries = blocks.flatMap(block => block.hooks).filter(entry => entry.type === 'command' && entry.command.includes(hook));
      assert.equal(entries.length, 1, 'actual full wrapper prerequisite');
      file(hook, `#!/bin/sh\nprintf '%s' '${PRIVATE}' > source-was-executed\nexit 99\n`);
      return { event, matcher, hook, command: entries[0].command };
    });
    const f = { root, outer, elsewhere, file, baseline, wrappers, originalSettings,
      graph(value = TEST_REF) { file(GRAPH, requirement('REQ-G1', value)); },
      settings(value) { file(SETTINGS, JSON.stringify(value)); },
      onlyWrapper(wrapper, command = wrapper.command, matcher = wrapper.matcher, event = wrapper.event) {
        const block = { hooks: [{ type: 'command', command }] };
        if (matcher !== '-') block.matcher = matcher;
        f.settings({ hooks: { [event]: [block] } });
      },
      invoke(args = [], cwd = root) {
        const before = tree(outer);
        const result = spawnSync(process.execPath, [script, ...args], {
          cwd, env: { PATH: '', HOME: root, LANG: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
        });
        assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
        assert.deepEqual(tree(outer), before, 'checker must not mutate its owned source tree');
        assert.equal(existsSync(sentinel), false, 'referenced source must never execute');
        const output = result.stdout + result.stderr;
        for (const secret of [PRIVATE, ARGUMENT]) assert.equal(output.includes(secret), false, 'private bodies/arguments must not be echoed');
        assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /, 'loader failure or crash is not a checker refusal');
        assert.equal(output.includes('\u001b'), false); assert.doesNotMatch(output, /^::/m);
        return { ...result, output };
      },
    };
    fn(f);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function passed(result, { reqs = 2, tiers = 3, mechanical = 2, process = 1, unenforced = 2 } = {}) {
  assert.equal(result.status, 0, result.output); assert.equal(result.stderr, '');
  assert.equal(result.stdout, `enforcement: references valid reqs=${reqs} tiers=${tiers} mechanical=${mechanical} process=${process} unenforced=${unenforced}\n`);
}
function refused(result, category) {
  assert.equal(result.status, 1, result.output); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^enforcement: (?:${category})(?:[ :].*)?\\n$`));
}
function group(name, cases, run) { test(name, () => { for (const value of cases) withFixture(f => run(f, value)); }); }

test('valid source-reference counts are independent of CWD and do not execute named source', () => withFixture(f => {
  passed(f.invoke()); passed(f.invoke([], f.elsewhere));
}));
group('CLI refuses missing, duplicate and unknown options privately', [
  [ARGUMENT], ['--root', ARGUMENT], ['--ratchet'], ['--ratchet', BASELINE, ARGUMENT], ['--ratchet', BASELINE, '--ratchet', BASELINE], ['--ratchet=' + ARGUMENT],
], (f, args) => refused(f.invoke(args), 'usage'));
test('separate heading levels and repeated IDs across files remain valid', () => withFixture(f => {
  f.file(GRAPH, '# Graph\n' + requirement('REQ-G1', TEST_REF) + '\n## Separate section\n' + requirement('REQ-G2', 'UNENFORCED', 3));
  f.file(SECURITY, requirement('REQ-G1', 'PROCESS', 3));
  passed(f.invoke(), { reqs: 3, unenforced: 3 });
}));
test('fences, inline comments and AC headings cannot manufacture annotations or REQs', () => withFixture(f => {
  f.file(GRAPH, '<!--\n## REQ-HIDDEN\n**Enforced by:** malformed\n-->\n~~~md\n## REQ-FENCED\n~~~\n' +
    '````md\n```\n## REQ-STILL-FENCED\n`````\n' + requirement('REQ-G1', TEST_REF) +
    '\n### AC-1 (REQ-G1)\nAn example <!-- **Enforced by:** malformed --> stays prose.\n');
  passed(f.invoke());
}));
group('requirement structure refuses missing or ambiguous ownership', [
  source => source.replace('**Enforced by:** ' + TEST_REF + '\n', ''),
  source => source + '**Enforced by:** PROCESS\n',
  source => source + requirement('REQ-G1', 'UNENFORCED'),
  source => source + requirement('REQ-NESTED', 'PROCESS', 3),
  source => source.replace('## REQ-G1 ', '#### REQ-G1 '),
  source => source.replace('REQ-G1 ', 'REQ-G1bad '),
  source => source + '\n<!-- ' + PRIVATE,
  source => source + '\n```md\n' + PRIVATE,
], (f, transform) => { f.file(GRAPH, transform(readFileSync(path.join(f.root, GRAPH), 'utf8'))); refused(f.invoke(), 'structure'); });
group('both spec scopes require nonempty requirement selections', [GRAPH, SECURITY], (f, relative) => {
  f.file(relative, '# No requirements\n' + PRIVATE + '\n'); refused(f.invoke(), 'structure');
});
group('the tier table refuses missing, duplicate and malformed selection', [
  text => text.replaceAll('|', ' '), text => text + '\n' + text,
  text => text.replace('| 3 |', '| 2 |'), text => text.split('\n').filter(line => !line.startsWith('| 3 |')).join('\n'),
  text => text.replace('| none |', '| no\\|ne |'), text => text.replace('| Enforced by: UNENFORCED |', '| Enforced by:\nUNENFORCED |'),
  text => text.replace('| Enforced by: |', '| Other |'),
], (f, transform) => { f.file('docs/SECURITY.md', transform(table())); refused(f.invoke(), 'structure'); });
test('unrelated ordinary Markdown tables do not replace the selected tier table', () => withFixture(f => {
  f.file('docs/SECURITY.md', table() + '\n| Other | Value |\n|---|---|\n| x | ' + PRIVATE + ' |\n'); passed(f.invoke());
}));
test('root and runtime tests plus an own workflow job resolve as one mechanical key', () => withFixture(f => {
  f.file('runtime/test/owned/example.test.ts', 'throw new Error(' + JSON.stringify(PRIVATE) + ');\n');
  f.graph(TEST_REF + '; test:runtime/test/owned/example.test.ts; ' + JOB_REF); passed(f.invoke());
}));
group('exclusive PROCESS and UNENFORCED markers are nonmechanical', ['PROCESS', 'UNENFORCED'], (f, marker) => {
  f.graph(marker); f.baseline([TKEY]);
  passed(f.invoke(), { mechanical: 1, process: marker === 'PROCESS' ? 2 : 1, unenforced: marker === 'UNENFORCED' ? 3 : 2 });
});
group('typed reference grammar refuses malformed kinds, delimiters and unsafe paths', [
  'test:tests/owned/missing.test.mjs', 'test:tests/owned/example.js', 'test:runtime/test/owned/example.test.mjs',
  'source:' + TEST, TEST_REF + '; ' + TEST_REF, 'PROCESS; ' + TEST_REF, 'UNENFORCED; ' + TEST_REF,
  TEST_REF + ';' + JOB_REF, 'test:../' + TEST, 'test:/tests/owned/example.test.mjs',
  'test:tests//owned/example.test.mjs', 'test:tests/./owned/example.test.mjs', 'test:tests/owned/../example.test.mjs',
  'test:tests\\owned\\example.test.mjs', 'test:tests/owned/*.test.mjs', 'test:' + TEST + '?query',
  'job:' + WORKFLOW + '#missing', 'job:' + WORKFLOW + '#bad.id', 'job:' + WORKFLOW + '#scan#other',
], (f, reference) => { f.graph(reference); refused(f.invoke(), 'reference'); });
group('present but wrong-kind reference targets refuse', ['test', 'hook'], (f, kind) => {
  const wrapper = f.wrappers[2], relative = kind === 'test' ? TEST : wrapper.hook;
  rmSync(path.join(f.root, relative)); mkdirSync(path.join(f.root, relative));
  if (kind === 'hook') f.graph(`hook:${wrapper.event}:${wrapper.matcher}:${wrapper.hook}`);
  refused(f.invoke(), 'reference');
});
group('workflow jobs must be own object entries and YAML remains finite', [
  ['jobs: {}\n', 'reference'], ['jobs:\n  scan: []\n', 'reference'], ['jobs:\n  scan: false\n', 'reference'],
  ['jobs:\n  scan: {}\n  scan: {}\n', 'structure'], ['jobs:\n  scan: &alias {}\n  other: *alias\n', 'structure'],
  ['jobs: !custom {}\n', 'structure'], ['jobs: {scan: {}}\n---\n' + PRIVATE + '\n', 'structure'], ['jobs: [\n' + PRIVATE + '\n', 'structure'],
], (f, [source, category]) => { f.file(WORKFLOW, source); refused(f.invoke(), category); });
test('a prototype property is not an own workflow job', () => withFixture(f => {
  f.graph('job:' + WORKFLOW + '#toString'); refused(f.invoke(), 'reference');
}));

test('all five complete current shell wrapper forms resolve without executing shell', () => {
  for (let i = 0; i < 5; i++) withFixture(f => {
    const w = f.wrappers[i]; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`); f.onlyWrapper(w); passed(f.invoke());
  });
});
group('hook mentions, changed wrappers and wrong event or matcher never establish wiring', [
  ['echo', w => 'echo ' + JSON.stringify(w.command)], ['comment', w => '# ' + w.command],
  ['argument', w => 'printf %s ' + JSON.stringify(w.command)], ['suffix', w => w.command + ' || true'],
  ['prefix', w => 'true; ' + w.command], ['wrong matcher', null, 'Other'], ['wrong event', null, 'Bash', 'PostToolUse'],
], (f, [name, transform, matcher, event]) => {
  const w = f.wrappers[2]; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`);
  f.onlyWrapper(w, transform ? transform(w) : w.command, matcher ?? w.matcher, event ?? w.event);
  refused(f.invoke(), 'reference');
});
test('absent matcher is distinct from a literal dash matcher', () => withFixture(f => {
  const w = f.wrappers[0]; f.graph(`hook:${w.event}:-:${w.hook}`);
  f.settings({ hooks: { SessionStart: [{ matcher: '-', hooks: [{ type: 'command', command: w.command }] }] } });
  refused(f.invoke(), 'reference');
}));
test('an unwired detector is refused while the honest tier1 row remains UNENFORCED', () => withFixture(f => {
  const hook = 'hooks/universal/post-tool/gitleaks-scan.sh'; f.file(hook, '# ' + PRIVATE + '\n');
  f.graph('hook:PostToolUse:Write|Edit:' + hook);
  refused(f.invoke(), 'reference');
}));
group('shell-unsafe literal hook files never certify an unquoted assignment wrapper', [
  'hooks/owned/$(touch_marker).sh', 'hooks/owned/x;echo.sh',
], (f, hook) => {
  const w = f.wrappers[2]; f.file(hook, '# ' + PRIVATE + '\n');
  f.graph(`hook:${w.event}:${w.matcher}:${hook}`); f.onlyWrapper(w, replaceOnce(w.command, w.hook, hook));
  refused(f.invoke(), 'reference');
});

group('current baseline is an exact sorted distinct selected mechanical set', [
  [{ schema_version: 1, enforced: [TKEY] }, 'ratchet'],
  [{ schema_version: 1, enforced: [...BASE_KEYS, SECURITY + '#REQ-S1'].sort() }, 'ratchet'],
  [{ schema_version: 1, enforced: [...BASE_KEYS, GKEY].sort() }, 'structure'],
  [{ schema_version: 1, enforced: [...BASE_KEYS].reverse() }, 'structure'],
  [{ schema_version: 1, enforced: ['specs/graph/gone.md#REQ-X', ...BASE_KEYS].sort() }, 'ratchet'],
  [{ schema_version: 2, enforced: BASE_KEYS }, 'structure'], [{ schema_version: 1, enforced: BASE_KEYS, extra: PRIVATE }, 'structure'],
  [{ schema_version: 1, enforced: 'not an array' }, 'structure'], [null, 'structure'],
], (f, [baseline, category]) => { f.file(BASELINE, JSON.stringify(baseline)); refused(f.invoke(), category); });
test('ratchet accepts unchanged set, additions and valid mechanism substitution', () => withFixture(f => {
  f.file('inputs/base.json', JSON.stringify({ schema_version: 1, enforced: BASE_KEYS }));
  passed(f.invoke(['--ratchet', 'inputs/base.json'], f.elsewhere));
  f.graph(JOB_REF); passed(f.invoke(['--ratchet', 'inputs/base.json']));
  f.file('specs/graph/added.md', requirement('REQ-NEW', TEST_REF));
  f.baseline([...BASE_KEYS, 'specs/graph/added.md#REQ-NEW'].sort());
  passed(f.invoke(['--ratchet', 'inputs/base.json']), { reqs: 3, mechanical: 3 });
}));
group('ratchet refuses enforced downgrades, deletion and rename even with edited current baseline', [
  'UNENFORCED', 'PROCESS', 'delete', 'rename',
], (f, action) => {
  f.file('inputs/base.json', JSON.stringify({ schema_version: 1, enforced: BASE_KEYS }));
  if (action === 'delete') f.file(GRAPH, requirement('REQ-REPLACEMENT', 'UNENFORCED'));
  else if (action === 'rename') f.file(GRAPH, requirement('REQ-RENAMED', TEST_REF));
  else f.graph(action);
  f.baseline(action === 'rename' ? [TKEY, GRAPH + '#REQ-RENAMED'].sort() : [TKEY]);
  refused(f.invoke(['--ratchet', 'inputs/base.json']), 'ratchet');
});
group('ratchet does not invent a base for missing, corrupt, redirected or outside inputs', [
  'missing', 'corrupt', 'symlink', 'outside',
], (f, kind) => {
  let selected = 'inputs/base.json';
  if (kind === 'corrupt') f.file(selected, '{' + PRIVATE);
  if (kind === 'symlink' || kind === 'outside') {
    const target = path.join(f.outer, 'outside-base.json'); writeFileSync(target, JSON.stringify({ schema_version: 1, enforced: BASE_KEYS }));
    if (kind === 'outside') selected = target;
    else { mkdirSync(path.join(f.root, 'inputs')); symlinkSync(target, path.join(f.root, selected)); }
  }
  refused(f.invoke(['--ratchet', selected]), kind === 'corrupt' ? 'structure' : 'input');
});

group('selected input failures are private and occur before source can be used', [
  ['scope missing', 'specs/graph', 'missing'], ['scope directory redirect', 'specs/graph', 'parent-link'],
  ['spec leaf redirect', GRAPH, 'link'], ['spec hardlink', GRAPH, 'hardlink'],
  ['settings missing when cited', SETTINGS, 'missing'], ['settings nonregular', SETTINGS, 'directory'],
  ['workflow invalid UTF8', WORKFLOW, 'utf8'], ['baseline invalid UTF8', BASELINE, 'utf8'],
  ['baseline hardlink', BASELINE, 'hardlink'],
], (f, [name, relative, kind]) => {
  if (relative === SETTINGS) {
    const w = f.wrappers[0]; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`);
  }
  const target = path.join(f.root, relative);
  if (kind === 'missing') rmSync(target, { recursive: true });
  if (kind === 'directory') { rmSync(target); mkdirSync(target); }
  if (kind === 'utf8') writeFileSync(target, Buffer.from([0xc3, 0x28]));
  if (kind === 'hardlink') { linkSync(target, path.join(f.outer, 'owned-link')); assert.equal(lstatSync(target).nlink, 2); }
  if (kind === 'link' || kind === 'parent-link') {
    const owned = path.join(f.outer, 'owned-redirect'); renameSync(target, owned); symlinkSync(owned, target);
  }
  refused(f.invoke(), 'input');
});
test('settings are not selected when no hook reference is present', () => withFixture(f => {
  f.file(SETTINGS, '{' + PRIVATE); passed(f.invoke());
}));
test('workflow is not selected when no job reference is present', () => withFixture(f => {
  f.file('docs/SECURITY.md', table('PROCESS')); f.baseline([GKEY]);
  f.file(WORKFLOW, '[' + PRIVATE); passed(f.invoke(), { mechanical: 1, process: 2 });
}));
group('referenced target redirects and links do not borrow outside authority', ['test-link', 'test-parent', 'hook-hardlink'], (f, kind) => {
  let relative = TEST;
  if (kind === 'hook-hardlink') {
    const w = f.wrappers[2]; relative = w.hook; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`);
    linkSync(path.join(f.root, relative), path.join(f.outer, 'owned-link'));
  } else {
    if (kind === 'test-parent') relative = 'tests/owned';
    const target = path.join(f.root, relative), owned = path.join(f.outer, 'owned-target');
    renameSync(target, owned); symlinkSync(owned, target);
  }
  refused(f.invoke(), 'reference');
});
group('malformed selected JSON refuses without parser excerpts', [BASELINE, SETTINGS], (f, relative) => {
  if (relative === SETTINGS) { const w = f.wrappers[0]; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`); }
  f.file(relative, '{' + PRIVATE); refused(f.invoke(), 'structure');
});

test('each selected input byte cap is inclusive and one byte over refuses', () => {
  for (const [relative, cap] of [[GRAPH, 262144], [WORKFLOW, 262144], [SETTINGS, 262144], [BASELINE, 1048576]]) withFixture(f => {
    if (relative === SETTINGS) { const w = f.wrappers[0]; f.graph(`hook:${w.event}:${w.matcher}:${w.hook}`); }
    const target = path.join(f.root, relative), original = readFileSync(target);
    const bytes = Buffer.concat([original, Buffer.alloc(cap - original.length, 0x20)]);
    assert.equal(bytes.length, cap, 'inclusive fixture uses actual bytes');
    writeFileSync(target, bytes); passed(f.invoke());
    writeFileSync(target, Buffer.concat([bytes, Buffer.from(' ')])); refused(f.invoke(), 'input');
  });
});
test('the scoped file count accepts512 and refuses513 without losing requirement selection', () => withFixture(f => {
  for (let i = 0; i < 510; i++) f.file(`specs/graph/count/file${i}.md`, '# Auxiliary source\n');
  passed(f.invoke()); f.file('specs/graph/count/over.md', '# Auxiliary source\n'); refused(f.invoke(), 'input');
}));
test('the requirement count accepts8192 and refuses8193 under each per-file byte cap', () => withFixture(f => {
  const batches = new Map();
  for (let i = 0; i < 8190; i++) {
    const relative = `specs/graph/count/part${Math.floor(i / 256)}.md`;
    batches.set(relative, (batches.get(relative) ?? '') + requirement(`REQ-C${i}`, 'UNENFORCED'));
  }
  for (const [relative, text] of batches) { assert.ok(Buffer.byteLength(text) < 262144); f.file(relative, text); }
  passed(f.invoke(), { reqs: 8192, unenforced: 8192 });
  f.file('specs/graph/count/over.md', requirement('REQ-OVER', 'UNENFORCED')); refused(f.invoke(), 'input');
}));
test('scope directory depth16 is inclusive while depth17 refuses', () => withFixture(f => {
  const base = 'specs/graph/' + Array.from({ length: 16 }, (_, i) => `d${i}`).join('/');
  const selected = base + '/owned.md';
  f.file(selected, readFileSync(path.join(f.root, GRAPH))); rmSync(path.join(f.root, GRAPH));
  f.baseline([TKEY, selected + '#REQ-G1'].sort()); passed(f.invoke());
  const deeper = base + '/over/owned.md';
  f.file(deeper, readFileSync(path.join(f.root, selected))); rmSync(path.join(f.root, selected));
  f.baseline([TKEY, deeper + '#REQ-G1'].sort()); refused(f.invoke(), 'input');
}));
test('32 distinct references count once and33 refuse', () => withFixture(f => {
  const refs = [];
  for (let i = 0; i < 33; i++) {
    const relative = `tests/owned/ref${i}.test.mjs`; f.file(relative, 'throw new Error(' + JSON.stringify(PRIVATE) + ');\n'); refs.push('test:' + relative);
  }
  f.graph(refs.slice(0, 32).join('; ')); passed(f.invoke());
  f.graph(refs.join('; ')); refused(f.invoke(), 'input');
}));
test('1024-character reference limit accepts at the boundary without an oversized filesystem component', () => withFixture(f => {
  const prefix = 'tests/' + ('a'.repeat(180) + '/').repeat(5);
  const tail = 'x'.repeat(1024 - 'test:'.length - prefix.length - '.test.mjs'.length) + '.test.mjs';
  const relative = prefix + tail, reference = 'test:' + relative;
  assert.equal(reference.length, 1024); assert.ok(relative.split('/').every(part => part.length <= 255));
  f.file(relative, '# ' + PRIVATE); f.graph(reference); passed(f.invoke());
  const longer = prefix + 'x' + tail; f.file(longer, '# ' + PRIVATE); f.graph('test:' + longer); refused(f.invoke(), 'input');
}));
