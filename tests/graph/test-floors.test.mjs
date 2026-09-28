// Tests for scripts/check-test-floor.mjs and scripts/check-assertions.mjs (masterpiece REQ-M23, AC-M23.1).
// The declared test-floor lowering mechanism is specs/ops/payment-removal.md REQ-12, AC-11.
// The declared rename mechanism is specs/ops/one-platform-naming.md REQ-5, AC-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCounts, checkFloor, checkRatchet } from '../../scripts/check-test-floor.mjs';
import { hasAssertion } from '../../scripts/check-assertions.mjs';

const ROOT_OUT = 'ℹ tests 356\nℹ suites 0\nℹ pass 339\nℹ fail 0\nℹ cancelled 0\nℹ skipped 17\n';
const RUNTIME_OUT = ' Test Files  126 passed (126)\n      Tests  \x1b[32m1092 passed\x1b[39m | 2 skipped | 5 todo (1099)\n';
const floors = { root: 339, runtime: 1092 };

test('parses node --test and vitest summaries, including ANSI colour codes', () => {
  assert.deepEqual(parseCounts('root', ROOT_OUT), { passed: 339, failed: 0, total: 356 });
  assert.deepEqual(parseCounts('root', ROOT_OUT.replace(/ℹ/g, '#')), { passed: 339, failed: 0, total: 356 });
  assert.deepEqual(parseCounts('runtime', RUNTIME_OUT), { passed: 1092, failed: 0, total: 1099 });
});

test('a suite at its floor passes; one test fewer fails (a deleted test file drops the count)', () => {
  assert.equal(checkFloor('root', parseCounts('root', ROOT_OUT), floors), null);
  assert.match(checkFloor('root', parseCounts('root', ROOT_OUT.replace('pass 339', 'pass 338')), floors), /below the floor of 339/);
  assert.match(checkFloor('runtime', parseCounts('runtime', RUNTIME_OUT.replace('1092 passed', '1091 passed')), floors), /below the floor/);
});

test('any failure fails, and output with no count never reads as a pass', () => {
  assert.match(checkFloor('root', parseCounts('root', ROOT_OUT.replace('fail 0', 'fail 1')), floors), /1 test\(s\) failed/);
  assert.match(checkFloor('runtime', parseCounts('runtime', ' Tests  3 failed | 1092 passed (1095)\n'), floors), /3 test\(s\) failed/);
  assert.match(checkFloor('root', parseCounts('root', 'npm ERR! missing script\n'), floors), /no test count found/);
  assert.match(checkFloor('runtime', parseCounts('runtime', ''), floors), /no test count found/);
});

test('floors may only rise: lowering or removing one is refused', () => {
  assert.equal(checkRatchet(floors, { root: 339, runtime: 1100 }), null);
  assert.match(checkRatchet(floors, { root: 338, runtime: 1092 }), /root 339 -> 338/);
  assert.match(checkRatchet(floors, { root: 339 }), /runtime 1092 -> undefined/);
});

test('a declared lowering with a matching new entry passes and prints the LOWERED line (specs/ops/payment-removal.md#AC-11)', () => {
  const oldEntry = { suite: 'stratum', from: 1200, to: 1092, reason: 'past cycle', decision: 'ADR-old' };
  const newEntry = { suite: 'stratum', from: 1092, to: 1050, reason: 'billing tests removed', decision: 'ADR-0025' };
  const base = { root: 339, stratum: 1092, lowerings: [oldEntry] };
  // The base file's own (already-spent) entry rides along unchanged; only the new one counts.
  const current = { root: 339, stratum: 1050, lowerings: [oldEntry, newEntry] };
  const logs = [];
  assert.equal(checkRatchet(base, current, (line) => logs.push(line)), null);
  assert.deepEqual(logs, ['test floors: LOWERED stratum 1092 -> 1050: billing tests removed']);
});

test('a lowered floor with no lowerings entry is refused, exactly as before (specs/ops/payment-removal.md#AC-11)', () => {
  const base = { root: 339, stratum: 1092, lowerings: [] };
  const logs = [];
  assert.match(checkRatchet(base, { root: 339, stratum: 1050 }, (line) => logs.push(line)), /stratum 1092 -> 1050/);
  assert.match(checkRatchet(base, { root: 339, stratum: 1050, lowerings: [] }, (line) => logs.push(line)), /stratum 1092 -> 1050/);
  assert.deepEqual(logs, []);
});

