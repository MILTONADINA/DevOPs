// specs/ops/analyzer-detection.md REQ-1: the project state analyze reports. A fake git
// stands in for the real one (tests do not run git), and records where it was run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectState, GREENFIELD_COMMITS, runGit } from '../analyzer/project-state.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/ops/analyzer-detection.md';

function withProject({ git = true, incidents = [] } = {}, fn) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-state-')));
  try {
    if (git) mkdirSync(path.join(root, '.git'));
    if (incidents.length) {
      mkdirSync(path.join(root, 'docs/incidents'), { recursive: true });
      for (const name of incidents) writeFileSync(path.join(root, 'docs/incidents', name), '');
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A git that answers like a repository with `commits` commits, shallow or not.
function fakeGit({ commits, shallow = false, fail = false }) {
  const calls = [];
  const git = (args, cwd) => {
    calls.push({ args: args.join(' '), cwd });
    if (fail) throw new Error('git: command not found');
    if (args.join(' ') === 'rev-parse --is-shallow-repository') return `${shallow}\n`;
    if (args.join(' ') === 'rev-list --count HEAD') return `${commits}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

test(`every git call runs in the analyzed project, not the working directory (${SPEC}#ac-1)`, () => {
  withProject({}, root => {
    const { git, calls } = fakeGit({ commits: 300 });
    detectState(root, { git });
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call.cwd, root, call.args);
    assert.notEqual(root, process.cwd());
  });
});

test(`the real git runner runs git in the given folder, without a shell (${SPEC}#ac-1)`, () => {
  const seen = [];
  const output = runGit(['rev-list', '--count', 'HEAD'], '/some/project', (file, args, options) => {
    seen.push({ file, args, options });
    return '7\n';
  });
  assert.equal(output, '7\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'git');
  assert.deepEqual(seen[0].args, ['rev-list', '--count', 'HEAD']);
  assert.equal(seen[0].options.cwd, '/some/project');
  assert.ok(!seen[0].options.shell, 'no shell');
});

test(`the greenfield threshold is the spec's five commits (${SPEC}#ac-1)`, () => {
  assert.equal(GREENFIELD_COMMITS, 5);
  assert.match(readFileSync(path.join(ROOT, SPEC), 'utf8'), /fewer than\s+five\s+commits/);
});

test(`no .git, or under ${GREENFIELD_COMMITS} commits in full history, is greenfield (${SPEC}#ac-1)`, () => {
  withProject({ git: false }, root => {
    const { git, calls } = fakeGit({ commits: 300 });
    assert.deepEqual(detectState(root, { git }), { state: 'greenfield', note: null });
    assert.equal(calls.length, 0, 'no git call without .git');
  });
  withProject({}, root => {
    assert.equal(detectState(root, { git: fakeGit({ commits: GREENFIELD_COMMITS - 1 }).git }).state, 'greenfield');
    assert.equal(detectState(root, { git: fakeGit({ commits: GREENFIELD_COMMITS }).git }).state, 'brownfield');
  });
});

test(`a shallow clone with one commit is brownfield, and the note says why (${SPEC}#ac-1)`, () => {
  withProject({}, root => {
    const { git, calls } = fakeGit({ commits: 1, shallow: true });
    const result = detectState(root, { git });
    assert.equal(result.state, 'brownfield');
    assert.match(result.note, /shallow clone/);
    assert.ok(!calls.some(call => call.args.startsWith('rev-list')), 'a shallow count is not read');
  });
});

test(`a failing git does not fail the analysis (${SPEC}#ac-1)`, () => {
  withProject({}, root => {
    assert.deepEqual(detectState(root, { git: fakeGit({ fail: true }).git }), { state: 'brownfield', note: null });
  });
});

test(`devops analyze prints the shallow-clone note after the state (${SPEC}#ac-1)`, () => {
  withProject({}, root => {
    // A stub git on PATH answers like a one-commit shallow clone; the analyzer's own
    // execFileSync('git') finds it. Tests never run the real git.
    const bin = path.join(root, '.stub-bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'git'), [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  "rev-parse --is-shallow-repository") echo true ;;',
      '  "rev-list --count HEAD") echo 1 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(path.join(bin, 'git'), 0o755);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/scan.ts')],
      { cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^State: brownfield \(shallow clone: .+\)$/m);
    assert.match(readFileSync(path.join(root, '.workflow/profile.yml'), 'utf8'), /^state: "brownfield"$/m);
  });
});

test(`a current-year incident is hotfix, also in a shallow clone (${SPEC}#ac-1)`, () => {
  withProject({ incidents: ['2026-10-01-outage.md'] }, root => {
    assert.equal(detectState(root, { git: fakeGit({ commits: 300 }).git, year: 2026 }).state, 'hotfix');
    assert.equal(detectState(root, { git: fakeGit({ commits: 1, shallow: true }).git, year: 2026 }).state, 'hotfix');
    assert.equal(detectState(root, { git: fakeGit({ commits: 300 }).git, year: 2027 }).state, 'brownfield');
  });
});
