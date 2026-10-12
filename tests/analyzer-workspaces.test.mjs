// specs/ops/analyzer-detection.md REQ-2: frameworks of workspace packages. Temporary
// monorepos; the last test runs the real analyzer on one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allDependencies, segmentMatches, workspacePackages, workspacePatterns } from '../analyzer/workspaces.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/ops/analyzer-detection.md';

function withRepo(files, fn) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-workspaces-')));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const relative = (root, files) => files.map(f => path.relative(root, f)).sort();
const pkg = deps => ({ name: 'x', dependencies: deps });

test(`npm and yarn arrays, yarn's object form and pnpm-workspace.yaml all name the packages (${SPEC}#ac-2)`, () => {
  const packages = { 'packages/web/package.json': pkg({ react: '1' }), 'packages/api/package.json': pkg({ fastify: '1' }) };
  for (const [form, rootFiles] of [
    ['array', { 'package.json': { workspaces: ['packages/*'] } }],
    ['yarn object', { 'package.json': { workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } } }],
    ['pnpm', { 'package.json': {}, 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n' }],
  ]) {
    withRepo({ ...rootFiles, ...packages }, root => {
      assert.deepEqual(relative(root, workspacePackages(root)), ['packages/api/package.json', 'packages/web/package.json'], form);
      const deps = allDependencies(root);
      assert.ok(Object.hasOwn(deps, 'react') && Object.hasOwn(deps, 'fastify'), form);
    });
  }
});

test(`exclusions, hidden folders, node_modules, symlinks, .. and unreadable files contribute nothing (${SPEC}#ac-2)`, () => {
  withRepo({
    'package.json': { workspaces: ['packages/*', '!packages/legacy', '../outside', 'tools/**'] },
    'packages/web/package.json': pkg({ react: '1' }),
    'packages/legacy/package.json': pkg({ vue: '1' }),
    'packages/.hidden/package.json': pkg({ svelte: '1' }),
    'packages/broken/package.json': '{ not json',
    'packages/web/node_modules/dep/package.json': pkg({ astro: '1' }),
    'tools/a/b/package.json': pkg({ hono: '1' }),
    'tools/node_modules/dep/package.json': pkg({ express: '1' }),
  }, root => {
    symlinkSync(path.join(root, 'packages/legacy'), path.join(root, 'packages/linked'));
    const files = relative(root, workspacePackages(root));
    assert.deepEqual(files, ['packages/broken/package.json', 'packages/web/package.json', 'tools/a/b/package.json']);
    const deps = Object.keys(allDependencies(root)).sort();
    assert.deepEqual(deps, ['hono', 'react'], 'broken JSON is skipped; excluded, hidden, node_modules and linked packages add nothing');
    assert.deepEqual(workspacePatterns(root), ['packages/*', '!packages/legacy', '../outside', 'tools/**']);
  });
});

test(`segment matching follows * and stays fast on a pattern built to backtrack (${SPEC}#ac-2)`, () => {
  for (const [segment, name, expected] of [
    ['web', 'web', true], ['web', 'webs', false], ['*', 'anything', true], ['app-*', 'app-one', true],
    ['app-*', 'lib-one', false], ['*-ui', 'admin-ui', true], ['a*b*c', 'axxbyyc', true], ['a*b*c', 'axxbyy', false],
    ['**', 'x', true], ['', 'x', false],
  ]) assert.equal(segmentMatches(segment, name), expected, `${segment} vs ${name}`);
  const hostile = `${'*a'.repeat(40)}*b`;
  const name = 'a'.repeat(255);
  const started = process.hrtime.bigint();
  assert.equal(segmentMatches(hostile, name), false);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `matched in ${ms.toFixed(1)} ms`);
});

test(`a tree larger than the read budget stops expanding and keeps its exclusions (${SPEC}#ac-2)`, () => {
  const files = { 'package.json': { workspaces: ['packages/**', '!packages/p00'] } };
  for (let i = 0; i < 40; i++) files[`packages/p${String(i).padStart(2, '0')}/package.json`] = pkg({ react: '1' });
  withRepo(files, root => {
    const all = workspacePackages(root);
    assert.equal(all.length, 39, 'within the default budget every package but the excluded one');
    const bounded = workspacePackages(root, { maxVisited: 10 });
    assert.ok(bounded.length > 0 && bounded.length < 39, `a budget of 10 reads stops early (${bounded.length})`);
    assert.ok(!bounded.some(f => f.includes(`${path.sep}p00${path.sep}`)), 'the exclusion still holds');
  });
});

test(`a repository without workspaces reads only the root package (${SPEC}#ac-2)`, () => {
  withRepo({ 'package.json': pkg({ next: '1' }), 'packages/web/package.json': pkg({ react: '1' }) }, root => {
    assert.deepEqual(workspacePackages(root), []);
    assert.deepEqual(Object.keys(allDependencies(root)), ['next']);
  });
});

test(`devops analyze reports the frameworks of workspace packages, each once (${SPEC}#ac-2)`, () => {
  withRepo({
    'package.json': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { typescript: '5' } },
    'packages/dashboard/package.json': { name: 'dashboard', dependencies: { react: '19' }, devDependencies: { vite: '7', vitest: '3' } },
    'packages/site/package.json': { name: 'site', dependencies: { react: '19' } },
  }, root => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/scan.ts')],
      { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Frameworks: vite, react$/m);
    const profile = readFileSync(path.join(root, '.workflow/profile.yml'), 'utf8');
    assert.equal(profile.match(/- "react"/g)?.length, 1, 'react is reported once');
  });
});
