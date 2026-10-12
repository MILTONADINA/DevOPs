// specs/ops/analyzer-detection.md REQ-1: the project state analyze reports. A fake git
// stands in for the real one (tests do not run git), and records where it was run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectState, GREENFIELD_COMMITS } from '../analyzer/project-state.js';

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

test(`a current-year incident is hotfix, also in a shallow clone (${SPEC}#ac-1)`, () => {
  withProject({ incidents: ['2026-10-01-outage.md'] }, root => {
    assert.equal(detectState(root, { git: fakeGit({ commits: 300 }).git, year: 2026 }).state, 'hotfix');
    assert.equal(detectState(root, { git: fakeGit({ commits: 1, shallow: true }).git, year: 2026 }).state, 'hotfix');
    assert.equal(detectState(root, { git: fakeGit({ commits: 300 }).git, year: 2027 }).state, 'brownfield');
  });
});
