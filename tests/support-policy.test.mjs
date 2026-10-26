// Support and end-of-life policy docs (specs/release/npm-package.md REQ-12 / AC-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const section = () => {
  const m = read('docs/RELEASING.md').match(/^## Support and end-of-life\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(m, 'docs/RELEASING.md has a "Support and end-of-life" section');
  return m[1];
};

test('RELEASING.md states the latest-minor, 90-day and Node-floor rules (specs/release/npm-package.md#ac-15)', () => {
  const s = section();
  assert.match(s, /latest minor/i);
  assert.match(s, /previous minor[^.]*security[- ]only[^.]*90 days/i);
  assert.match(s, /Node\.js floor[^.]*only in a minor[^.]*CHANGELOG/i);
});

test('the Node floor in the policy equals package.json engines.node (specs/release/npm-package.md#ac-15)', () => {
  const engines = JSON.parse(read('package.json')).engines.node;
  const stated = section().match(/`(>=\d+\.\d+\.\d+)`/);
  assert.ok(stated, 'the section names the floor in backticks');
  assert.equal(stated[1], engines);
});

test('SECURITY.md links to the policy section (specs/release/npm-package.md#ac-15)', () => {
  assert.match(read('SECURITY.md'), /\]\(docs\/RELEASING\.md#support-and-end-of-life\)/);
});