test('an entry with the wrong suite, from or to does not authorize the lowering (specs/ops/payment-removal.md#AC-11)', () => {
  const base = { root: 339, stratum: 1092, lowerings: [] };
  const wrongSuite = [{ suite: 'root', from: 1092, to: 1050, reason: 'r', decision: 'd' }];
  const wrongFrom = [{ suite: 'stratum', from: 1090, to: 1050, reason: 'r', decision: 'd' }];
  const wrongTo = [{ suite: 'stratum', from: 1092, to: 1060, reason: 'r', decision: 'd' }];
  const logs = [];
  for (const lowerings of [wrongSuite, wrongFrom, wrongTo]) {
    assert.match(checkRatchet(base, { root: 339, stratum: 1050, lowerings }, (line) => logs.push(line)), /stratum 1092 -> 1050/);
  }
  assert.deepEqual(logs, []);
});

test('an entry already present in the base file cannot authorize a new lowering; no reuse (specs/ops/payment-removal.md#AC-11)', () => {
  const entry = { suite: 'stratum', from: 1200, to: 1092, reason: 'billing tests removed', decision: 'ADR-0025' };
  const base = { root: 339, stratum: 1200, lowerings: [entry] };
  const logs = [];
  assert.match(checkRatchet(base, { root: 339, stratum: 1092, lowerings: [entry] }, (line) => logs.push(line)), /stratum 1200 -> 1092/);
  assert.deepEqual(logs, []);
});

test('an entry with an empty or missing reason or decision does not authorize the lowering (specs/ops/payment-removal.md#AC-11)', () => {
  const base = { root: 339, stratum: 1092, lowerings: [] };
  const cases = [
    { suite: 'stratum', from: 1092, to: 1050, reason: '', decision: 'ADR-0025' },
    { suite: 'stratum', from: 1092, to: 1050, reason: '   ', decision: 'ADR-0025' },
    { suite: 'stratum', from: 1092, to: 1050, reason: 'billing tests removed', decision: '' },
    { suite: 'stratum', from: 1092, to: 1050, reason: 'billing tests removed' },
  ];
  const logs = [];
  for (const entry of cases) {
    assert.match(checkRatchet(base, { root: 339, stratum: 1050, lowerings: [entry] }, (line) => logs.push(line)), /stratum 1092 -> 1050/);
  }
  assert.deepEqual(logs, []);
});

test('a removed suite (no numeric head floor) is refused even with a same-shaped entry; only a real `to` number authorizes a lowering (specs/ops/payment-removal.md#AC-11)', () => {
  const base = { root: 339, stratum: 1092, lowerings: [] };
  const logs = [];
  assert.match(checkRatchet(base, { root: 339, lowerings: [{ suite: 'stratum', from: 1092, reason: 'r', decision: 'd' }] }, (line) => logs.push(line)), /stratum 1092 -> undefined/);
  assert.match(checkRatchet(base, { root: 339, stratum: null, lowerings: [{ suite: 'stratum', from: 1092, to: null, reason: 'r', decision: 'd' }] }, (line) => logs.push(line)), /stratum 1092 -> null/);
  assert.deepEqual(logs, []);
});

test('a raise needs no lowerings entry, passes and prints nothing extra, even with unrelated entries present (specs/ops/payment-removal.md#AC-11)', () => {
  const unrelated = { suite: 'stratum', from: 900, to: 1092, reason: 'r', decision: 'd' };
  const base = { root: 339, stratum: 1092, lowerings: [unrelated] };
  const logs = [];
  assert.equal(checkRatchet(base, { root: 340, stratum: 1200, lowerings: [unrelated] }, (line) => logs.push(line)), null);
  assert.equal(checkRatchet(base, { root: 339, stratum: 1092 }, (line) => logs.push(line)), null);
  assert.deepEqual(logs, []);
});

test('a declared rename authorizes a base key missing from current when its replacement meets the old floor (specs/ops/one-platform-naming.md#AC-5)', () => {
  const rename = { from: 'stratum', to: 'runtime', decision: 'ADR-0026' };
  const base = { root: 339, stratum: 1276, renames: [] };
  const current = { root: 339, runtime: 1276, renames: [rename] };
  const logs = [];
  assert.equal(checkRatchet(base, current, (line) => logs.push(line)), null);
  assert.deepEqual(logs, ['test floors: RENAMED stratum -> runtime: ADR-0026']);
});

