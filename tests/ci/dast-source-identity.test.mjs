// specs/security/local-dast.md REQ1/9: actual-byte source identity, no provisioning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'scripts/prepare-dast.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(run) {
  assert.ok(existsSync(SOURCE), 'FEATURE_ABSENT: scripts/prepare-dast.mjs is not implemented');
  const { sourceManifest } = await import(pathToFileURL(SOURCE).href);
  assert.equal(typeof sourceManifest, 'function', 'sourceManifest export prerequisite');
  const parent = path.join(ROOT, '.workflow/state'); mkdirSync(parent, { recursive: true });
  const outer = mkdtempSync(path.join(parent, 'dast-source-')); const root = path.join(outer, 'root');
  mkdirSync(path.join(root, 'src'), { recursive: true }); mkdirSync(path.join(root, 'dast'));
  writeFileSync(path.join(root, 'src/first.txt'), 'synthetic café\n');
  writeFileSync(path.join(root, 'src/second.txt'), 'second\r\n');
  writeFileSync(path.join(root, 'dast/run.json'), '');
  const paths = ['src/second.txt', 'dast/run.json', 'src/first.txt'];
  try { await run({ root, outer, paths, sourceManifest }); }
  finally { rmSync(outer, { recursive: true, force: true }); }
}
function expected(root, paths) {
  const files = [...paths].sort().map(name => {
    const bytes = readFileSync(path.join(root, name)); return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  return { files, sha256: hash(JSON.stringify(files)) };
}

test('source identity derives sorted manifest and hashes from exact named file bytes', async () => fixture(async f => {
  const value = await f.sourceManifest(f.root, f.paths);
  assert.deepEqual(value, expected(f.root, f.paths));
  assert.deepEqual(await f.sourceManifest(f.root, [...f.paths].reverse()), value);
  assert.equal(value.files.find(file => file.path === 'dast/run.json').bytes, 0);
}));

test('changed source changes identity while separate generated run config does not', async () => fixture(async f => {
  const before = await f.sourceManifest(f.root, f.paths);
  writeFileSync(path.join(f.root, 'generated-run.json'), '{"run_id":"owned-synthetic"}\n');
  assert.deepEqual(await f.sourceManifest(f.root, f.paths), before);
  writeFileSync(path.join(f.root, 'src/first.txt'), 'synthetic cafe\n');
  const after = await f.sourceManifest(f.root, f.paths); assert.deepEqual(after, expected(f.root, f.paths));
  assert.notEqual(after.sha256, before.sha256);
  assert.notEqual(after.files.find(file => file.path === 'src/first.txt').sha256, before.files.find(file => file.path === 'src/first.txt').sha256);
  for (const name of ['src/second.txt', 'dast/run.json']) assert.deepEqual(after.files.find(file => file.path === name), before.files.find(file => file.path === name));
}));

test('source admission refuses missing, nonregular, escaping and redirected named inputs unchanged', async () => fixture(async f => {
  const outside = path.join(f.outer, 'owned-outside.txt'); writeFileSync(outside, 'MR21_PRIVATE_SOURCE_SENTINEL\n');
  symlinkSync(outside, path.join(f.root, 'leaf.txt'));
  symlinkSync(path.join(f.root, 'src'), path.join(f.root, 'redirect'));
  const snapshot = f.paths.map(file => [file, readFileSync(path.join(f.root, file))]);
  for (const paths of [['missing'], ['src'], ['../owned-outside.txt'], [outside], ['leaf.txt'], ['redirect/first.txt'],
    ['src/first.txt', 'src/first.txt'], ['src/./first.txt']]) {
    await assert.rejects(async () => f.sourceManifest(f.root, paths), error => {
      assert.equal(String(error).includes('MR21_PRIVATE_SOURCE_SENTINEL'), false); return true;
    });
    for (const [file, bytes] of snapshot) assert.deepEqual(readFileSync(path.join(f.root, file)), bytes);
    assert.equal(readFileSync(outside, 'utf8'), 'MR21_PRIVATE_SOURCE_SENTINEL\n');
  }
}));
