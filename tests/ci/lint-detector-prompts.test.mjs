// specs/security/detector-source-lint.md REQ-1..7 / AC-1..8.
// CLI-only owned fixtures: the Workflow is source data, never an executable test harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CHECKER = path.join(ROOT, 'scripts/lint-detector-prompts.mjs');
const WORKFLOW = path.join(ROOT, '.claude/workflows/sprint-cycle.js');
const IGNORE = path.join(ROOT, '.gitleaksignore');
const SENTINEL = 'MR25_PRIVATE_INPUT_SENTINEL';
const ROLES = ['reviewer', 'security', 'validator'];
const PHRASES = ['already fixed', 'do not re-report', 'known issue'];
const fingerprint = (file = 'owned/example.txt', rule = 'fixture-rule', line = '1', sha = 'a'.repeat(40)) => `${sha}:${file}:${rule}:${line}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function feature() {
  assert.ok(existsSync(CHECKER), 'FEATURE_ABSENT: scripts/lint-detector-prompts.mjs is not implemented');
}
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, 'owned source mutation must have exactly one target');
  return source.replace(from, to);
}
function rolePrompt(source, role, transform) {
  const startText = '`You are acting as the ' + `'${role}' role`;
  const endText = '`,\n  {\n    label: ' + `'${role}',`;
  assert.equal(source.split(startText).length - 1, 1, 'original role prompt prerequisite');
  const start = source.indexOf(startText); const end = source.indexOf(endText, start);
  assert.ok(end > start, 'original prompt/options boundary prerequisite');
  return source.slice(0, start) + transform(source.slice(start, end + 1)) + source.slice(end + 1);
}
function inject(source, role, rawLiteral) {
  return rolePrompt(source, role, prompt => prompt.slice(0, 1) + rawLiteral + '\n' + prompt.slice(1));
}
function tree(root) {
  return readdirSync(root).sort().flatMap(name => {
    const file = path.join(root, name); const stat = lstatSync(file);
    const identity = [stat.mode, stat.ino, stat.nlink];
    if (stat.isDirectory()) return [[file, 'directory', identity], ...tree(file)];
    return [[file, identity, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : hash(readFileSync(file))]];
  });
}
function withFixture(run) {
  feature();
  const parser = path.join(ROOT, 'node_modules/acorn/package.json');
  assert.ok(existsSync(parser), 'fixture prerequisite: locked Acorn must be installed');
  assert.equal(JSON.parse(readFileSync(parser, 'utf8')).version, '8.18.0', 'fixture parser pin');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'detector-lint-')));
  try {
    const root = path.join(outer, 'project'); const cwd = path.join(outer, 'different-cwd');
    const script = path.join(root, 'scripts/lint-detector-prompts.mjs');
    const workflow = path.join(root, '.claude/workflows/sprint-cycle.js'); const ignore = path.join(root, '.gitleaksignore');
    const sentinel = path.join(root, 'source-was-executed');
    for (const dir of [path.dirname(script), path.dirname(workflow), cwd]) mkdirSync(dir, { recursive: true });
    copyFileSync(CHECKER, script); copyFileSync(WORKFLOW, workflow); copyFileSync(IGNORE, ignore);
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const originalWorkflow = readFileSync(workflow, 'utf8'); const originalIgnore = readFileSync(ignore, 'utf8');
    assert.equal(originalIgnore.split(/\r?\n/).filter(line => line && !line.trimStart().startsWith('#')).length, 7, 'original seven fingerprints prerequisite');
    run({ root, outer, cwd, workflow, ignore, sentinel, originalWorkflow, originalIgnore,
      source(transform) { writeFileSync(workflow, transform(readFileSync(workflow, 'utf8'))); },
      invoke(args = [], launchCwd = root) {
        const before = tree(outer);
        const result = spawnSync(process.execPath, [script, ...args], {
          cwd: launchCwd, env: { PATH: '', HOME: root, LANG: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
        });
        assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
        assert.deepEqual(tree(outer), before, 'lint must not mutate its owned input tree');
        assert.equal(existsSync(sentinel), false, 'Workflow source must not execute');
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /, 'loader/crash is not a lint refusal');
        assert.equal(output.includes(SENTINEL), false, 'private input must not enter diagnostics');
        assert.equal(output.includes('\u001b'), false); assert.doesNotMatch(output, /^::/m);
        return { ...result, output };
      },
    });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function passed(result, count = 7) {
  assert.equal(result.status, 0, result.output); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^detector-lint: /);
  assert.match(result.stdout, /(?:\b3 (?:selected )?templates\b|\btemplates[:=] ?3\b)/);
  assert.match(result.stdout, new RegExp(`(?:\\b${count} fingerprints\\b|\\bfingerprints[:=] ?${count}\\b)`));
}
function refused(result, category) {
  assert.equal(result.status, 1, result.output);
  assert.equal(result.stdout, '', 'refusal must not emit a success summary');
  assert.match(result.stderr, new RegExp(`^detector-lint: ${category}(?:[ :].*)?\\n$`));
}

