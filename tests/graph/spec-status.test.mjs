// Tests for scripts/lint-spec-status.mjs (masterpiece REQ-M8; quality plan MR-11(A), T5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { specStatus, checkBaseline, checkRatchet, lintSpecs } from '../../scripts/lint-spec-status.mjs';

const spec = (statusLine) => `# A spec\n\n${statusLine}\n**Spec ID**: a/b\n\n## Requirements\n\nREQ-1\n`;

test('both bold forms parse, and a parenthetical note may follow the status word', () => {
  assert.deepEqual(specStatus(spec('**Status**: approved')), { status: 'approved' });
  assert.deepEqual(specStatus(spec('**Status:** draft')), { status: 'draft' });
  assert.deepEqual(specStatus(spec('**Status**: approved (owner, 2026-09-26, spec batch 1)')), { status: 'approved' });
  assert.deepEqual(specStatus(spec('**Status**: superseded (by specs/ops/x.md)')), { status: 'superseded' });
  assert.deepEqual(specStatus(spec('**Status**: implemented')), { status: 'implemented' });
});

test('a value outside the vocabulary fails, including prefix matches and the template placeholder', () => {
  for (const value of [
    'approved for implementation by the owner',
    'implementation',
    'AUTHORED 2026-05-25 — Phase A executed',
    'Active — driving session 7',
    'deprecated',
    'Approved',
    'draft | approved | implemented | superseded',
    '',
    'approved (x) but actually still a draft',
    'approved (for implementation, not really',
    'approved (owner (batch 1))',
    'approved(note)',
  ]) {
    const result = specStatus(spec(`**Status**: ${value}`));
    assert.equal(result.status, undefined, value);
    assert.match(result.error, /not in the vocabulary/, value);
  }
});

test('a spec with no Status line fails, and only a Status line before the first ## heading counts', () => {
  assert.deepEqual(specStatus('# A spec\n\n**Scope:** x\n'), { error: 'no **Status** line before the first ## heading' });
  assert.deepEqual(specStatus('# A spec\n\n## History\n\n**Status**: approved\n'), { error: 'no **Status** line before the first ## heading' });
  assert.deepEqual(specStatus('# A spec\n   ## History\n**Status**: approved\n'), { error: 'no **Status** line before the first ## heading' });
});

test('Status lines inside HTML comments or fenced code do not count, and two Status lines fail', () => {
  assert.match(specStatus('# A\n<!--\n**Status**: approved\n-->\n**Status**: AUTHORED\n').error, /not in the vocabulary/);
  assert.match(specStatus('# A\n```\n**Status**: approved\n```\n').error, /no \*\*Status\*\* line/);
  // A `## ` line inside a fence does not end the header.
  assert.deepEqual(specStatus('# A\n~~~md\n## not a heading\n~~~\n**Status**: draft\n'), { status: 'draft' });
  assert.match(specStatus('# A\n**Status**: approved\n**Status**: draft\n').error, /2 \*\*Status\*\* lines/);
});

test('fences follow CommonMark: an info string never closes a fence, and a backtick opener holds no backtick', () => {
  // Inside an open fence, a "```bash" line is content, so the visible Status is AUTHORED.
  assert.match(specStatus('# A\n\n```text\nex\n```bash\n**Status**: draft\n```\n**Status**: AUTHORED\n## Next\n').error, /"AUTHORED"/);
  // "```x``` inline" is inline code, not a fence opener, so AUTHORED is visible and draft is fenced.
  assert.match(specStatus('# A\n\n```x``` inline\n**Status**: AUTHORED\n\n```\n**Status**: draft\n```\n## Next\n').error, /"AUTHORED"/);
  // A longer closer closes; a shorter one does not.
  assert.deepEqual(specStatus('# A\n````\n```\n**Status**: AUTHORED\n`````\n**Status**: draft\n'), { status: 'draft' });
});

test('<!--> and <!---> are complete comments, and a comment opened mid-line hides only what it covers', () => {
  assert.deepEqual(specStatus('# A\n<!-->\n**Status**: draft\n## B\n'), { status: 'draft' });
  assert.deepEqual(specStatus('# A\n<!--->\n**Status**: draft\n## B\n'), { status: 'draft' });
  assert.deepEqual(specStatus('# A\n**Status**: draft <!-- (not part of the value) -->\n'), { status: 'draft' });
  assert.match(specStatus('# A\ntext <!-- hidden\n**Status**: approved\n-->\n**Status**: AUTHORED\n').error, /"AUTHORED"/);
});

test('CRLF line endings and a byte-order mark parse like plain text', () => {
  assert.deepEqual(specStatus('\uFEFF**Status**: approved\r\n# A\r\n'), { status: 'approved' });
  assert.deepEqual(specStatus('# A\r\n\r\n**Status:** implemented\r\n## Next\r\n'), { status: 'implemented' });
});