test('a declared rename whose replacement floor is still below the old value is refused (specs/ops/one-platform-naming.md#AC-5)', () => {
  const rename = { from: 'stratum', to: 'runtime', decision: 'ADR-0026' };
  const base = { root: 339, stratum: 1276, renames: [] };
  const current = { root: 339, runtime: 1275, renames: [rename] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a base key missing from current with no renames entry at all still fails, exactly as before (specs/ops/one-platform-naming.md#AC-5)', () => {
  const base = { root: 339, stratum: 1276, renames: [] };
  const logs = [];
  assert.match(checkRatchet(base, { root: 339 }, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.match(checkRatchet(base, { root: 339, renames: [] }, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a rename already present in the base file cannot authorize a new rename; no reuse (specs/ops/one-platform-naming.md#AC-5)', () => {
  const rename = { from: 'stratum', to: 'runtime', decision: 'ADR-0026' };
  const base = { root: 339, stratum: 1276, renames: [rename] };
  const current = { root: 339, runtime: 1276, renames: [rename] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a rename already on the base file stays spent when only its decision wording changes (specs/ops/one-platform-naming.md#AC-5)', () => {
  const base = { root: 339, stratum: 1276, renames: [{ from: 'stratum', to: 'runtime', decision: 'ADR-0026' }] };
  const current = { root: 339, runtime: 1276, renames: [{ from: 'stratum', to: 'runtime', decision: 'ADR-0026, reworded' }] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a rename entry whose `from` does not match any base key does not authorize anything (specs/ops/one-platform-naming.md#AC-5)', () => {
  const base = { root: 339, stratum: 1276, renames: [] };
  const current = { root: 339, runtime: 1276, renames: [{ from: 'nonexistent', to: 'runtime', decision: 'ADR-0026' }] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a declared rename whose `to` already exists as a base-file key is refused, even though current[to] >= base[from] would otherwise satisfy it (specs/ops/one-platform-naming.md#AC-5)', () => {
  const rename = { from: 'stratum', to: 'runtime', decision: 'ADR-0026' };
  // `runtime` already has its own (lower) floor in base; the rename must not be allowed to
  // absorb `stratum`'s floor onto it, even though `runtime`'s own floor rises fine on its own
  // and current.runtime (1276) comfortably meets base.stratum (1276) too.
  const base = { root: 339, stratum: 1276, runtime: 100, renames: [] };
  const current = { root: 339, runtime: 1276, renames: [rename] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /stratum 1276 -> undefined/);
  assert.deepEqual(logs, []);
});

test('two declared renames that share the same `to` are both refused, even though each individually would satisfy every other condition (specs/ops/one-platform-naming.md#AC-5)', () => {
  const renameA = { from: 'a', to: 'c', decision: 'ADR-a' };
  const renameB = { from: 'b', to: 'c', decision: 'ADR-b' };
  const base = { root: 339, a: 10, b: 20, renames: [] };
  const current = { root: 339, c: 30, renames: [renameA, renameB] };
  const logs = [];
  const result = checkRatchet(base, current, (line) => logs.push(line));
  assert.match(result, /a 10 -> undefined/);
  assert.match(result, /b 20 -> undefined/);
  assert.deepEqual(logs, []);
});

test('two declared renames that share the same `from` are both refused, even though each individually would satisfy every other condition (specs/ops/one-platform-naming.md#AC-5)', () => {
  const renameA = { from: 'a', to: 'b', decision: 'ADR-a' };
  const renameB = { from: 'a', to: 'c', decision: 'ADR-b' };
  const base = { root: 339, a: 10, renames: [] };
  const current = { root: 339, b: 10, c: 10, renames: [renameA, renameB] };
  const logs = [];
  assert.match(checkRatchet(base, current, (line) => logs.push(line)), /a 10 -> undefined/);
  assert.deepEqual(logs, []);
});

test('a test file with no assertion is caught; comments do not count as assertions', () => {
  assert.equal(hasAssertion("import assert from 'node:assert';\ntest('x', () => { assert.equal(1, 1); });"), true);
  assert.equal(hasAssertion("test('x', () => { expect(1).toBe(1); });"), true);
  assert.equal(hasAssertion("test('x', () => { assert(ok); });"), true);
  assert.equal(hasAssertion("test('x', () => { /* expect(1) */ run(); });\n// assert.equal(1, 1)"), false);
  assert.equal(hasAssertion("test('x', () => { run(); });"), false);
});

test('both scripts still run when invoked through a symbolic link, so CI never gets a silent exit 0', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'floor-link-')));
  try {
    const scripts = path.join(import.meta.dirname, '..', '..', 'scripts');
    symlinkSync(path.join(scripts, 'check-test-floor.mjs'), path.join(dir, 'floor.mjs'));
    symlinkSync(path.join(scripts, 'check-assertions.mjs'), path.join(dir, 'assertions.mjs'));
    writeFileSync(path.join(dir, 'failing.log'), ROOT_OUT.replace('fail 0', 'fail 1'));
    writeFileSync(path.join(dir, 'empty.test.mjs'), "import { test } from 'node:test';\ntest('x', () => {});\n");
    const floor = spawnSync(process.execPath, [path.join(dir, 'floor.mjs'), 'root', path.join(dir, 'failing.log')], { encoding: 'utf8' });
    assert.equal(floor.status, 1, floor.stderr);
    const assertions = spawnSync(process.execPath, [path.join(dir, 'assertions.mjs'), path.join(dir, 'empty.test.mjs')], { encoding: 'utf8' });
    assert.equal(assertions.status, 1, assertions.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
