// GitHub issue #209 (weekly dependency report): the non-major updates it lists are applied in
// the committed lockfiles and its major updates are not. Reads the lockfiles only, so no install
// is needed. A later release on the same major also passes, so a future non-major bump does not
// break this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = { root: '.', runtime: 'runtime' };
const lockfile = (dir) => JSON.parse(readFileSync(path.join(ROOT, DIRS[dir], 'package-lock.json'), 'utf8')).packages;
const locked = (dir, name) => lockfile(dir)[`node_modules/${name}`]?.version;

// Same major as the target and not older than it, comparing numeric segments (5.20261102.1 included).
function sameMajorAtLeast(have, want) {
  if (!have) return false;
  const h = have.split('.').map(Number);
  const w = want.split('.').map(Number);
  if (h[0] !== w[0]) return false;
  for (let i = 1; i < w.length; i += 1) if (h[i] !== w[i]) return h[i] > w[i];
  return true;
}

// Non-major targets listed in issue #209: [manifest directory, package, target version].
const APPLIED = [
  ['root', '@opentelemetry/core', '2.12.0'],
  ['root', '@opentelemetry/sdk-trace-base', '2.12.0'],
  ['root', '@types/node', '24.19.2'],
  ['root', 'acorn', '8.19.0'],
  ['root', 'tsx', '4.23.15'],
  ['runtime', '@huggingface/transformers', '4.3.2'],
  ['runtime', '@supabase/supabase-js', '2.118.0'],
  ['runtime', 'axios', '1.21.0'],
  ['runtime', '@cloudflare/workers-types', '5.20261102.1'],
  ['runtime', '@types/node', '22.20.5'],
  ['runtime', '@vitest/coverage-v8', '5.0.5'],
  ['runtime', 'vitest', '5.0.5'],
  ['runtime', 'prettier', '3.9.10'],
  ['runtime', 'supabase', '2.122.0'],
  ['runtime', 'tsx', '4.23.15'],
  ['runtime', 'wrangler', '4.156.1'],
];
for (const [dir, name, want] of APPLIED) {
  test(`${dir} lockfile applies the issue #209 update ${name}@${want}`, () => {
    const have = locked(dir, name);
    assert.ok(sameMajorAtLeast(have, want), `${name} is ${have}; expected ${want} or a later release on the same major`);
  });
}

// Major updates listed in issue #209 stay deferred: each package keeps the major it has today.
const DEFERRED_MAJOR = [
  ['root', 'typescript', '5'],
  ['runtime', '@anthropic-ai/sdk', '0'],
  ['runtime', '@fastify/cors', '10'],
  ['runtime', '@fastify/rate-limit', '10'],
  ['runtime', '@pinecone-database/pinecone', '3'],
  ['runtime', 'dotenv', '16'],
  ['runtime', 'eslint', '8'],
  ['runtime', 'fastify-plugin', '4'],
  ['runtime', 'neo4j-driver', '5'],
  ['runtime', 'pino', '8'],
  ['runtime', 'pino-pretty', '11'],
  ['runtime', 'typescript', '5'],
  ['runtime', 'uuid', '11'],
];
for (const [dir, name, major] of DEFERRED_MAJOR) {
  test(`${dir} lockfile keeps ${name} on major ${major} (issue #209 major update deferred)`, () => {
    assert.equal(locked(dir, name)?.split('.')[0], major);
  });
}

// Held at 8.55.0: typescript-eslint 8.56 and later pull eslint-visitor-keys 5, which needs Node
// ^22.13, and the project supports Node >=22.12.0 (docs/handoff/README.md). Lift the hold only
// once that dependency is resolved.
for (const name of ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser']) {
  test(`runtime lockfile holds ${name} at 8.55.0 (Node 22.12 floor; docs/handoff/README.md)`, () => {
    assert.equal(locked('runtime', name), '8.55.0');
  });
}

