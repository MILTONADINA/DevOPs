// specs/ops/ci-product-suites.md REQ-3: the runtime lint gate runs in CI with zero warnings allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const runtimePackage = JSON.parse(readFileSync(new URL('../runtime/package.json', import.meta.url), 'utf8'));

// The runtime-test job's text: from its key to the next top-level job key.
function job(name) {
  const start = ci.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  assert.ok(start >= 0, `ci.yml has no ${name} job`);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^  [a-z][\w-]*:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

test('the runtime lint script fails on any ESLint warning and on unformatted src (specs/ops/ci-product-suites.md#req-3--runtime-lint-gate-on-every-pr)', () => {
  assert.equal(runtimePackage.scripts.lint, 'eslint src --ext .ts --max-warnings 0 && prettier --check src');
});

test('the required runtime-test job runs the lint script in runtime/ (specs/ops/ci-product-suites.md#req-3--runtime-lint-gate-on-every-pr)', () => {
  const runtimeTest = job('runtime-test');
  assert.match(runtimeTest, /working-directory: runtime/);
  assert.match(runtimeTest, /^\s+- run: npm run lint\s*$/m);
  // Lint runs after the locked install, so it uses the pinned ESLint and Prettier.
  assert.ok(runtimeTest.indexOf('npm run lint') > runtimeTest.indexOf('npm ci'), 'npm run lint must come after npm ci');
});
