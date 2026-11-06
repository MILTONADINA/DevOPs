// scripts/prepare-dast.mjs checks the native esbuild that tsx loads in the
// staged runtime install. It looks where the runtime lockfile puts it: a copy
// nested under tsx, else the hoisted top-level copy (#360).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { esbuildPackageDir } from '../scripts/prepare-dast.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('a nested esbuild under tsx wins over a hoisted one', () => {
  const lock = { 'node_modules/tsx/node_modules/@esbuild/linux-x64': { version: '1.0.0' }, 'node_modules/@esbuild/linux-x64': { version: '2.0.0' } };
  assert.deepEqual(esbuildPackageDir(lock, 'amd64'), { path: 'node_modules/tsx/node_modules/@esbuild/linux-x64', version: '1.0.0' });
});

test('a hoisted esbuild is found when tsx has no nested copy', () => {
  const lock = { 'node_modules/@esbuild/linux-arm64': { version: '2.0.0' } };
  assert.deepEqual(esbuildPackageDir(lock, 'arm64'), { path: 'node_modules/@esbuild/linux-arm64', version: '2.0.0' });
});

test('a lock with no esbuild for the platform is refused', () => {
  assert.throws(() => esbuildPackageDir({ 'node_modules/@esbuild/linux-x64': {} }, 'arm64'), /resolves no @esbuild\/linux-arm64/);
});

test('the runtime lockfile resolves the esbuild version prepare-dast asserts, on both platforms', () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'runtime/package-lock.json'), 'utf8')).packages;
  const source = readFileSync(path.join(ROOT, 'scripts/prepare-dast.mjs'), 'utf8');
  const asserted = /path\.join\(esbuild, 'package\.json'\)\)\)\.version, '([^']+)'\)/.exec(source)?.[1];
  assert.ok(asserted, 'prepare-dast asserts an esbuild version');
  for (const arch of ['amd64', 'arm64']) assert.equal(esbuildPackageDir(lock, arch).version, asserted, arch);
});
