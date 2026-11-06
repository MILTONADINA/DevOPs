// GitHub issue #209 (weekly dependency report): the non-major updates it lists are applied in
// the committed lockfiles and its major updates are not. Reads the lockfiles only, so no install
// is needed. A later release on the same major also passes, so a future non-major bump does not
// break this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = { root: '.' };
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
];
for (const [dir, name, major] of DEFERRED_MAJOR) {
  test(`${dir} lockfile keeps ${name} on major ${major} (issue #209 major update deferred)`, () => {
    assert.equal(locked(dir, name)?.split('.')[0], major);
  });
}
