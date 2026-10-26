import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const HELPER = join(ROOT, 'scripts/lib/is-main.mjs');
const skipSymlink = process.platform === 'win32' ? 'symlinks need privileges on win32' : false;

// Runs a probe script that prints isMain(import.meta.url) when started as argv[1].
function probe(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')));
  const real = join(dir, 'real dir');
  mkdirSync(real);
  writeFileSync(join(real, 'probe.mjs'),
    `import { isMain } from ${JSON.stringify(pathToFileURL(HELPER).href)};\nprocess.stdout.write(String(isMain(import.meta.url)));\n`);
  return { dir, real };
}

test('isMain is true for a direct path (including spaces)', () => {
  const { dir, real } = fixture();
  try { assert.equal(probe(join(real, 'probe.mjs')).stdout, 'true'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isMain is true when started through a symlinked folder', { skip: skipSymlink }, () => {
  const { dir, real } = fixture();
  try {
    symlinkSync(real, join(dir, 'link'));
    assert.equal(probe(join(dir, 'link', 'probe.mjs')).stdout, 'true');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isMain is false when the module is imported, not started', () => {
  const { dir, real } = fixture();
  try {
    const other = join(real, 'other.mjs');
    writeFileSync(other, `await import(${JSON.stringify(pathToFileURL(join(real, 'probe.mjs')).href)});\n`);
    assert.equal(probe(other).stdout, 'false');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isMain is false when argv[1] is missing', async () => {
  const { isMain } = await import(pathToFileURL(HELPER).href);
  const saved = process.argv[1];
  try {
    process.argv[1] = '';
    assert.equal(isMain(import.meta.url), false);
    process.argv.length = 1;
    assert.equal(isMain(import.meta.url), false);
  } finally { process.argv[1] = saved; }
});

test('isMain is false when a path does not exist', async () => {
  const { isMain } = await import(pathToFileURL(HELPER).href);
  const saved = process.argv[1];
  try {
    process.argv[1] = join(tmpdir(), 'is-main-missing', 'nope.mjs');
    assert.equal(isMain(import.meta.url), false);
    process.argv[1] = saved;
    assert.equal(isMain(pathToFileURL(join(tmpdir(), 'is-main-missing', 'nope.mjs')).href), false);
  } finally { process.argv[1] = saved; }
});

test('a real script runs when started through a symlinked scripts folder', { skip: skipSymlink }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-link-')));
  try {
    const link = join(dir, 'scripts-link');
    symlinkSync(join(ROOT, 'scripts'), link);
    const result = probe(join(link, 'triage-claims.mjs'));
    // triage-claims refuses replay with exit 1; a skipped guard would exit 0 silently.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /command replay is disabled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the retained DAST runner identity includes the shared entry check (specs/ops/script-entrypoints.md REQ-2)', () => {
  const source = readFileSync(join(ROOT, 'scripts/run-dast.mjs'), 'utf8');
  const roster = source.slice(source.indexOf("'runner-sources.json'"));
  assert.match(roster.slice(0, roster.indexOf(']')), /'scripts\/lib\/is-main\.mjs'/);
});
