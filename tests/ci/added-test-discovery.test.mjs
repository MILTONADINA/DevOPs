// specs/ops/ci-added-test-discovery.md: real CI shell, owned Git and unchanged checkers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');
const STEP = 'Test floors only rise (or fall by a declared lowering); added test files assert (masterpiece REQ-M23)';
const GIT = '/usr/bin/git';
const FLOOR = 'governance/test-floors.json';
const SCRIPTS = ['scripts/check-test-floor.mjs', 'scripts/check-assertions.mjs'];
const GOOD = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
const BAD = '// owned assertion-free source; it is never executed\n';
const PARTIAL = 'tests/owned-partial.test.mjs';
const DIFF = ['diff', '--name-only', '--diff-filter=A', 'FETCH_HEAD', 'HEAD', '--', ':(glob)tests/**/*.test.mjs', ':(glob)runtime/test/**/*.test.ts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function selectedStep() {
  const doc = parseDocument(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(doc.errors, [], 'workflow YAML prerequisite');
  const selected = doc.toJS().jobs.validate.steps.filter(step => step.name === STEP);
  assert.equal(selected.length, 1, 'existing exact named CI step prerequisite');
  const step = selected[0]; assert.equal(step.shell, 'bash');
  assert.equal(step.if, "github.event_name == 'pull_request'");
  assert.deepEqual(step.env, { BASE_REF: '${{ github.base_ref }}' });
  assert.equal(step['continue-on-error'], undefined); assert.equal(step['working-directory'], undefined);
  assert.equal(typeof step.run, 'string'); assert.doesNotMatch(step.run, /\$\{\{/);
  return step;
}
function snapshot(directory, omit) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (omit.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory', stat.mode], ...snapshot(file, omit)];
    return [[file, stat.mode, stat.nlink, stat.isSymbolicLink() ? readlinkSync(file) : hash(readFileSync(file))]];
  });
}
function withFixture(options, check) {
  const step = selectedStep(), originalWorkflow = readFileSync(WORKFLOW);
  assert.ok(existsSync('/bin/bash') && existsSync(GIT), 'trusted Linux Bash and Git prerequisite');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'ci-added-tests-')));
  const cwd = path.join(outer, 'repo'), bin = path.join(outer, 'bin'), scratch = path.join(outer, 'scratch'), log = path.join(outer, 'calls.jsonl');
  try {
    for (const directory of [cwd, bin, scratch, path.join(cwd, 'scripts')]) mkdirSync(directory, { recursive: true });
    const env = { PATH: '/usr/bin:/bin', HOME: cwd, XDG_CONFIG_HOME: cwd, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
    function git(args) {
      const r = spawnSync(GIT, args, { cwd, env, encoding: 'buffer', timeout: 10000, maxBuffer: 1048576 });
      assert.equal(r.error, undefined, 'owned Git setup prerequisite'); assert.equal(r.signal, null);
      assert.equal(r.status, 0, 'owned Git setup prerequisite'); return r.stdout;
    }
    function put(name, bytes) { const file = path.join(cwd, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); }
    git(['init', '--initial-branch=fixture-base', '--template=']);
    assert.equal(git(['rev-parse', '--show-toplevel']).toString().trim(), cwd, 'no borrowed ancestor Git metadata');
    for (const [key, value] of [['user.name', 'Added Test Fixture'], ['user.email', 'added-test@example.invalid'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) git(['config', '--local', key, value]);
    const floors = Buffer.from('{"root":10,"runtime":20}\n');
    put(FLOOR, floors); put('tests/existing.test.mjs', GOOD);
    git(['add', '--', FLOOR, 'tests/existing.test.mjs']); git(['commit', '-m', 'owned base']);
    git(['remote', 'add', 'origin', cwd]); git(['fetch', '--no-tags', 'origin', 'fixture-base']);
    assert.equal(git(['remote', 'get-url', 'origin']).toString().trim(), cwd);
    git(['checkout', '-b', 'fixture-head']);
    const changes = options.files ?? {};
    for (const [name, bytes] of Object.entries(changes)) put(name, bytes);
    if (Object.keys(changes).length) { git(['add', '--', ...Object.keys(changes)]); git(['commit', '-m', 'owned head changes']); }
    for (const file of SCRIPTS) put(file, readFileSync(path.join(ROOT, file)));
    const expectedFiles = options.selected ?? [];
    // The successful route uses real Git; this also preconditions the injected partial-path case.
    const actualList = git(DIFF);
    assert.deepEqual(actualList, Buffer.from(expectedFiles.map(file => file + '\n').join('')), 'real owned diff selected exactly the intended paths');
    if (options.failure === 'partial') assert.equal(readFileSync(path.join(cwd, PARTIAL), 'utf8'), GOOD);
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n'); writeFileSync(log, '');
    const fetchArgs = ['fetch', '--no-tags', 'origin', 'fixture-base'], showArgs = ['show', 'FETCH_HEAD:' + FLOOR];
    const floorArgs = ['scripts/check-test-floor.mjs', '--ratchet', path.join(scratch, 'base-floors.json')];
    const assertionArgs = ['scripts/check-assertions.mjs', ...expectedFiles];
    const common = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);\n` +
      `if(process.cwd()!==${JSON.stringify(cwd)}){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n`;
    const gitWrapper = common +
      `const allowed=${JSON.stringify([fetchArgs, showArgs, DIFF])};const equal=x=>JSON.stringify(args)===JSON.stringify(x);\n` +
      `if(!allowed.some(equal)){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n` +
      `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'git',args})+'\\n');\n` +
      `if(equal(${JSON.stringify(DIFF)})&&${Boolean(options.failure)}){fs.writeSync(1,${JSON.stringify(options.failure === 'partial' ? PARTIAL + '\n' : '')});process.exit(49);}\n` +
      `const r=cp.spawnSync(${JSON.stringify(GIT)},args,{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(env)},encoding:'buffer',timeout:10000,maxBuffer:1048576});\n` +
      `if(r.error||r.signal){fs.writeSync(2,'FIXTURE_CHILD_FAILED\\n');process.exit(83);}fs.writeSync(1,r.stdout);fs.writeSync(2,r.stderr);process.exit(r.status);\n`;
    const nodeWrapper = common +
      `if(!${JSON.stringify([floorArgs, assertionArgs])}.some(x=>JSON.stringify(args)===JSON.stringify(x))){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n` +
      `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'node',args})+'\\n');\n` +
      `const r=cp.spawnSync(${JSON.stringify(process.execPath)},args,{cwd:${JSON.stringify(cwd)},env:{PATH:'',HOME:${JSON.stringify(cwd)},LANG:'C',LC_ALL:'C'},encoding:'buffer',timeout:10000,maxBuffer:1048576});\n` +
      `if(r.error||r.signal){fs.writeSync(2,'FIXTURE_CHILD_FAILED\\n');process.exit(83);}fs.writeSync(1,r.stdout);fs.writeSync(2,r.stderr);process.exit(r.status);\n`;
    for (const [name, source] of [['git', gitWrapper], ['node', nodeWrapper]]) { writeFileSync(path.join(bin, name), source); chmodSync(path.join(bin, name), 0o755); }
    const omit = [scratch, log, path.join(cwd, '.git/FETCH_HEAD')], before = snapshot(outer, omit);
    const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd, env: { PATH: bin, HOME: cwd, BASE_REF: 'fixture-base', RUNNER_TEMP: scratch, LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 20000, maxBuffer: 1048576,
    });
    assert.equal(r.error, undefined, 'Bash fixture must terminate'); assert.equal(r.signal, null);
    assert.deepEqual(snapshot(outer, omit), before, 'checkers/source/current metadata and non-fetch Git files are unchanged');
    assert.deepEqual(readFileSync(WORKFLOW), originalWorkflow, 'workflow is read-only');
    assert.deepEqual(readFileSync(path.join(scratch, 'base-floors.json')), floors, 'successful baseline acquisition remains exact');
    assert.doesNotMatch(r.stdout + r.stderr, /FIXTURE_ROUTE_REJECTED|FIXTURE_CHILD_FAILED|command not found|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|ReferenceError:/, 'fixture failures cannot witness a discovery refusal');
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const prefix = [{ tool: 'git', args: fetchArgs }, { tool: 'git', args: showArgs }, { tool: 'node', args: floorArgs }, { tool: 'git', args: DIFF }];
    assert.deepEqual(calls.slice(0, 4), prefix, 'a real successful floor comparison precedes attempted discovery');
    assert.match(r.stdout, /test floors: no floor lowered/);
    const list = path.join(scratch, 'added-tests.txt');
    // Do not make missing new tempfile the pre-fix failure oracle.
    if (existsSync(list)) assert.deepEqual(readFileSync(list), options.failure ? Buffer.from(options.failure === 'partial' ? PARTIAL + '\n' : '') : actualList);
    check({ ...r, calls, prefix, assertionArgs });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function consumed(r) { assert.deepEqual(r.calls, [...r.prefix, { tool: 'node', args: r.assertionArgs }]); }

test('added-test discovery retains existing PR Bash wiring and literal Git selection', () => {
  const step = selectedStep();
  assert.ok(step.run.includes('git fetch --no-tags origin "$BASE_REF"'));
  assert.ok(step.run.includes("git diff --name-only --diff-filter=A FETCH_HEAD HEAD -- ':(glob)tests/**/*.test.mjs' ':(glob)runtime/test/**/*.test.ts'"));
  assert.ok(step.run.includes('if [ "${#added[@]}" -gt 0 ]; then node scripts/check-assertions.mjs "${added[@]}"; else echo "check-assertions: no test files added"; fi'));
});
test('failed empty diff refuses before assertion checking or no-added success', () => withFixture({ failure: 'empty' }, r => {
  assert.notEqual(r.status, 0, 'failed diff must not pass as empty discovery');
  assert.deepEqual(r.calls, r.prefix); assert.doesNotMatch(r.stdout, /check-assertions:/);
}));
test('failed diff with a valid partial filename refuses before consuming it', () => withFixture({ failure: 'partial', files: { [PARTIAL]: GOOD }, selected: [PARTIAL] }, r => {
  assert.notEqual(r.status, 0, 'failed diff must not pass after checking partial output');
  assert.deepEqual(r.calls, r.prefix); assert.doesNotMatch(r.stdout, /check-assertions:/);
}));
test('successful empty discovery retains the exact empty-list success', () => withFixture({}, r => {
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.calls, r.prefix);
  assert.equal(r.stdout, 'test floors: no floor lowered\ncheck-assertions: no test files added\n');
}));
test('actual root runtime and spaced additions reach the unchanged checker while other paths and modifications do not', () => {
  const files = { [PARTIAL]: GOOD, 'runtime/test/owned-runtime.test.ts': GOOD, 'tests/space name.test.mjs': GOOD,
    'docs/unselected.test.mjs': BAD, 'tests/unselected.txt': BAD, 'runtime/test/unselected.test.mjs': BAD, 'tests/existing.test.mjs': BAD };
  const selected = ['runtime/test/owned-runtime.test.ts', PARTIAL, 'tests/space name.test.mjs'];
  withFixture({ files, selected }, r => {
    assert.equal(r.status, 0, r.stderr); consumed(r);
    assert.match(r.stdout, /check-assertions: 3 file\(s\) checked, 0 without assertions/);
    assert.doesNotMatch(r.stdout, /no test files added/);
  });
});
test('selected assertion-free addition still fails through the actual checker', () => withFixture({ files: { [PARTIAL]: BAD }, selected: [PARTIAL] }, r => {
  assert.equal(r.status, 1); consumed(r);
  assert.match(r.stdout, /check-assertions: 1 file\(s\) checked, 1 without assertions/);
  assert.match(r.stderr, /owned-partial\.test\.mjs has no assert\(\.\.\.\) or expect\(\.\.\.\) call/);
}));