test('original three Workflow prompts and seven full fingerprints pass from either owned CWD', () => withFixture(f => {
  passed(f.invoke()); passed(f.invoke([], f.cwd));
  assert.equal(readFileSync(f.workflow, 'utf8'), f.originalWorkflow);
  assert.equal(readFileSync(f.ignore, 'utf8'), f.originalIgnore);
}));
for (const role of ROLES) for (const phrase of PHRASES) test(`${role} literal refuses ${phrase}`, () => withFixture(f => {
  f.source(source => inject(source, role, phrase + ': ' + SENTINEL)); refused(f.invoke(), 'phrase');
}));
for (const [name, raw] of [
  ['ASCII case', 'KnOwN IsSuE'], ['ASCII whitespace', 'do\t\nnot\fre-report'], ['cooked JavaScript escapes', 'already\\x20fix\\u0065d'],
]) test(`phrase normalization covers ${name}`, () => withFixture(f => {
  f.source(source => inject(source, 'security', raw)); refused(f.invoke(), 'phrase');
}));
test('ENVIRONMENT_RULES shared literal is inspected', () => withFixture(f => {
  f.source(source => replaceOnce(source, 'const ENVIRONMENT_RULES = `', 'const ENVIRONMENT_RULES = `known issue '));
  refused(f.invoke(), 'phrase');
}));
test('ownerDecisionsBlock shared literal is inspected without evaluating acknowledgements', () => withFixture(f => {
  f.source(source => replaceOnce(source, 'OWNER DECISIONS (acknowledged AMBIGUITY_BLOCK items)', 'already fixed ' + SENTINEL));
  refused(f.invoke(), 'phrase');
}));
test('nested literal inside an interpolation is inspected', () => withFixture(f => {
  f.source(source => inject(source, 'validator', '${({ note: "known issue" }).note}'));
  refused(f.invoke(), 'phrase');
}));
test('comments, unrelated role text and unreferenced constants are outside the finite literal scope', () => withFixture(f => {
  f.source(source => '/* known issue; already fixed; do not re-report */\nconst unrelatedText = "known issue";\n' +
    replaceOnce(source, '`You are the preflight role.', '`known issue: You are the preflight role.'));
  passed(f.invoke());
}));
test('nested syntax, escaped backticks and ordinary regex literals remain parser controls', () => withFixture(f => {
  f.source(source => 'const syntaxControl = /`[{}]/g;\n' + inject(source, 'reviewer', 'quoted \\`tick\\` ${({ a: [1, { b: "neutral" }] }).a.length}'));
  passed(f.invoke());
}));
test('ordinary string label keys remain supported', () => withFixture(f => {
  f.source(source => replaceOnce(source, "label: 'security',", "'label': 'security',")); passed(f.invoke());
}));
test('valid source containing a top-level file-write and throw stays inert', () => withFixture(f => {
  f.source(source => `import { writeFileSync as ownedWrite } from 'node:fs';\nownedWrite(${JSON.stringify(f.sentinel)}, ${JSON.stringify(SENTINEL)});\nthrow new Error(${JSON.stringify(SENTINEL)});\n` + source);
  passed(f.invoke());
}));

for (const [name, change] of [
  ['missing role', source => replaceOnce(source, "label: 'security',", "label: 'unselected',")],
  ['duplicate role', source => source + '\nawait workflowAgent(`neutral ${ENVIRONMENT_RULES}${ownerDecisionsBlock}`, { label: "security" });\n'],
  ['non-template prompt', source => rolePrompt(source, 'security', () => '"neutral"')],
  ['duplicate label', source => replaceOnce(source, "label: 'security',", "label: 'security', label: 'security',")],
  ['spread options', source => replaceOnce(source, "label: 'security',", "label: 'security', ...{},")],
  ['computed label', source => replaceOnce(source, "label: 'security',", "['label']: 'security',")],
  ['getter label', source => replaceOnce(source, "label: 'security',", "get label() { return 'security'; },")],
  ['missing shared declaration', source => replaceOnce(source, 'const ENVIRONMENT_RULES =', 'const renamedEnvironment =')],
  ['duplicate shared declaration in valid nested scope', source => source + '\n{ const ENVIRONMENT_RULES = `neutral`; }\n'],
  ['shared declaration without initializer', source => {
    const declaration = source.split('\n').find(line => line.startsWith('const ENVIRONMENT_RULES = '));
    assert.ok(declaration); return replaceOnce(source, declaration, 'let ENVIRONMENT_RULES;');
  }],
  ['missing direct shared interpolation', source => rolePrompt(source, 'security', prompt => replaceOnce(prompt, '${ENVIRONMENT_RULES}', '${({ ENVIRONMENT_RULES: "neutral" }).ENVIRONMENT_RULES}'))],
  ['unavailable cooked nested tagged quasi', source => inject(source, 'security', '${tag`\\unicode`}')],
]) test(`source structure refuses ${name}`, () => withFixture(f => { f.source(change); refused(f.invoke(), 'structure'); }));
test('invalid JavaScript refuses privately as parse rather than structure', () => withFixture(f => {
  f.source(source => source + '\nconst = "' + SENTINEL + '";\n'); refused(f.invoke(), 'parse');
}));

