// specs/ops/runtime-count-tokens.md: validate selected payload tokens, not log authenticity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCounts, checkFloor } from '../../scripts/check-test-floor.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-test-floor.mjs');
const FLOORS = { root: 10, runtime: 10 };
const EMPTY = { passed: null, failed: null, total: null };
const MISSING = 'runtime: no test count found in the output (refusing to report a pass)';
const log = payload => `      Tests  ${payload}\n`;
function invalid(payload) {
  const counts = parseCounts('runtime', log(payload));
  assert.deepEqual(counts, EMPTY, 'the complete selected payload must be valid');
  assert.equal(checkFloor('runtime', counts, FLOORS), MISSING);
}

test('signed fractional exponent and prefixed passed numbers are not unsigned tokens', () => {
  for (const token of ['-10', '+10', '1.10', '.10', '1e10', '0x10', '10_10']) invalid(`${token} passed (10)`);
});
test('an invalid present failed fragment cannot silently become zero', () => {
  for (const fragment of ['-0 failed', '+0 failed', '0.0 failed', 'NaN failed', 'zero failed', 'failed']) {
    invalid(`10 passed | ${fragment} (10)`);
  }
});
test('ignored native metadata still requires a valid unsigned fragment', () => {
  for (const fragment of ['-2 skipped', '1.0 todo', '+0 expected fail', '2 expected  fail', '٢ skipped', '1 mystery']) {
    invalid(`10 passed | ${fragment} (12)`);
  }
});
test('unknown labels and payload junk cannot surround a valid count substring', () => {
  for (const payload of ['junk 10 passed (10)', '10 passed (10) PRIVATE_RUNTIME_SENTINEL',
    '10 passed | 0 Failed (10)', '10 Passed (10)', '10 passed | mystery (10)',
    '10 passed (10) (10)', '10 passed (10)\u00a0', 'no tests']) invalid(payload);
});
test('pipes require exactly one nonempty fragment on each side', () => {
  for (const payload of ['10 passed || 2 skipped (12)', '| 10 passed (10)',
    '10 passed | (10)', '10 passed | | 0 failed (10)', '(10)']) invalid(payload);
});
test('number-label spaces and the pre-total separator follow the finite grammar', () => {
  for (const payload of ['10 passed | 0  failed (10)', '10 passed | 0\tfailed (10)',
    '10  passed (10)', '10\tpassed (10)', '10 passed | 0 expected\tfail (10)',
    '10 passed(10)', '10 passed\u00a0(10)', '10 passed |\u00a00 failed (10)']) invalid(payload);
});
test('the total is one terminal unsigned decimal group', () => {
  for (const payload of ['10 passed (10) extra', '10 passed (+10)', '10 passed (-10)',
    '10 passed (1.10)', '10 passed (1e10)', '10 passed (١٠)', '10 passed ()',
    '10 passed ( 10)', '10 passed (10 )', '10 passed 10', '10 passed (10']) invalid(payload);
});
test('a malformed later duplicate cannot hide behind the first valid label', () => {
  for (const payload of ['10 passed | -1 passed (10)', '10 passed | 0 failed | NaN failed (10)',
    '10 passed | 1 skipped | -1 skipped (11)']) invalid(payload);
});
test('a malformed selected payload is not rescued by a later valid summary', () => {
  const text = log('10 passed | unknown (10)') + log('10 passed (10)');
  assert.deepEqual(parseCounts('runtime', text), EMPTY);
  assert.equal(checkFloor('runtime', parseCounts('runtime', text), FLOORS), MISSING);
});

