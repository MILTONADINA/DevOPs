// scripts/check-coverage-floor.mjs compares a vitest json-summary against
// governance/coverage-floor.json (specs/ops/ci-product-suites.md REQ-5).
// Summaries and floors here are synthetic toys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-coverage-floor.mjs');

function run(summary, floor) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cov-floor-'));
  try {
    const s = path.join(dir, 'coverage-summary.json');
    const f = path.join(dir, 'coverage-floor.json');
    writeFileSync(s, typeof summary === 'string' ? summary : JSON.stringify(summary));
    writeFileSync(f, typeof floor === 'string' ? floor : JSON.stringify(floor));
    return spawnSync(process.execPath, [SCRIPT, s, f], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const summary = (pct, total = 100) => ({ total: { lines: { total, covered: Math.round(total * pct / 100), skipped: 0, pct } } });

test('lines coverage below the floor fails', () => {
  const r = run(summary(86.9), { runtime: 87 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /86\.9.*below.*87/);
});

test('lines coverage exactly at the floor passes', () => {
  const r = run(summary(87), { runtime: 87 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /87.*floor.*87/);
});

test('lines coverage above the floor passes', () => {
  assert.equal(run(summary(93.2), { runtime: 87 }).status, 0);
});

test('a summary that is not JSON fails', () => {
  const r = run('{"total": ', { runtime: 87 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /malformed/);
});

test('a summary without total.lines.pct fails', () => {
  for (const bad of [{}, { total: {} }, { total: { lines: {} } }, { total: { lines: { pct: '90' } } }, { total: { lines: { pct: 120, total: 10 } } }, { total: { lines: { pct: -1, total: 10 } } }, [], null]) {
    const r = run(bad, { runtime: 87 });
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.match(r.stderr, /malformed/);
  }
});

test('a summary with zero measured lines fails, so an empty report never passes', () => {
  const r = run({ total: { lines: { total: 0, covered: 0, skipped: 0, pct: 100 } } }, { runtime: 87 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no lines/);
});

test('a malformed floor file fails', () => {
  for (const bad of ['not json', '{}', '{"runtime": "87"}', '{"runtime": -1}', '{"runtime": 101}', '{"runtime": null}', '[]']) {
    const r = run(summary(95), bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /floor/);
  }
});

test('missing arguments or missing files fail', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '/nonexistent/a.json', '/nonexistent/b.json'], { encoding: 'utf8' }).status, 1);
});

test('the committed floor file is well formed and the ratchet-friendly integer', () => {
  const floor = JSON.parse(readFileSync(path.join(ROOT, 'governance', 'coverage-floor.json'), 'utf8'));
  assert.ok(Number.isInteger(floor.runtime) && floor.runtime > 0 && floor.runtime <= 100);
});

test('the runtime coverage script and CI step are wired (specs/ops/ci-product-suites.md REQ-5)', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'runtime', 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:coverage'], /--coverage\.provider=v8/);
  assert.match(pkg.scripts['test:coverage'], /--coverage\.reporter=json-summary/);
  const vitest = JSON.parse(readFileSync(path.join(ROOT, 'runtime', 'package-lock.json'), 'utf8')).packages['node_modules/vitest'].version;
  assert.equal(pkg.devDependencies['@vitest/coverage-v8'], vitest);
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.search(/^ {2}runtime-test:/m)).split(/^ {2}validate:/m)[0];
  assert.match(job, /npm run test:coverage/);
  assert.match(job, /node \.\.\/scripts\/check-coverage-floor\.mjs coverage\/coverage-summary\.json \.\.\/governance\/coverage-floor\.json/);
});
