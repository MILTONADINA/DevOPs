// scripts/pack-twice.mjs packs a package twice into separate temp dirs and compares the
// tarballs (specs/release/npm-package.md REQ-13). Packages here are synthetic toys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'pack-twice.mjs');

function toyPackage(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-twice-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'toy-pack', version: '1.0.0', files: ['index.js', 'stamp.txt'], ...extra,
  }));
  writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;\n');
  writeFileSync(path.join(dir, 'stamp.txt'), 'fixed\n');
  return dir;
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 });

test('a stable package packs to identical tarballs', () => {
  const dir = toyPackage();
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /pack-twice: reproducible, 3 files, sha256 [0-9a-f]{64}/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a package that embeds a timestamp fails and names the differing entry', () => {
  const dir = toyPackage({
    scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'stamp.txt\', String(process.hrtime.bigint()))"' },
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /pack-twice: FAIL: tarballs differ/);
    assert.match(r.stderr, /differs: stamp\.txt/);
    assert.doesNotMatch(r.stderr, /differs: index\.js/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a directory without a package.json is refused with a usage-style error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-twice-empty-'));
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pack-twice: /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release-npm.yml and ci.yml run pack-twice, release before the publish job', () => {
  const release = readFileSync(path.join(ROOT, '.github/workflows/release-npm.yml'), 'utf8');
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const call = release.indexOf('node scripts/pack-twice.mjs');
  assert.ok(call > 0, 'release-npm.yml does not call scripts/pack-twice.mjs');
  assert.ok(call < release.indexOf('\n  publish:'), 'pack-twice must run in the verify job, before publish');
  const smoke = ci.slice(ci.indexOf('\n  package-smoke:'), ci.indexOf('\n  agile-graph-link:'));
  assert.match(smoke, /node scripts\/pack-twice\.mjs/);
});
