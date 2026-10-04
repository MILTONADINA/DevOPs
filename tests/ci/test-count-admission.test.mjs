// specs/ops/test-count-admission.md: synthetic counts, actual helpers and copied CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCounts, checkFloor } from '../../scripts/check-test-floor.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-test-floor.mjs');
const FLOORS = { root: 10, runtime: 10 };
const VALID = { passed: 10, failed: 0, total: 10 };
const MISSING = suite => `${suite}: no test count found in the output (refusing to report a pass)`;
const nodeLog = (passed, failed, total, marker = 'ℹ') => `${marker} tests ${total}\n${marker} pass ${passed}\n` +
  (failed === null ? '' : `${marker} fail ${failed}\n`);
const runtimeLog = (passed, total) => `      Tests  ${passed} passed | 2 skipped | 1 todo (${total})\n`;
const DIGITS = ['9007199254740992', '9'.repeat(400)];

function problem(suite, counts) {
  const result = checkFloor(suite, counts, FLOORS);
  assert.equal(typeof result, 'string', 'invalid counts must not return successful null');
  assert.ok(result.length > 0, 'a refusal must name a problem');
}

test('root failure count cannot be omitted from a parsed summary', () => {
  for (const marker of ['ℹ', '#']) {
    const counts = parseCounts('root', nodeLog(10, null, 10, marker));
    assert.deepEqual(counts, { passed: 10, failed: null, total: 10 });
    assert.equal(checkFloor('root', counts, FLOORS), MISSING('root'));
  }
});
test('each required null count retains the missing-count diagnostic', () => {
  for (const suite of ['root', 'runtime']) for (const key of ['passed', 'total', 'failed']) {
    assert.equal(checkFloor(suite, { ...VALID, [key]: null }, FLOORS), MISSING(suite));
  }
});
for (const field of ['passed', 'failed', 'total']) test(`invalid ${field} values cannot satisfy a floor`, () => {
  // Undefined is deliberately first: the old checker admits it for each of these fields.
  for (const value of [undefined, false, true, '10', -1, 10.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const suite of ['root', 'runtime']) problem(suite, { ...VALID, [field]: value });
  }
});
test('passed greater than total refuses under both parser formats', () => {
  for (const [suite, text] of [['root', nodeLog(10, 0, 9)], ['runtime', runtimeLog(10, 9)]]) {
    const counts = parseCounts(suite, text); assert.deepEqual(counts, { passed: 10, failed: 0, total: 9 });
    problem(suite, counts);
  }
});
test('digit-only unsafe and nonfinite parsed counts cannot report success', () => {
  for (const digits of DIGITS) for (const suite of ['root', 'runtime']) {
    const text = suite === 'root' ? nodeLog(digits, 0, digits) : runtimeLog(digits, digits);
    const counts = parseCounts(suite, text);
    assert.equal(counts.passed, Number(digits)); assert.equal(counts.total, Number(digits));
    assert.equal(counts.failed, 0); problem(suite, counts);
  }
});

// Mutation: dropping positive-failure refusal would admit these already-rejected sums.
test('passed plus positive failures above total still refuses (regression guard)', () => {
  for (const suite of ['root', 'runtime']) {
    problem(suite, { passed: 10, failed: 1, total: 10 });
    problem(suite, { passed: Number.MAX_SAFE_INTEGER, failed: 1, total: Number.MAX_SAFE_INTEGER });
  }
});
// Mutation: requiring an explicit zero-failed Vitest fragment or equality would reject native summaries.
test('supported root ANSI runtime and omitted runtime failure formats remain valid (regression guard)', () => {
  for (const marker of ['ℹ', '#']) {
    const counts = parseCounts('root', `\x1b[32m${nodeLog(10, 0, 13, marker)}\x1b[39m`);
    assert.deepEqual(counts, { passed: 10, failed: 0, total: 13 });
    assert.equal(checkFloor('root', counts, FLOORS), null);
  }
  const counts = parseCounts('runtime', ' Test Files 2 passed (2)\n      Tests  \x1b[32m10 passed\x1b[39m | 2 skipped | 1 todo (13)\n');
  assert.deepEqual(counts, { passed: 10, failed: 0, total: 13 });
  assert.equal(checkFloor('runtime', counts, FLOORS), null);
});
// Mutation: a positive-only or strict-upper-bound check would wrongly reject zero or MAX_SAFE_INTEGER.
test('zero safe maximum and above-floor values preserve their admissions (regression guard)', () => {
  for (const suite of ['root', 'runtime']) {
    assert.equal(checkFloor(suite, { passed: 0, failed: 0, total: 0 }, { [suite]: 0 }), null);
    assert.equal(checkFloor(suite, { passed: -0, failed: -0, total: -0 }, { [suite]: 0 }), null);
    assert.equal(checkFloor(suite, { passed: 0, failed: 0, total: 0 }, FLOORS), `${suite}: 0 passed, below the floor of 10`);
    assert.equal(checkFloor(suite, VALID, FLOORS), null);
    assert.equal(checkFloor(suite, { passed: 11, failed: 0, total: 14 }, FLOORS), null);
    assert.equal(checkFloor(suite, { passed: Number.MAX_SAFE_INTEGER, failed: 0, total: Number.MAX_SAFE_INTEGER }, FLOORS), null);
  }
});
// Mutation: changing genuine-failure/below-floor handling or the prior floor lookup breaks these messages.
test('valid failures below-floor and unknown-floor messages remain unchanged (regression guard)', () => {
  for (const suite of ['root', 'runtime']) {
    assert.equal(checkFloor(suite, { passed: 10, failed: 1, total: 11 }, FLOORS), `${suite}: 1 test(s) failed`);
    assert.equal(checkFloor(suite, { passed: 9, failed: 0, total: 10 }, FLOORS), `${suite}: 9 passed, below the floor of 10`);
    assert.equal(checkFloor(suite, { passed: null, failed: null, total: null }, {}), `no floor for suite "${suite}" in governance/test-floors.json`);
  }
});
// Mutation: changing to last-summary or rejecting duplicate summaries silently expands this finite repair.
test('existing first-matching-summary extraction remains unchanged (regression guard)', () => {
  assert.deepEqual(parseCounts('root', nodeLog(10, 0, 13) + nodeLog(1, 3, 4)), { passed: 10, failed: 0, total: 13 });
  assert.deepEqual(parseCounts('runtime', runtimeLog(10, 13) + ' Tests 1 passed | 3 failed (4)\n'), { passed: 10, failed: 0, total: 13 });
});

