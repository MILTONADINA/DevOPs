// Tests for scripts/check-test-floor.mjs and scripts/check-assertions.mjs (masterpiece REQ-M23, AC-M23.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCounts, checkFloor, checkRatchet } from '../../scripts/check-test-floor.mjs';
import { hasAssertion } from '../../scripts/check-assertions.mjs';

const ROOT_OUT = 'ℹ tests 356\nℹ suites 0\nℹ pass 339\nℹ fail 0\nℹ cancelled 0\nℹ skipped 17\n';
const STRATUM_OUT = ' Test Files  126 passed (126)\n      Tests  \x1b[32m1092 passed\x1b[39m | 2 skipped | 5 todo (1099)\n';
const floors = { root: 339, stratum: 1092 };

test('parses node --test and vitest summaries, including ANSI colour codes', () => {
  assert.deepEqual(parseCounts('root', ROOT_OUT), { passed: 339, failed: 0, total: 356 });
  assert.deepEqual(parseCounts('root', ROOT_OUT.replace(/ℹ/g, '#')), { passed: 339, failed: 0, total: 356 });
  assert.deepEqual(parseCounts('stratum', STRATUM_OUT), { passed: 1092, failed: 0, total: 1099 });
});

test('a suite at its floor passes; one test fewer fails (a deleted test file drops the count)', () => {
  assert.equal(checkFloor('root', parseCounts('root', ROOT_OUT), floors), null);
  assert.match(checkFloor('root', parseCounts('root', ROOT_OUT.replace('pass 339', 'pass 338')), floors), /below the floor of 339/);
  assert.match(checkFloor('stratum', parseCounts('stratum', STRATUM_OUT.replace('1092 passed', '1091 passed')), floors), /below the floor/);
});

test('any failure fails, and output with no count never reads as a pass', () => {
  assert.match(checkFloor('root', parseCounts('root', ROOT_OUT.replace('fail 0', 'fail 1')), floors), /1 test\(s\) failed/);
  assert.match(checkFloor('stratum', parseCounts('stratum', ' Tests  3 failed | 1092 passed (1095)\n'), floors), /3 test\(s\) failed/);
  assert.match(checkFloor('root', parseCounts('root', 'npm ERR! missing script\n'), floors), /no test count found/);
  assert.match(checkFloor('stratum', parseCounts('stratum', ''), floors), /no test count found/);
});

test('floors may only rise: lowering or removing one is refused', () => {
  assert.equal(checkRatchet(floors, { root: 339, stratum: 1100 }), null);
  assert.match(checkRatchet(floors, { root: 338, stratum: 1092 }), /root 339 -> 338/);
  assert.match(checkRatchet(floors, { root: 339 }), /stratum 1092 -> undefined/);
});

test('a test file with no assertion is caught; comments do not count as assertions', () => {
  assert.equal(hasAssertion("import assert from 'node:assert';\ntest('x', () => { assert.equal(1, 1); });"), true);
  assert.equal(hasAssertion("test('x', () => { expect(1).toBe(1); });"), true);
  assert.equal(hasAssertion("test('x', () => { assert(ok); });"), true);
  assert.equal(hasAssertion("test('x', () => { /* expect(1) */ run(); });\n// assert.equal(1, 1)"), false);
  assert.equal(hasAssertion("test('x', () => { run(); });"), false);
});
