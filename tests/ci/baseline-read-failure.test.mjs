// specs/ops/ci-baseline-read-failures.md: actual CI Bash and existing ratchet checkers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');
const GIT = '/usr/bin/git';
const STEPS = [
  { key: 'floors', name: 'Test floors only rise (or fall by a declared lowering); added test files assert (masterpiece REQ-M23)',
    member: 'governance/test-floors.json', output: 'base-floors.json', checker: 'scripts/check-test-floor.mjs', base: { root: 10, runtime: 20 } },
  { key: 'status', name: 'Spec-status baseline only shrinks (quality plan MR-11(A))',
    member: 'governance/traceability-baseline.json', output: 'base-traceability.json', checker: 'scripts/lint-spec-status.mjs', base: { spec_status: ['specs/owned-a.md', 'specs/owned-b.md'] } },
];
const FILES = ['scripts/check-test-floor.mjs', 'scripts/lint-spec-status.mjs', 'scripts/check-assertions.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');

function stepFor(selected) {
  const document = parseDocument(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(document.errors, [], 'existing workflow YAML prerequisite');
  const matches = document.toJS().jobs.validate.steps.filter(step => step.name === selected.name);
  assert.equal(matches.length, 1, 'existing named CI ratchet step prerequisite');
  const step = matches[0];
  assert.equal(step.shell, 'bash'); assert.equal(step.if, "github.event_name == 'pull_request'");
  assert.deepEqual(step.env, { BASE_REF: '${{ github.base_ref }}' });
  assert.equal(step['continue-on-error'], undefined); assert.equal(step['working-directory'], undefined);
  assert.equal(typeof step.run, 'string'); assert.doesNotMatch(step.run, /\$\{\{/);
  return step;
}

function snapshot(directory, omit = []) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (omit.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory', stat.mode], ...snapshot(file, omit)];
    return [[file, stat.mode, stat.nlink, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : hash(readFileSync(file))]];
  });
}

function withFixture(selected, options, check) {
  const step = stepFor(selected), workflowBefore = readFileSync(WORKFLOW);
  assert.ok(existsSync('/bin/bash') && existsSync(GIT), 'trusted Linux Bash/Git prerequisites');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'ci-baseline-')));
  const cwd = path.join(outer, 'repo'), bin = path.join(outer, 'bin'), scratch = path.join(outer, 'scratch'), log = path.join(outer, 'calls.jsonl');
  try {
    for (const directory of [cwd, bin, scratch, path.join(cwd, 'governance'), path.join(cwd, 'scripts')]) mkdirSync(directory, { recursive: true });
    const gitEnv = { PATH: '/usr/bin:/bin', HOME: cwd, XDG_CONFIG_HOME: cwd, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'file', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
    function git(args) {
      const result = spawnSync(GIT, args, { cwd, env: gitEnv, encoding: 'buffer', timeout: 10000, maxBuffer: 1048576 });
      assert.equal(result.error, undefined, 'owned Git setup prerequisite'); assert.equal(result.signal, null);
      assert.equal(result.status, 0, 'owned Git setup prerequisite'); return result.stdout.toString('utf8').trim();
    }
    git(['init', '--initial-branch=fixture-base', '--template=']);
    assert.equal(git(['rev-parse', '--show-toplevel']), cwd, 'fixture must own its Git metadata');
    for (const [key, value] of [['user.name', 'CI Baseline Fixture'], ['user.email', 'ci-baseline@example.invalid'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) git(['config', '--local', key, value]);
    writeFileSync(path.join(cwd, 'owned.txt'), 'synthetic baseline source\n');
    git(['add', '--', 'owned.txt']);
    const baseBytes = json(options.base ?? selected.base);
    if (!options.missing) { writeFileSync(path.join(cwd, selected.member), baseBytes); git(['add', '--', selected.member]); }
    git(['commit', '-m', 'owned baseline']);
    const base = git(['rev-parse', 'HEAD']); assert.match(base, /^[0-9a-f]{40}$/);
    if (options.missing) assert.equal(git(['ls-tree', '-z', base, '--', selected.member]), '', 'baseline really absent from owned commit');
    else assert.deepEqual(Buffer.from(git(['show', base + ':' + selected.member]) + '\n'), baseBytes);
    // Actual fetch is confined to this same owned repository; no network remote exists.
    git(['remote', 'add', 'origin', cwd]); git(['fetch', '--no-tags', 'origin', 'fixture-base']);
    assert.equal(git(['remote', 'get-url', 'origin']), cwd);
    git(['checkout', '-b', 'fixture-head']);
    const addedFile = 'tests/owned-added.test.mjs';
    if (options.added !== undefined) {
      mkdirSync(path.join(cwd, 'tests'));
      writeFileSync(path.join(cwd, addedFile), options.added);
      git(['add', '--', addedFile]); git(['commit', '-m', 'owned added test']);
    }
    for (const file of FILES) writeFileSync(path.join(cwd, file), readFileSync(path.join(ROOT, file)));
    writeFileSync(path.join(cwd, selected.member), json(options.current ?? selected.base));
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n'); writeFileSync(log, '');
    const showArgs = ['show', 'FETCH_HEAD:' + selected.member];
    const diffArgs = ['diff', '--name-only', '--diff-filter=A', 'FETCH_HEAD', 'HEAD', '--', ':(glob)tests/**/*.test.mjs', ':(glob)runtime/test/**/*.test.ts'];
    const fetchArgs = ['fetch', '--no-tags', 'origin', 'fixture-base'];
    const output = path.join(scratch, selected.output), checkerArgs = [selected.checker, '--ratchet', output];
    const assertionArgs = ['scripts/check-assertions.mjs', addedFile];
    const common = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);\n` +
      `if(process.cwd()!==${JSON.stringify(cwd)}){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n`;
    const gitStub = common +
      `const fetch=${JSON.stringify(fetchArgs)},show=${JSON.stringify(showArgs)},diff=${JSON.stringify(diffArgs)};const equal=x=>JSON.stringify(args)===JSON.stringify(x);\n` +
      `if(![fetch,show,diff].some(equal)){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n` +
      `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'git',args})+'\\n');\n` +
      `if(equal(fetch)&&${options.failure === 'fetch'})process.exit(47);\n` +
      `if(equal(show)&&${options.failure === 'show'}){fs.writeSync(1,'partial owned baseline');process.exit(48);}\n` +
      `const r=cp.spawnSync(${JSON.stringify(GIT)},args,{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(gitEnv)},encoding:'buffer',timeout:10000,maxBuffer:1048576});\n` +
      `if(r.error||r.signal){fs.writeSync(2,'FIXTURE_CHILD_FAILED\\n');process.exit(83);}fs.writeSync(1,r.stdout);fs.writeSync(2,r.stderr);process.exit(r.status);\n`;
    const nodeStub = common +
      `if(!${JSON.stringify(options.added === undefined ? [checkerArgs] : [checkerArgs, assertionArgs])}.some(value=>JSON.stringify(args)===JSON.stringify(value))){fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n` +
      `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'node',args})+'\\n');\n` +
      `const r=cp.spawnSync(${JSON.stringify(process.execPath)},args,{cwd:${JSON.stringify(cwd)},env:{PATH:'',HOME:${JSON.stringify(cwd)},LANG:'C',LC_ALL:'C'},encoding:'buffer',timeout:10000,maxBuffer:1048576});\n` +
      `if(r.error||r.signal){fs.writeSync(2,'FIXTURE_CHILD_FAILED\\n');process.exit(83);}fs.writeSync(1,r.stdout);fs.writeSync(2,r.stderr);process.exit(r.status);\n`;
    for (const [name, source] of [['git', gitStub], ['node', nodeStub]]) { writeFileSync(path.join(bin, name), source); chmodSync(path.join(bin, name), 0o755); }
    if (options.bootstrap) writeFileSync(output, '{}\n');
    const omit = [scratch, log, path.join(cwd, '.git/FETCH_HEAD')], before = snapshot(outer, omit);
    const invocation = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', options.bootstrap ? 'node "$CHECKER" --ratchet "$BASE_FILE"' : step.run], {
      cwd, env: { PATH: bin, HOME: cwd, RUNNER_TEMP: scratch, BASE_REF: 'fixture-base', CHECKER: selected.checker, BASE_FILE: output, LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 20000, maxBuffer: 1048576,
    });
    assert.equal(invocation.error, undefined, 'Bash fixture must reach its terminal status'); assert.equal(invocation.signal, null);
    assert.deepEqual(snapshot(outer, omit), before, 'baseline gate preserves source, current metadata and non-fetch Git files');
    assert.deepEqual(readFileSync(WORKFLOW), workflowBefore, 'workflow source is read-only');
    assert.doesNotMatch(invocation.stdout + invocation.stderr, /FIXTURE_ROUTE_REJECTED|FIXTURE_CHILD_FAILED|command not found|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|ReferenceError:/, 'fixture/loader failures are not valid refusals');
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    check({ ...invocation, calls, output, baseBytes, fetchArgs, showArgs, diffArgs, checkerArgs, assertionArgs });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

function terminalCalls(r, checker, diff = false, assertions = false) {
  const expected = [{ tool: 'git', args: r.fetchArgs }, { tool: 'git', args: r.showArgs }];
  if (checker) expected.push({ tool: 'node', args: r.checkerArgs });
  if (diff) expected.push({ tool: 'git', args: r.diffArgs });
  if (assertions) expected.push({ tool: 'node', args: r.assertionArgs });
  assert.deepEqual(r.calls, expected);
}

test('existing CI baseline steps retain PR-only Bash, exact source selection and caller policy', () => {
  for (const selected of STEPS) {
    const step = stepFor(selected);
    assert.ok(step.run.includes('git fetch --no-tags origin "$BASE_REF"'));
    assert.ok(step.run.includes(`git show FETCH_HEAD:${selected.member} > "$RUNNER_TEMP/${selected.output}" 2>/dev/null`));
    assert.ok(step.run.includes(`node ${selected.checker} --ratchet "$RUNNER_TEMP/${selected.output}"`));
  }
});
for (const selected of STEPS) {
  test(`${selected.key}: valid fetched baseline reaches the actual checker unchanged`, () => {
    const variants = selected.key === 'floors' ? [selected.base, { root: 11, runtime: 20 }] : [selected.base, { spec_status: ['specs/owned-a.md'] }];
    for (const current of variants) withFixture(selected, { current }, r => {
      assert.equal(r.status, 0, r.stderr); terminalCalls(r, true, selected.key === 'floors');
      assert.deepEqual(readFileSync(r.output), r.baseBytes);
      assert.match(r.stdout, selected.key === 'floors' ? /test floors: no floor lowered/ : /spec status: the baseline did not grow/);
    });
  });
  test(`${selected.key}: an actually missing committed baseline stops before any checker`, () => withFixture(selected, { missing: true }, r => {
    assert.notEqual(r.status, 0, 'failed baseline read must not be converted into an accepted empty base'); terminalCalls(r, false);
    assert.doesNotMatch(r.stdout, /no floor lowered|baseline did not grow|no test files added/);
  }));
  test(`${selected.key}: failed baseline read with partial bytes stops before any checker`, () => withFixture(selected, { failure: 'show' }, r => {
    assert.notEqual(r.status, 0, 'failed read must propagate before ratchet execution'); terminalCalls(r, false);
    assert.deepEqual(readFileSync(r.output), Buffer.from('partial owned baseline'), 'failure must not be replaced by synthetic empty JSON');
  }));
  test(`${selected.key}: fetch failure remains nonzero before baseline read or checker`, () => withFixture(selected, { failure: 'fetch' }, r => {
    assert.notEqual(r.status, 0); assert.deepEqual(r.calls, [{ tool: 'git', args: r.fetchArgs }]);
    assert.equal(existsSync(r.output), false);
  }));
  test(`${selected.key}: actual checker still rejects an unauthorized comparison`, () => {
    const current = selected.key === 'floors' ? { root: 9, runtime: 20 } : { spec_status: [...selected.base.spec_status, 'specs/new.md'] };
    withFixture(selected, { current }, r => {
      assert.notEqual(r.status, 0); terminalCalls(r, true);
      assert.match(r.stderr, selected.key === 'floors' ? /floors may only rise; lowered or removed: root 10 -> 9/ : /baseline grew: specs\/new\.md/);
      assert.deepEqual(readFileSync(r.output), r.baseBytes);
    });
  });
}
test('legitimate declared lowering and rename still pass the actual floor checker', () => {
  for (const options of [
    { current: { root: 9, runtime: 20, lowerings: [{ suite: 'root', from: 10, to: 9, reason: 'owned approved retirement', decision: 'owned fixture decision' }] }, message: /test floors: LOWERED root 10 -> 9:/ },
    { base: { root: 10, stratum: 20 }, current: { root: 10, runtime: 20, renames: [{ from: 'stratum', to: 'runtime', decision: 'owned fixture rename' }] }, message: /test floors: RENAMED stratum -> runtime:/ },
  ]) withFixture(STEPS[0], options, r => { assert.equal(r.status, 0, r.stderr); terminalCalls(r, true, true); assert.match(r.stdout, options.message); });
});
test('standalone explicit empty-base compatibility remains separate from failed CI admission', () => {
  for (const selected of STEPS) withFixture(selected, { bootstrap: true }, r => {
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.calls, [{ tool: 'node', args: r.checkerArgs }]);
    assert.deepEqual(readFileSync(r.output), Buffer.from('{}\n'));
    assert.match(r.stdout, selected.key === 'floors' ? /test floors: no floor lowered/ : /spec status: the baseline did not grow/);
  });
});
test('ordinary added-test branch runs the existing assertion checker and preserves its refusal', () => {
  for (const [added, status] of [["import assert from 'node:assert/strict';\nassert.equal(1, 1);\n", 0], ['// owned fixture without an assertion\n', 1]]) {
    withFixture(STEPS[0], { added }, r => {
      assert.equal(r.status, status, r.stderr); terminalCalls(r, true, true, true);
      assert.match(r.stdout, new RegExp(`check-assertions: 1 file\\(s\\) checked, ${status} without assertions`));
      assert.doesNotMatch(r.stdout, /no test files added/);
      if (status) assert.match(r.stderr, /owned-added\.test\.mjs has no assert\(\.\.\.\) or expect\(\.\.\.\) call/);
    });
  }
});