test('the baseline absorbs known failures only: a new failure fails, and a fixed or deleted spec must leave it', () => {
  const results = new Map([
    ['specs/a.md', { status: 'approved' }],
    ['specs/b.md', { error: 'no **Status** line before the first ## heading' }],
  ]);
  assert.deepEqual(checkBaseline(results, ['specs/b.md']), []);
  assert.match(checkBaseline(results, []).join('\n'), /specs\/b\.md: no \*\*Status\*\* line/);
  assert.match(checkBaseline(results, ['specs/a.md', 'specs/b.md']).join('\n'), /specs\/a\.md now passes; remove it from the baseline/);
  assert.match(checkBaseline(results, ['specs/b.md', 'specs/gone.md']).join('\n'), /specs\/gone\.md is not a spec any more; remove it from the baseline/);
});

test('the baseline may only shrink against the base branch', () => {
  assert.equal(checkRatchet({ spec_status: ['specs/a.md', 'specs/b.md'] }, { spec_status: ['specs/a.md'] }), null);
  assert.match(checkRatchet({ spec_status: ['specs/a.md'] }, { spec_status: ['specs/a.md', 'specs/c.md'] }), /baseline grew: specs\/c\.md/);
  assert.match(checkRatchet({ spec_status: ['specs/a.md'] }, {}), /no spec_status list/);
  // The PR that introduces the baseline has no base list to compare against.
  assert.equal(checkRatchet({}, { spec_status: ['specs/a.md'] }), null);
});

test('lintSpecs reads every markdown file under specs/, recursively, with repo-relative paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'spec-status-'));
  try {
    mkdirSync(path.join(root, 'specs', 'ops'), { recursive: true });
    writeFileSync(path.join(root, 'specs', 'ops', 'good.md'), spec('**Status**: draft'));
    writeFileSync(path.join(root, 'specs', 'bad.md'), spec('**Status**: AUTHORED'));
    writeFileSync(path.join(root, 'specs', 'notes.txt'), 'not a spec');
    const results = lintSpecs(root);
    assert.deepEqual([...results.keys()].sort(), ['specs/bad.md', 'specs/notes.txt', 'specs/ops/good.md']);
    assert.deepEqual(results.get('specs/ops/good.md'), { status: 'draft' });
    assert.match(results.get('specs/bad.md').error, /not in the vocabulary/);
    assert.match(results.get('specs/notes.txt').error, /not a \.md file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an upper-case extension and a symbolic link under specs/ fail instead of escaping the lint', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'spec-status-')));
  try {
    mkdirSync(path.join(root, 'specs', 'real'), { recursive: true });
    mkdirSync(path.join(root, 'elsewhere'));
    writeFileSync(path.join(root, 'specs', 'SHOUT.MD'), spec('**Status**: AUTHORED'));
    writeFileSync(path.join(root, 'elsewhere', 'hidden.md'), spec('**Status**: AUTHORED'));
    symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'specs', 'linked'));
    const results = lintSpecs(root);
    assert.match(results.get('specs/SHOUT.MD').error, /not a \.md file/);
    assert.match(results.get('specs/linked').error, /symbolic link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The CLI is what CI runs: spawn it as a process against a temporary root.
const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'lint-spec-status.mjs');

function withProject(specs, baseline, fn) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'spec-status-cli-')));
  try {
    mkdirSync(path.join(root, 'specs'));
    mkdirSync(path.join(root, 'governance'));
    for (const [name, text] of Object.entries(specs)) writeFileSync(path.join(root, 'specs', name), text);
    writeFileSync(path.join(root, 'governance', 'traceability-baseline.json'), JSON.stringify({ spec_status: baseline }));
    return fn(root, (...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the CLI exits 0 on a clean tree and 1 on a failing spec the baseline does not list', () => {
  withProject({ 'a.md': spec('**Status**: draft'), 'b.md': spec('**Status**: AUTHORED') }, ['specs/b.md'], (root, run) => {
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /2 specs, 1 pass, 1 baselined/);
  });
  withProject({ 'a.md': spec('**Status**: draft'), 'b.md': spec('**Status**: AUTHORED') }, [], (root, run) => {
    const failing = run();
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /specs\/b\.md: Status "AUTHORED"/);
  });
});

test('the CLI ratchet exits 1 when the baseline grew against the base file and 0 when it shrank', () => {
  withProject({ 'a.md': spec('**Status**: AUTHORED') }, ['specs/a.md'], (root, run) => {
    const base = path.join(root, 'base.json');
    writeFileSync(base, JSON.stringify({ spec_status: [] }));
    const grown = run('--ratchet', base);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /baseline grew: specs\/a\.md/);
    writeFileSync(base, JSON.stringify({ spec_status: ['specs/a.md', 'specs/gone.md'] }));
    assert.equal(run('--ratchet', base).status, 0);
  });
});

test('the CLI still runs when invoked through a symbolic link to the script', () => {
  withProject({ 'b.md': spec('**Status**: AUTHORED') }, [], (root) => {
    const link = path.join(root, 'linked-lint.mjs');
    symlinkSync(SCRIPT, link);
    const run = spawnSync(process.execPath, [link, '--root', root], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'a symlinked invocation must not exit 0 without checking anything');
  });
});

test('each script imports cleanly when argv[1] names a path that does not exist', () => {
  for (const name of ['lint-spec-status.mjs', 'check-test-floor.mjs', 'check-assertions.mjs']) {
    const url = new URL(`../../scripts/${name}`, import.meta.url).href;
    const run = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(3); })`, 'no-such-file'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
});
