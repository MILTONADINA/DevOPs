// specs/ops/ci-deepteam-discovery.md: real extracted filter, owned Git, no model/scanner execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/security-scan.yml');
const STEP = 'REQ-B1 path filter (agent-behavior PRs only; push-to-main bypasses)';
const GIT = '/usr/bin/git', GREP = '/usr/bin/grep';
const PATTERN = '^(skills/|hooks/|subagents/|constitution/|mcp-configs/|analyzer/|governance/owasp-asi-2026/)';
const PREFIXES = ['skills/', 'hooks/', 'subagents/', 'constitution/', 'mcp-configs/', 'analyzer/', 'governance/owasp-asi-2026/'];
const PRIOR_OUTPUT = 'fixture-existing=value\n';
const PRIVATE = 'SENSITIVE_SENTINEL';
const INERT = `Owned source data ${PRIVATE}; this file is neither imported nor executed.\n`;
const TRIGGER = 'REQ-B1 trigger: matched agent-behavior paths in PR diff\n';
const SKIP = 'REQ-B1 skip: docs-only / dep-bump / refactor PR (AC-B1.2)\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function selectedStep() {
  const original = readFileSync(WORKFLOW);
  const document = parseDocument(original.toString('utf8'));
  assert.deepEqual(document.errors, [], 'actual workflow YAML prerequisite');
  const workflow = document.toJS(), job = workflow.jobs.deepteam;
  const matches = job.steps.filter(step => step.id === 'path-filter' || step.name === STEP);
  assert.equal(matches.length, 1, 'existing unique filter prerequisite');
  const step = matches[0];
  assert.equal(step.id, 'path-filter'); assert.equal(step.name, STEP);
  assert.deepEqual(step.env, { BASE_SHA: '${{ github.event.pull_request.base.sha }}' });
  for (const key of ['if', 'shell', 'continue-on-error', 'working-directory']) assert.equal(step[key], undefined);
  assert.equal(typeof step.run, 'string'); assert.doesNotMatch(step.run, /\$\{\{/);
  return { workflow, job, step, original };
}
function snapshot(directory, omit) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (omit.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory', stat.mode], ...snapshot(file, omit)];
    return [[file, stat.mode, stat.nlink, stat.isSymbolicLink() ? readlinkSync(file) : digest(readFileSync(file))]];
  });
}
function withFixture(options, check) {
  const { step, original } = selectedStep();
  assert.ok(existsSync('/bin/bash') && existsSync(GIT) && existsSync(GREP), 'trusted Linux Bash/Git/grep prerequisite');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'ci-deepteam-discovery-')));
  const cwd = path.join(outer, 'repo'), bin = path.join(outer, 'bin');
  const output = path.join(outer, 'output.txt'), log = path.join(outer, 'calls.jsonl');
  try {
    mkdirSync(cwd); mkdirSync(bin);
    const gitEnv = { PATH: '/usr/bin:/bin', HOME: cwd, XDG_CONFIG_HOME: cwd, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: '',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
    function git(args) {
      const r = spawnSync(GIT, args, { cwd, env: gitEnv, encoding: 'buffer', timeout: 10000, maxBuffer: 1048576 });
      assert.equal(r.error, undefined, 'owned Git setup prerequisite'); assert.equal(r.signal, null);
      assert.equal(r.status, 0, 'owned Git setup prerequisite'); return r.stdout;
    }
    function put(name, bytes) {
      const file = path.join(cwd, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
    }
    git(['init', '--initial-branch=fixture', '--template=']);
    assert.equal(git(['rev-parse', '--show-toplevel']).toString().trim(), cwd, 'no borrowed ancestor Git metadata');
    for (const [key, value] of [['user.name', 'DeepTeam Discovery Fixture'], ['user.email', 'discovery@example.invalid'],
      ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) {
      git(['config', '--local', key, value]);
    }
    put('README.md', INERT); git(['add', '--', 'README.md']); git(['commit', '-m', 'owned base']);
    const base = git(['rev-parse', '--verify', 'HEAD']).toString().trim(); assert.match(base, /^[0-9a-f]{40}$/);
    const files = options.files ?? [];
    for (const file of files) put(file, INERT + 'owned changed line\n');
    if (files.length) { git(['add', '--', ...files]); git(['commit', '-m', 'owned changes']); }
    const actualDiff = git(['diff', '--name-only', base, 'HEAD']);
    assert.deepEqual(actualDiff, Buffer.from([...files].sort().map(file => file + '\n').join('')), 'genuine comparison exactly selects the owned paths');
    if (options.failure === 'partial') assert.ok(files.length === 1 && actualDiff.length > 0, 'partial path exists and is a real successful diff');
    assert.equal(git(['remote']).length, 0, 'fixture has no remote');
    const event = options.event ?? 'pull_request';
    const baseArg = options.failure === 'native' ? '0'.repeat(40) : base;
    const diffArgs = ['diff', '--name-only', baseArg, 'HEAD'];
    writeFileSync(log, ''); writeFileSync(output, PRIOR_OUTPUT);
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
    const injected = options.failure === 'empty' || options.failure === 'partial';
    const partial = options.failure === 'partial' ? actualDiff.toString() : '';
    const wrapper = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);\n` +
      `const log=${JSON.stringify(log)},expected=${JSON.stringify(diffArgs)};\n` +
      `if(process.cwd()!==${JSON.stringify(cwd)}||${event !== 'pull_request'}||JSON.stringify(args)!==JSON.stringify(expected)){fs.appendFileSync(log,JSON.stringify({args,status:82})+'\\n');fs.writeSync(2,'FIXTURE_ROUTE_REJECTED\\n');process.exit(82);}\n` +
      `if(${injected}){fs.appendFileSync(log,JSON.stringify({args,status:49})+'\\n');fs.writeSync(1,${JSON.stringify(partial)});process.exit(49);}\n` +
      `const r=cp.spawnSync(${JSON.stringify(GIT)},args,{cwd:${JSON.stringify(cwd)},env:${JSON.stringify(gitEnv)},encoding:'buffer',timeout:10000,maxBuffer:1048576});\n` +
      `if(r.error||r.signal){fs.writeSync(2,'FIXTURE_CHILD_FAILED\\n');process.exit(83);}\n` +
      `fs.appendFileSync(log,JSON.stringify({args,status:r.status})+'\\n');fs.writeSync(1,r.stdout);fs.writeSync(2,r.stderr);process.exit(r.status);\n`;
    writeFileSync(path.join(bin, 'git'), wrapper); chmodSync(path.join(bin, 'git'), 0o755);
    symlinkSync(GREP, path.join(bin, 'grep'));
    const omit = [output, log], before = snapshot(outer, omit);
    const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd, env: { PATH: bin, HOME: cwd, LANG: 'C', LC_ALL: 'C', BASE_SHA: baseArg, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
      encoding: 'utf8', timeout: 20000, maxBuffer: 1048576,
    });
    assert.equal(r.error, undefined, 'owned extracted Bash must terminate'); assert.equal(r.signal, null);
    assert.deepEqual(snapshot(outer, omit), before, 'fixture sources and all Git metadata remain unchanged');
    assert.deepEqual(readFileSync(WORKFLOW), original, 'workflow bytes remain unchanged');
    const published = readFileSync(output, 'utf8');
    assert.ok(!(r.stdout + r.stderr + published).includes(PRIVATE), 'inert private content is never disclosed');
    assert.doesNotMatch(r.stdout + r.stderr, /FIXTURE_ROUTE_REJECTED|FIXTURE_CHILD_FAILED|command not found|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|ReferenceError:/, 'fixture/tool errors cannot witness intended discovery failure');
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if (event !== 'pull_request') assert.deepEqual(calls, [], 'backstop must not attempt Git');
    else {
      assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, diffArgs, 'the exact required discovery was attempted');
      if (injected) assert.equal(calls[0].status, 49);
      else if (options.failure === 'native') {
        assert.notEqual(calls[0].status, 0, 'actual owned Git refused the unavailable base');
        assert.match(r.stderr, /fatal: .*0{40}/, 'native Git error reached the captured stderr');
      } else assert.equal(calls[0].status, 0, 'successful controls use successful actual Git');
    }
    check({ ...r, published, calls, event });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function refused(r) {
  assert.notEqual(r.status, 0, 'a failed discovery cannot produce a successful scheduling decision');
  assert.equal(r.published, PRIOR_OUTPUT, 'no decision is appended after failed discovery');
  assert.doesNotMatch(r.stdout, /REQ-B[12] (?:trigger|skip):/);
}
function passed(r, selected) {
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  assert.equal(r.published, PRIOR_OUTPUT + `should_run=${selected}\n`);
  assert.equal(r.stdout, r.event === 'pull_request' ? selected ? TRIGGER : SKIP : `REQ-B2 trigger: ${r.event} event\n`);
}

// Mutation: moving the selector, widening paths or changing downstream authority must fail this guard.
test('actual filter wiring and optional policy stay fixed (regression guard)', () => {
  const { workflow, job, step } = selectedStep();
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 20);
  assert.equal(job.steps[0].uses, 'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd');
  assert.deepEqual(job.steps[0].with, { 'fetch-depth': 0 });
  assert.ok(step.run.includes('set -euo pipefail'));
  assert.ok(step.run.includes('git diff --name-only "${BASE_SHA}" HEAD'));
  assert.ok(step.run.includes(`AGENT_PATTERN='${PATTERN}'`));
  for (const name of ['Setup Python', 'Install DeepTeam', 'Run DeepTeam OWASP_ASI_2026 red-team']) {
    const selected = job.steps.filter(item => item.name === name); assert.equal(selected.length, 1);
    assert.equal(selected[0].if, "steps.path-filter.outputs.should_run == 'true'");
  }
  const run = job.steps.find(item => item.id === 'redteam'); assert.equal(run.run, 'bash scripts/run-redteam.sh');
  assert.deepEqual(run.env, { DEEPTEAM_TELEMETRY_OPT_OUT: 'YES', DEEPEVAL_TELEMETRY_OPT_OUT: '1' });
  assert.equal(job.steps.find(item => item.name === 'Surface med/low findings on PR (REQ-B4 non-blocking)').if,
    "${{ always() && steps.path-filter.outputs.should_run == 'true' && github.event_name == 'pull_request' }}");
  const upload = job.steps.find(item => item.name === 'Upload deepteam artifacts (REQ-B6 / REQ-B5)');
  assert.equal(upload.if, "${{ always() && steps.path-filter.outputs.should_run == 'true' }}");
  assert.equal(upload.uses, 'actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4');
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, 'governance/required-checks.yml'), 'utf8')).contexts,
    ['validate', 'runtime-test', 'setup-linux', 'gitleaks', 'semgrep', 'dependency-audit']);
});
test('failed empty discovery publishes no scheduling decision', () => withFixture({ failure: 'empty' }, refused));
test('failed nonmatching partial discovery cannot publish a docs-only skip', () => withFixture({ failure: 'partial', files: ['docs/owned-change.md'] }, refused));
test('failed matching partial discovery cannot authorize a trigger', () => withFixture({ failure: 'partial', files: ['skills/owned-change.md'] }, refused));
test('actual unavailable base object refuses without a scheduling decision', () => withFixture({ failure: 'native' }, refused));
// Mutation: treating empty output as failure or widening prefix boundaries must fail these real-Git controls.
test('successful empty docs-only and excluded lookalikes retain false (regression guard)', () => {
  for (const files of [[], ['docs/owned-change.md', 'README.md'],
    ['skills-extra/owned.md', 'hooks-extra/owned.md', 'subagents-extra/owned.md', 'constitution-extra/owned.md',
      'mcp-configs-extra/owned.md', 'analyzer-extra/owned.md', 'governance/owasp-asi-2026-extra/owned.md']]) {
    withFixture({ files }, r => passed(r, false));
  }
});
// Mutation: losing any one of the seven selected prefixes must fail its independently created comparison.
test('each exact agent-behavior prefix retains true (regression guard)', () => {
  for (const prefix of PREFIXES) withFixture({ files: [prefix + 'owned-change.md'] }, r => passed(r, true));
});
// Mutation: filtering non-PR events or touching Git in the backstop must fail with calls/output evidence.
test('push and schedule retain the unconditional no-Git backstop (regression guard)', () => {
  for (const event of ['push', 'schedule']) withFixture({ event }, r => passed(r, true));
});