// Mutation: fixed order, strict pipe spacing or rejecting native labels/ANSI/CR breaks supported output.
test('native labels leading zeros horizontal whitespace and ANSI remain supported (regression guard)', () => {
  const text = ' Test Files 2 passed (2)\r\n' +
    ' \tTests \t\x1b[32m002 skipped| 010 passed\x1b[39m \t|03 expected fail|0 failed|1 todo \t(016)\t\r\n';
  const counts = parseCounts('runtime', text);
  assert.deepEqual(counts, { passed: 10, failed: 0, total: 16 });
  assert.equal(checkFloor('runtime', counts, FLOORS), null);
  assert.deepEqual(parseCounts('runtime', log('0 failed | 10 passed (10)')), { passed: 10, failed: 0, total: 10 });
});
// Mutation: requiring both count labels or treating "no tests" as numeric zero changes prior outcomes.
test('valid omitted labels numeric zero and no-tests refusal retain their meanings (regression guard)', () => {
  for (const [payload, expected] of [
    ['10 passed (10)', { passed: 10, failed: 0, total: 10 }],
    ['2 skipped | 1 todo (3)', { passed: 0, failed: 0, total: 3 }],
    ['3 expected fail (3)', { passed: 0, failed: 0, total: 3 }],
    ['1 failed (1)', { passed: 0, failed: 1, total: 1 }],
    ['0 passed (0)', { passed: 0, failed: 0, total: 0 }],
  ]) assert.deepEqual(parseCounts('runtime', log(payload)), expected);
  const zero = parseCounts('runtime', log('0 passed (0)'));
  assert.equal(checkFloor('runtime', zero, { runtime: 0 }), null);
  assert.equal(checkFloor('runtime', zero, FLOORS), 'runtime: 0 passed, below the floor of 10');
  assert.equal(checkFloor('runtime', parseCounts('runtime', log('no tests')), FLOORS), MISSING);
});
// Mutation: changing duplicate selection or validating/reconciling ignored metadata widens this repair.
test('first duplicate values and ignored metadata keep their existing semantics (regression guard)', () => {
  const huge = '9'.repeat(400);
  for (const payload of ['10 passed | 11 passed | 0 failed | 2 failed (12)',
    `10 passed | ${huge} passed | 0 failed | ${huge} failed | ${huge} skipped | 99 todo (10)`]) {
    const counts = parseCounts('runtime', log(payload));
    assert.deepEqual(counts, { passed: 10, failed: 0, total: payload.endsWith('(12)') ? 12 : 10 });
    assert.equal(checkFloor('runtime', counts, FLOORS), null);
  }
  assert.deepEqual(parseCounts('runtime', log('10 passed (10)') + log('bad later payload')), { passed: 10, failed: 0, total: 10 });
});
// Mutation: rejecting lexical digit length, bypassing count admission or changing root parsing breaks these.
test('returned counts still use the existing safe-value guard and root parser (regression guard)', () => {
  for (const digits of ['9007199254740992', '9'.repeat(400)]) {
    const counts = parseCounts('runtime', log(`${digits} passed (${digits})`));
    assert.deepEqual(counts, { passed: Number(digits), failed: 0, total: Number(digits) });
    assert.equal(typeof checkFloor('runtime', counts, FLOORS), 'string');
  }
  assert.equal(typeof checkFloor('runtime', parseCounts('runtime', log('10 passed (9)')), FLOORS), 'string');
  const maximum = String(Number.MAX_SAFE_INTEGER);
  assert.equal(checkFloor('runtime', parseCounts('runtime', log(`${maximum} passed (${maximum})`)), FLOORS), null);
  for (const marker of ['#', 'ℹ']) assert.deepEqual(parseCounts('root', `${marker} tests 13\n${marker} pass 10\n${marker} fail 0\n`), { passed: 10, failed: 0, total: 13 });
});

function withCLI(check) {
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(state, 'runtime-token-'))), files = new Map();
  const original = readFileSync(SCRIPT);
  function put(name, data) {
    const file = path.join(dir, name); mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(data); writeFileSync(file, bytes); files.set(file, bytes); return file;
  }
  try {
    const script = put('scripts/check-test-floor.mjs', original);
    put('governance/test-floors.json', JSON.stringify(FLOORS) + '\n');
    function run(text) {
      const r = spawnSync(process.execPath, [script, 'runtime', put('summary.log', text)], {
        cwd: dir, env: { PATH: '', HOME: dir, LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
      });
      assert.equal(r.error, undefined, 'owned Node child must terminate'); assert.equal(r.signal, null);
      assert.doesNotMatch(r.stdout + r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|TypeError:|SyntaxError:|ReferenceError:/, 'native failures cannot witness rejection');
      for (const [file, bytes] of files) assert.deepEqual(readFileSync(file), bytes, 'each invocation leaves inputs unchanged');
      return r;
    }
    check(run);
  } finally {
    try {
      for (const [file, bytes] of files) assert.deepEqual(readFileSync(file), bytes);
      assert.deepEqual(readFileSync(SCRIPT), original);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
function rejected(r) {
  assert.equal(r.status, 1, 'invalid runtime payload must not pass'); assert.equal(r.stdout, '');
  assert.equal(r.stderr, `test floors: ${MISSING}\n`);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE_RUNTIME_SENTINEL/);
}

test('copied CLI refuses malformed count tokens without echoing payloads', () => withCLI(run => {
  for (const payload of ['-10 passed (10)', '1.10 passed (10)', '1e10 passed (10)', '10 passed | NaN failed (10)',
    '10 passed | -2 skipped (12)', '10 passed (10) PRIVATE_RUNTIME_SENTINEL']) {
    rejected(run('PRIVATE_RUNTIME_SENTINEL\n' + log(payload)));
  }
}));
test('copied CLI cannot recover from a malformed selected payload using later output', () => withCLI(run => {
  rejected(run(log('10 passed | unknown (10)') + log('10 passed (10)')));
}));
// Mutation: altering successful/genuine-failure output or requiring a failed0 fragment breaks native compatibility.
test('copied CLI retains native success and genuine failure diagnostics (regression guard)', () => withCLI(run => {
  const good = run(log('10 passed | 2 skipped | 1 todo (13)'));
  assert.equal(good.status, 0); assert.equal(good.stderr, '');
  assert.equal(good.stdout, 'test floors: runtime 10 passed (floor 10), 0 failed, 13 total\n');
  const failed = run(log('10 passed | 1 failed (11)'));
  assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
  assert.equal(failed.stderr, 'test floors: runtime: 1 test(s) failed\n');
}));
