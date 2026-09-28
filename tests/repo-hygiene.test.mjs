// Tests for scripts/check-repo-hygiene.mjs (specs/ops/repo-hygiene.md). The checks are pure, so no git runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseStage, nonExecutableShebangs, versionProblems, unallowedRenders, testScriptProblems, checkRepo, startsWithShebang, TEST_SCRIPT, RENDER_ALLOWLIST } from '../scripts/check-repo-hygiene.mjs';

const stage = (...rows) => rows.map(([mode, file]) => `${mode} 0123456789abcdef0123456789abcdef01234567 0\t${file}`).join('\0') + '\0';

test('a tracked file that starts with #! but is 100644 is reported; an executable one or a plain file is not (specs/ops/repo-hygiene.md#req-1--scripts-with-a-shebang-are-executable)', () => {
  const entries = parseStage(stage(['100644', 'scripts/a.sh'], ['100755', 'scripts/b.sh'], ['100644', 'README.md'], ['100644', 'dir with space/c.mjs']));
  assert.deepEqual(entries.map((e) => e.file), ['scripts/a.sh', 'scripts/b.sh', 'README.md', 'dir with space/c.mjs']);
  const shebang = new Set(['scripts/a.sh', 'scripts/b.sh', 'dir with space/c.mjs']);
  assert.deepEqual(nonExecutableShebangs(entries, (f) => shebang.has(f)), ['scripts/a.sh', 'dir with space/c.mjs']);
});

test('the plugin manifest and VERSION.md must carry the package version (specs/ops/repo-hygiene.md#req-2--one-version)', () => {
  const manifest = (v) => `# DevOPs Version Manifest\n\n**Current version**: ${v}\n**Phase**: x\n`;
  assert.deepEqual(versionProblems({ packageVersion: '0.3.0', pluginVersion: '0.3.0', manifestText: manifest('0.3.0') }), []);
  assert.deepEqual(versionProblems({ packageVersion: '0.3.0', pluginVersion: '0.2.0', manifestText: manifest('0.3.0') }), ['.claude-plugin/plugin.json version 0.2.0 != package.json 0.3.0']);
  assert.deepEqual(versionProblems({ packageVersion: '0.3.0', pluginVersion: '0.3.0', manifestText: manifest('0.2.0') }), ['governance/VERSION.md current version 0.2.0 != package.json 0.3.0']);
  assert.match(versionProblems({ packageVersion: '0.3.0', pluginVersion: '0.3.0', manifestText: '# no version line\n' })[0], /\(missing\)/);
});

test('renders and screenshots outside the allowlist are reported, whatever the case of the extension (specs/ops/repo-hygiene.md#req-3--no-committed-renders)', () => {
  assert.deepEqual(unallowedRenders([...RENDER_ALLOWLIST, 'docs/a.md', 'src/x.ts']), []);
  assert.deepEqual(unallowedRenders(['INFRA_PLAN.pdf', 'runtime/.workflow/qa-live.PNG', 'docs/page.html', 'img/a.webp', 'b.jpeg']),
    ['INFRA_PLAN.pdf', 'runtime/.workflow/qa-live.PNG', 'docs/page.html', 'img/a.webp', 'b.jpeg']);
});

test('the root test script must be the tests/**/*.test.mjs glob, and no fixture may be named like a test (specs/ops/repo-hygiene.md#req-4--every-root-test-file-runs)', () => {
  assert.deepEqual(testScriptProblems(TEST_SCRIPT, ['tests/a.test.mjs', 'tests/fixtures/x/readme.md']), []);
  assert.match(testScriptProblems('node --test tests/a.test.mjs', [])[0], /expected "node --test \\"tests\/\*\*\/\*\.test\.mjs\\""/);
  assert.deepEqual(testScriptProblems(TEST_SCRIPT, ['tests/fixtures/agents/x.test.mjs']), ['tests/fixtures/agents/x.test.mjs: a fixture named like a test; the test glob would run it']);
});

test('checkRepo joins every problem, and a clean repo has none (specs/ops/repo-hygiene.md)', () => {
  const clean = { entries: parseStage(stage(['100755', 'scripts/a.sh'], ['100644', 'README.md'])), startsWithShebang: (f) => f.endsWith('.sh'),
    packageJson: { version: '1.0.0', scripts: { test: TEST_SCRIPT } }, pluginJson: { version: '1.0.0' }, manifestText: '**Current version**: 1.0.0\n' };
  assert.deepEqual(checkRepo(clean), []);
  const dirty = { ...clean, entries: parseStage(stage(['100644', 'scripts/a.sh'], ['100644', 'shot.png'])), pluginJson: { version: '0.9.0' } };
  assert.equal(checkRepo(dirty).length, 3);
});

test('a file git still lists but the working tree has deleted is not read as a script, so a local run with unstaged deletions does not crash (specs/ops/repo-hygiene.md#req-1--scripts-with-a-shebang-are-executable)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-hygiene-'));
  try {
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(path.join(dir, 'notes.md'), '# notes\n');
    writeFileSync(path.join(dir, 'one'), '#');
    assert.equal(startsWithShebang(dir, 'run.sh'), true);
    assert.equal(startsWithShebang(dir, 'notes.md'), false);
    assert.equal(startsWithShebang(dir, 'one'), false);
    assert.equal(startsWithShebang(dir, 'deleted.sh'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
