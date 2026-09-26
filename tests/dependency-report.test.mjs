// Tests for scripts/dependency-report.mjs (owner decision 2026-09-26: dependency updates are
// reported through one issue, never through bot branches; quality plan QW-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { npmRows, parseOutdated, pinnedVersions, pythonRows, renderReport, ISSUE_TITLE } from '../scripts/dependency-report.mjs';

const OUTDATED = {
  vitest: { current: '5.0.1', wanted: '5.0.4', latest: '5.2.0', dependent: 'stratum', type: 'devDependencies' },
  zod: { current: '3.25.1', wanted: '3.25.8', latest: '4.1.0', dependent: 'stratum', type: 'dependencies' },
  // npm reports a package that is declared but not installed with no `current`.
  pino: { wanted: '9.9.0', latest: '9.9.0', dependent: 'stratum', type: 'dependencies' },
};

test('npm rows are sorted by name and flag a major update', () => {
  assert.deepEqual(npmRows(OUTDATED), [
    { name: 'pino', current: 'not installed', wanted: '9.9.0', latest: '9.9.0', type: 'dependencies', major: false, behindOnly: false },
    { name: 'vitest', current: '5.0.1', wanted: '5.0.4', latest: '5.2.0', type: 'devDependencies', major: false, behindOnly: false },
    { name: 'zod', current: '3.25.1', wanted: '3.25.8', latest: '4.1.0', type: 'dependencies', major: true, behindOnly: false },
  ]);
  assert.deepEqual(npmRows({}), []);
});

test('a latest release older than the installed one is listed but not flagged major, and 0.x minor bumps are major', () => {
  const rows = npmRows({
    '@types/uuid': { current: '11.0.0', wanted: '11.0.0', latest: '10.0.0', type: 'devDependencies' },
    tiny: { current: '0.4.2', wanted: '0.4.2', latest: '0.5.0' },
  });
  assert.deepEqual(rows.map((r) => [r.name, r.major, r.type, r.behindOnly]), [['@types/uuid', false, 'devDependencies', true], ['tiny', true, 'unknown', false]]);
});

test('a row whose latest tag is older than the installed version is not counted, so the issue can close', () => {
  const rows = npmRows({ '@types/uuid': { current: '11.0.0', wanted: '11.0.0', latest: '10.0.0', type: 'devDependencies' } });
  const report = renderReport({ npm: [{ tree: 'stratum', rows }], python: [], errors: [] });
  assert.equal(report.outdated, 0);
  assert.match(report.body, /All tracked dependencies are current/);
  assert.match(report.body, /stratum: @types\/uuid 11\.0\.0 \(latest tag 10\.0\.0\)/);
});

test('npm outdated JSON that reports a registry error throws, and never becomes a package named "error"', () => {
  assert.throws(() => parseOutdated(JSON.stringify({ error: { code: 'ECONNREFUSED', summary: 'request to registry failed' } }), 'stratum'),
    /npm outdated failed in stratum: ECONNREFUSED request to registry failed/);
  assert.deepEqual(parseOutdated('{"zod":{"current":"3.0.0"}}', 'root'), { zod: { current: '3.0.0' } });
  assert.deepEqual(parseOutdated('', 'root'), {});
});

test('pinned versions are read from a hash-locked requirements file, including continuation lines', () => {
  const txt = 'deepteam==1.0.9 \\\n    --hash=sha256:aaa \\\n    --hash=sha256:bbb\n    # via -r deepteam.in\nPyYAML==6.0.3 \\\n    --hash=sha256:ccc\n';
  assert.deepEqual(pinnedVersions(txt), { deepteam: '1.0.9', pyyaml: '6.0.3' });
});

test('python names normalize dots, dashes and underscores the same way on both sides', () => {
  const pins = pinnedVersions('ruamel.yaml==0.18.6 \\\n    --hash=sha256:aaa\nZope_Interface==7.1 \\\n    --hash=sha256:bbb\n');
  assert.deepEqual(pins, { 'ruamel-yaml': '0.18.6', 'zope-interface': '7.1' });
  assert.deepEqual(pythonRows(['ruamel.yaml', 'zope.interface'], pins, { 'ruamel-yaml': '0.19.0', 'zope-interface': '7.1' }).map((r) => r.name), ['ruamel-yaml']);
});

test('python rows list only the top-level packages whose pinned version is behind', () => {
  const rows = pythonRows(['deepteam', 'sentry-sdk', 'pyyaml'], { deepteam: '1.0.9', 'sentry-sdk': '2.70.0', pyyaml: '6.0.3' }, { deepteam: '1.1.0', 'sentry-sdk': '2.70.0', pyyaml: '7.0.0' });
  assert.deepEqual(rows, [
    { name: 'deepteam', current: '1.0.9', latest: '1.1.0', major: false },
    { name: 'pyyaml', current: '6.0.3', latest: '7.0.0', major: true },
  ]);
  // A pin newer than PyPI's latest (a yanked release, say) is not an update.
  assert.deepEqual(pythonRows(['a'], { a: '2.0.0' }, { a: '1.9.0' }), []);
  // Differences past the third numeric part, and PEP 440 suffixes, are updates.
  assert.deepEqual(pythonRows(['b', 'c', 'd'], { b: '1.0rc1', c: '6.0.3', d: '1.2.3.4' }, { b: '1.0', c: '6.0.3.post1', d: '1.2.3.5' }).map((r) => r.name), ['b', 'c', 'd']);
});

test('the report names each tree, marks major updates, and says how to apply them', () => {
  const report = renderReport({
    npm: [{ tree: 'root', rows: [] }, { tree: 'stratum', rows: npmRows(OUTDATED) }],
    python: [{ file: '.github/requirements/deepteam.txt', rows: [{ name: 'deepteam', current: '1.0.9', latest: '1.1.0', major: false }] }],
    errors: [],
  });
  assert.equal(report.outdated, 4);
  assert.match(report.body, /## npm: stratum/);
  assert.match(report.body, /\| zod \| 3\.25\.1 \| 3\.25\.8 \| 4\.1\.0 \| dependencies \| \*\*major\*\* \|/);
  assert.match(report.body, /## Python: \.github\/requirements\/deepteam\.txt/);
  assert.match(report.body, /no bot opens branches/i);
  assert.doesNotMatch(report.body, /## npm: root/);
});

test('an empty report says everything is current, and collection errors are shown, never hidden', () => {
  const clean = renderReport({ npm: [{ tree: 'root', rows: [] }], python: [], errors: [] });
  assert.equal(clean.outdated, 0);
  assert.match(clean.body, /All tracked dependencies are current/);
  const broken = renderReport({ npm: [], python: [], errors: ['npm outdated failed in stratum: exit 2'] });
  assert.equal(broken.errors, 1);
  assert.match(broken.body, /npm outdated failed in stratum: exit 2/);
  assert.equal(ISSUE_TITLE, 'Dependency updates available');
});