function withCLI(check) {
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(state, 'count-admission-'))), files = new Map();
  const original = readFileSync(SCRIPT);
  function put(name, data) {
    const file = path.join(dir, name); mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(data); writeFileSync(file, bytes); files.set(file, bytes); return file;
  }
  try {
    const script = put('scripts/check-test-floor.mjs', original);
    put('governance/test-floors.json', JSON.stringify(FLOORS) + '\n');
    const env = { PATH: '', HOME: dir, LANG: 'C', LC_ALL: 'C' };
    function launch(entry, args) {
      const r = spawnSync(process.execPath, [entry, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
      assert.equal(r.error, undefined, 'owned Node child must terminate'); assert.equal(r.signal, null);
      assert.doesNotMatch(r.stdout + r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|TypeError:|SyntaxError:|ReferenceError:/, 'native/setup failures are not admission evidence');
      for (const [file, bytes] of files) assert.deepEqual(readFileSync(file), bytes, 'each invocation leaves its owned inputs unchanged');
      return r;
    }
    check({ dir, script, put, launch, run: (suite, text, entry = script) => launch(entry, [suite, put('summary.log', text)]) });
  } finally {
    try {
      for (const [file, bytes] of files) assert.deepEqual(readFileSync(file), bytes, 'owned source/floor/log is unchanged');
      assert.deepEqual(readFileSync(SCRIPT), original, 'original checker is unchanged');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
function refused(r) {
  assert.equal(r.status, 1, 'invalid counts must not produce success');
  assert.equal(r.stdout, ''); assert.match(r.stderr, /^test floors: .+\n$/);
  assert.doesNotMatch(r.stderr, /PRIVATE_COUNT_SENTINEL/);
}

test('copied CLI refuses missing root failure with the existing message', () => withCLI(({ run }) => {
  for (const marker of ['ℹ', '#']) {
    const r = run('root', 'PRIVATE_COUNT_SENTINEL\n' + nodeLog(10, null, 10, marker));
    refused(r); assert.equal(r.stderr, `test floors: ${MISSING('root')}\n`);
  }
}));
test('copied CLI refuses impossible root and runtime totals without log excerpts', () => withCLI(({ run }) => {
  for (const [suite, text] of [['root', nodeLog(10, 0, 9)], ['runtime', runtimeLog(10, 9)]]) {
    refused(run(suite, 'PRIVATE_COUNT_SENTINEL\n' + text));
  }
}));
test('copied CLI refuses unsafe and overflowing decimal count text', () => withCLI(({ run }) => {
  for (const digits of DIGITS) for (const suite of ['root', 'runtime']) {
    refused(run(suite, 'PRIVATE_COUNT_SENTINEL\n' + (suite === 'root' ? nodeLog(digits, 0, digits) : runtimeLog(digits, digits))));
  }
}));
// Mutation: changing normal output or weakening real failure/floor handling breaks these preserved CLI results.
test('copied CLI preserves normal success genuine failure and below-floor output (regression guard)', () => withCLI(({ run }) => {
  for (const [suite, text] of [['root', nodeLog(10, 0, 13)], ['runtime', runtimeLog(10, 13)]]) {
    const r = run(suite, text); assert.equal(r.status, 0); assert.equal(r.stderr, '');
    assert.equal(r.stdout, `test floors: ${suite} 10 passed (floor 10), 0 failed, 13 total\n`);
  }
  const failed = run('root', nodeLog(10, 1, 11)); refused(failed);
  assert.equal(failed.stderr, 'test floors: root: 1 test(s) failed\n');
  const below = run('runtime', runtimeLog(9, 12)); refused(below);
  assert.equal(below.stderr, 'test floors: runtime: 9 passed, below the floor of 10\n');
}));
// Mutation: losing realpath entry dispatch or running CLI at import breaks these existing caller contracts.
test('copied CLI stays symlink-aware and import-safe (regression guard)', () => withCLI(({ dir, script, put, launch, run }) => {
  const link = path.join(dir, 'floor-link.mjs'); symlinkSync(script, link);
  const r = run('root', nodeLog(9, 0, 10), link); refused(r);
  assert.equal(r.stderr, 'test floors: root: 9 passed, below the floor of 10\n');
  const importer = put('import-only.mjs', `import { checkFloor } from ${JSON.stringify(pathToFileURL(script).href)};\nif (typeof checkFloor !== 'function') process.exitCode = 9;\n`);
  const imported = launch(importer, []); assert.equal(imported.status, 0);
  assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
}));