// Held at the version @huggingface/transformers pins exactly: issue #209 lists onnxruntime-node
// 1.31.1, but a direct bump past that pin installs a second native runtime tree (about 290 MB)
// beside the one transformers loads, and nothing imports the direct package. Lift the hold when
// transformers moves its pin.
test('runtime lockfile holds onnxruntime-node at the version @huggingface/transformers pins', () => {
  const packages = lockfile('runtime');
  const pin = packages['node_modules/@huggingface/transformers'].dependencies['onnxruntime-node'];
  assert.equal(locked('runtime', 'onnxruntime-node'), pin);
  const nested = Object.keys(packages).filter((key) => key.endsWith('/node_modules/onnxruntime-node'));
  assert.deepEqual(nested, [], 'no second onnxruntime-node tree is installed');
});

// Reads the ignore block of one npm entry in .github/dependabot.yml, skipping comments, and returns
// its rules. Fails closed on any line it does not recognise.
function dependabotNpmIgnore(directory) {
  const config = readFileSync(path.join(ROOT, '.github/dependabot.yml'), 'utf8');
  const entry = config
    .split(/\n  - package-ecosystem: /)
    .find((part) => part.startsWith('npm\n') && part.includes(`\n    directory: ${directory}\n`));
  assert.ok(entry, `dependabot.yml has an npm entry for directory ${directory}`);
  const lines = entry.split('\n').filter((line) => !/^\s*#/.test(line));
  const start = lines.indexOf('    ignore:');
  assert.ok(start >= 0, `the npm entry for ${directory} has an ignore block`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('      ')) break;
    block.push(line);
  }
  const list = (value) => value.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
  const ignored = [];
  for (const line of block) {
    const name = line.match(/^      - dependency-name: "([^"]+)"$/);
    const versions = line.match(/^        versions: \[(.*)\]$/);
    const updateTypes = line.match(/^        update-types: \[(.*)\]$/);
    if (name) ignored.push({ name: name[1], versions: null, updateTypes: null });
    else if (versions && ignored.length) ignored.at(-1).versions = list(versions[1]);
    else if (updateTypes && ignored.length) ignored.at(-1).updateTypes = list(updateTypes[1]);
    else assert.fail(`unexpected line in the ignore block: ${line}`);
  }
  return ignored;
}

// Dependabot must not propose version updates past the holds above, or each weekly run opens a
// PR that fails these tests (as PR #361 did). Derives each expected range from the lockfile.
// Security updates are not covered by ignore rules; a security fix past a hold needs the hold lifted.
test('.github/dependabot.yml ignores the held runtime packages', () => {
  const held = (name) => [`>${locked('runtime', name)}`];
  assert.deepEqual(dependabotNpmIgnore('/runtime'), [
    { name: '*', versions: null, updateTypes: ['version-update:semver-major'] },
    { name: '@typescript-eslint/eslint-plugin', versions: held('@typescript-eslint/eslint-plugin'), updateTypes: null },
    { name: '@typescript-eslint/parser', versions: held('@typescript-eslint/parser'), updateTypes: null },
    { name: 'onnxruntime-node', versions: null, updateTypes: null },
  ]);
});

// Majors are deferred for the root package too: its npm entry ignores every semver-major update.
test('.github/dependabot.yml ignores semver-major updates for the root npm entry', () => {
  assert.deepEqual(dependabotNpmIgnore('/'), [
    { name: '*', versions: null, updateTypes: ['version-update:semver-major'] },
  ]);
});

// scripts/prepare-dast.mjs asserts the tsx version its staged runtime install resolves; it must
// match the runtime lockfile or the DAST preparation fails.
test('scripts/prepare-dast.mjs asserts the tsx version that runtime/package-lock.json resolves', () => {
  const source = readFileSync(path.join(ROOT, 'scripts/prepare-dast.mjs'), 'utf8');
  const pinned = source.match(/tsx\/package\.json'\)\)\)\.version, '([^']+)'/);
  assert.ok(pinned, 'the staged tsx version assertion is present in scripts/prepare-dast.mjs');
  assert.equal(pinned[1], locked('runtime', 'tsx'));
});
