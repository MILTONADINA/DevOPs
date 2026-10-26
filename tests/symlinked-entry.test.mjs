// specs/ops/script-entrypoints.md: every script whose entry guard uses scripts/lib/is-main.mjs
// still runs its main path when started through a symlink to the file (issue #293).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let skip = false;
{
  const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try { symlinkSync(join(ROOT, 'package.json'), join(probe, 'p')); } catch { skip = 'cannot create symlinks here'; }
  rmSync(probe, { recursive: true, force: true });
}

let haveAcorn = true;
try { createRequire(join(ROOT, 'package.json')).resolve('acorn'); } catch { haveAcorn = false; }

const dir = skip ? null : realpathSync(mkdtempSync(join(tmpdir(), 'symlinked-entry-')));
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function viaSymlink(script, args = []) {
  const link = join(dir, script.replaceAll('/', '_'));
  symlinkSync(join(ROOT, 'scripts', script), link);
  return spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', cwd: dir });
}

test('agile-graph-pin-diff prints its comparison', { skip }, () => {
  const engine = join(dir, 'engine.json');
  const pins = join(dir, 'pins.json');
  writeFileSync(engine, '{"a":"1","b":"2"}');
  writeFileSync(pins, '{"a":"1","b":"3"}');
  const r = viaSymlink('agile-graph-pin-diff.mjs', [engine, pins]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { match: false, changed: ['b'], added: [], removed: [] });
});

test('assert-dast-reports reports usage and exits 1', { skip }, () => {
  const r = viaSymlink('assert-dast-reports.mjs');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).reason, 'usage');
});

test('dependency-report prints usage and exits 2', { skip }, () => {
  const r = viaSymlink('dependency-report.mjs');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node scripts\/dependency-report\.mjs/);
});

test('check-assertions flags a test file without an assertion', { skip: skip || (!haveAcorn && 'acorn is not installed') }, () => {
  const file = join(dir, 'noassert.test.mjs');
  writeFileSync(file, 'export const x = 1;\n');
  const r = viaSymlink('check-assertions.mjs', [file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no assert/);
});

test('check-repo-hygiene runs its checks', { skip }, () => {
  const r = viaSymlink('check-repo-hygiene.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo hygiene: \d+ files checked/);
});

test('lint-spec-status runs its checks', { skip }, () => {
  const r = viaSymlink('lint-spec-status.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /spec status: \d+ specs/);
});

test('check-test-floor runs its main path (fails on missing arguments)', { skip }, () => {
  const r = viaSymlink('check-test-floor.mjs');
  assert.notEqual(r.status, 0);
});