for (const [name, content, count] of [
  ['blank/comment lines', '\n  # ' + SENTINEL + '\n', 0], ['empty input', '', 0],
  ['synthetic complete fingerprint without Git lookup', fingerprint(), 1],
  ['largest safe positive line', fingerprint('owned/example.txt', 'fixture-rule', '9007199254740991') + '\n', 1],
  ['duplicate complete fingerprints', fingerprint() + '\n' + fingerprint() + '\n', 2],
]) test(`ignore accepts ${name}`, () => withFixture(f => { writeFileSync(f.ignore, content); passed(f.invoke(), count); }));
test('original fingerprints accept CRLF with extra blank/comment lines', () => withFixture(f => {
  writeFileSync(f.ignore, (f.originalIgnore + '\n # ' + SENTINEL + '\n').replaceAll('\n', '\r\n')); passed(f.invoke());
}));
for (const [group, entries] of [
  ['full fingerprint fields', ['*.test.ts', 'owned/example.txt', fingerprint('owned/example.txt', 'fixture-rule', '1', 'a'.repeat(39)), fingerprint('owned/example.txt', 'fixture-rule', '1', 'A'.repeat(40)), 'a'.repeat(40) + ':owned/example.txt:rule', fingerprint('owned/example.txt', '')]],
  ['normalized literal file path', ['../owned.txt', '/owned.txt', 'owned//file.txt', 'owned/./file.txt', 'owned/../file.txt', 'owned\\file.txt', 'owned/*.test.ts', 'owned/[ab].txt', 'owned/file?.txt', 'owned:' + SENTINEL].map(file => fingerprint(file))],
  ['canonical positive safe line', ['0', '-1', '01', '+1', '1.5', '9007199254740992', SENTINEL].map(line => fingerprint('owned/example.txt', 'fixture-rule', line))],
  ['rule and entry boundaries', [fingerprint('owned/example.txt', 'rule.dot'), ' ' + fingerprint(), fingerprint() + '\t', ' \t', fingerprint('owned/\u001b[31m.txt')]],
]) test(`ignore refuses ${group} without input disclosure`, () => {
  for (const entry of entries) withFixture(f => { writeFileSync(f.ignore, entry + '\n'); refused(f.invoke(), 'fingerprint'); });
});

for (const [kind, cap] of [['workflow', 262144], ['ignore', 65536]]) {
  test(`${kind} inclusive byte cap accepts complete valid input`, () => withFixture(f => {
    const original = readFileSync(f[kind]); const prefix = kind === 'workflow' ? '\n//' : '\n#';
    const padded = Buffer.concat([original, Buffer.from(prefix), Buffer.alloc(cap - original.length - Buffer.byteLength(prefix), 0x78)]);
    assert.equal(padded.length, cap); writeFileSync(f[kind], padded); passed(f.invoke());
  }));
  for (const [name, change] of [
    ['missing input', (f, file) => rmSync(file)],
    ['directory input', (f, file) => { rmSync(file); mkdirSync(file); }],
    ['invalid UTF-8', (f, file) => writeFileSync(file, Buffer.from([0xc3, 0x28]))],
    ['one byte above cap', (f, file) => writeFileSync(file, Buffer.alloc(cap + 1, 0x78))],
    ['leaf symlink', (f, file) => { const target = path.join(f.outer, kind + '-target'); renameSync(file, target); symlinkSync(target, file); }],
    ['shared hardlink', (f, file) => { linkSync(file, path.join(f.outer, kind + '-hardlink')); assert.equal(lstatSync(file).nlink, 2); }],
  ]) test(`${kind} refuses ${name}`, () => withFixture(f => { change(f, f[kind]); refused(f.invoke(), 'input'); }));
}
test('workflow parent-directory symlink refuses owned redirect', () => withFixture(f => {
  const parent = path.join(f.root, '.claude'); const target = path.join(f.outer, 'owned-claude');
  renameSync(parent, target); symlinkSync(target, parent); refused(f.invoke(), 'input');
}));
test('extra arguments refuse without exposing argument values', () => withFixture(f => refused(f.invoke([SENTINEL]), 'usage')));
test('required validate CI runs the exact local lint after locked dependency installation', () => {
  feature();
  const doc = parseDocument(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(doc.errors, [], 'CI YAML prerequisite');
  const steps = doc.toJS().jobs.validate.steps;
  const matches = steps.filter(step => typeof step.run === 'string' && step.run.trim() === 'node scripts/lint-detector-prompts.mjs');
  assert.equal(matches.length, 1, 'exact required detector lint invocation must exist once');
  const step = matches[0]; const install = steps.findIndex(item => item.run?.trim() === 'npm ci');
  assert.ok(install >= 0 && steps.indexOf(step) > install);
  assert.equal(step.if, undefined); assert.equal(step['continue-on-error'], undefined);
  assert.equal(step['working-directory'], undefined);
});
