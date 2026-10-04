#!/usr/bin/env node
// Masterpiece REQ-M23: an emptied or shrunken suite never reads as PASS.
//
//   node scripts/check-test-floor.mjs <suite> <test-output-log>   (suite: root | runtime)
//   node scripts/check-test-floor.mjs --ratchet <base-floors.json>
//
// The first form parses node --test (root) or vitest (runtime) output and exits 1 when the
// passed count is below governance/test-floors.json's floor, when any test failed, or when
// no count can be found. The second exits 1 when any floor is lower than in the base file,
// unless the head file's `lowerings` array declares that exact drop with a new (not already
// on the base file), non-empty {suite, from, to, reason, decision} entry (specs/ops/
// payment-removal.md REQ-12); or unless a base key is missing from the head file entirely and
// the head file's `renames` array declares that with a new {from, to, decision} entry whose
// `to` (a) names a head key at or above the old floor, (b) is not itself already a base-file
// key (a rename may never absorb another suite's already-established floor), (c) shares
// neither its `from` nor its `to` with any other declared rename (a rename target is never
// ambiguous), and (d) is not already present on the base file's `renames` (specs/ops/
// one-platform-naming.md REQ-5). Every accepted lowering prints
// `test floors: LOWERED <suite> <from> -> <to>: <reason>`, and every accepted rename prints
// `test floors: RENAMED <from> -> <to>: <decision>`.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const FLOORS = path.join(import.meta.dirname, '..', 'governance', 'test-floors.json');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function parseCounts(suite, text) {
  const t = stripAnsi(text);
  if (suite === 'root') {
    const num = (key) => { const m = t.match(new RegExp(`^(?:ℹ|#) ${key} (\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
    return { passed: num('pass'), failed: num('fail'), total: num('tests') };
  }
  if (suite === 'runtime') {
    const line = (t.match(/^\s*Tests\s+(.+)$/m) || [])[1];
    if (!line) return { passed: null, failed: null, total: null };
    const n = (word) => { const m = line.match(new RegExp(`(\\d+) ${word}`)); return m ? Number(m[1]) : 0; };
    const total = (line.match(/\((\d+)\)/) || [])[1];
    return { passed: n('passed'), failed: n('failed'), total: total ? Number(total) : null };
  }
  throw new Error(`unknown suite: ${suite}`);
}

export function checkFloor(suite, counts, floors) {
  const floor = floors[suite];
  if (typeof floor !== 'number') return `no floor for suite "${suite}" in governance/test-floors.json`;
  if (counts.passed === null || counts.failed === null || counts.total === null) return `${suite}: no test count found in the output (refusing to report a pass)`;
  // specs/ops/test-count-admission.md: validate parsed values before accepting a floor.
  if ([counts.passed, counts.failed, counts.total].some(n => !Number.isSafeInteger(n) || n < 0)
      || counts.passed + counts.failed > counts.total) {
    return `${suite}: invalid or inconsistent test counts in the output (refusing to report a pass)`;
  }
  if (counts.failed) return `${suite}: ${counts.failed} test(s) failed`;
  if (counts.passed < floor) return `${suite}: ${counts.passed} passed, below the floor of ${floor}`;
  return null;
}

// specs/ops/payment-removal.md REQ-12: an entry already present in the base file's lowerings
// (compared field by field, so key order never matters) may not authorize a lowering again.
const loweringKey = (e) => JSON.stringify([e?.suite, e?.from, e?.to, e?.reason, e?.decision]);
// specs/ops/one-platform-naming.md REQ-5: the same non-reuse rule for a declared rename of a
// suite key, compared on {from, to} only, so rewording `decision` never makes a spent rename new.
const renameKey = (e) => JSON.stringify([e?.from, e?.to]);
const nonEmptyString = (s) => typeof s === 'string' && s.trim() !== '';

export function checkRatchet(base, current, log = (line) => console.log(line)) {
  const alreadyOnBase = new Set((Array.isArray(base.lowerings) ? base.lowerings : []).map(loweringKey));
  const declared = Array.isArray(current.lowerings) ? current.lowerings : [];
  const alreadyRenamedOnBase = new Set((Array.isArray(base.renames) ? base.renames : []).map(renameKey));
  const declaredRenames = Array.isArray(current.renames) ? current.renames : [];
  // specs/ops/one-platform-naming.md REQ-5: a rename target must be unambiguous. Two declared
  // renames that share a `from` or a `to` each disqualify one another (per-entry: a third,
  // non-colliding rename in the same array is unaffected), so a single floor can never be
  // claimed twice and two renames can never collapse onto one target.
  const fromCounts = new Map();
  const toCounts = new Map();
  for (const e of declaredRenames) {
    if (!e || typeof e !== 'object') continue;
    fromCounts.set(e.from, (fromCounts.get(e.from) || 0) + 1);
    toCounts.set(e.to, (toCounts.get(e.to) || 0) + 1);
  }
  const lowered = [];
  for (const suite of Object.keys(base)) {
    if (typeof base[suite] !== 'number') continue;
    if (typeof current[suite] === 'number' && current[suite] >= base[suite]) continue;
    if (typeof current[suite] === 'number') {
      // Present but lower: only a declared `lowerings` entry may authorize this (unchanged).
      const entry = declared.find((e) => e && typeof e === 'object'
        && e.suite === suite && e.from === base[suite] && e.to === current[suite]
        && nonEmptyString(e.reason) && nonEmptyString(e.decision)
        && !alreadyOnBase.has(loweringKey(e)));
      if (entry) log(`test floors: LOWERED ${suite} ${base[suite]} -> ${current[suite]}: ${entry.reason}`);
      else lowered.push(suite);
      continue;
    }
    // Missing entirely (not just lowered to a present value) is normally always a failure too,
    // unless a declared `renames` entry names this key as its `from` and a present head key,
    // raised to at least the old floor, as its `to`: the floor carries over under the new name
    // instead of being spent again. Acceptance needs all five conditions (specs/ops/
    // one-platform-naming.md REQ-5): (1) `from` names this base suite and is absent from head;
    // (2) `to` is not itself a base-file key, so a rename can never absorb another suite's
    // already-established floor; (3) no other declared rename shares this entry's `from` or
    // `to`, so the target is never ambiguous; (4) the head key named by `to` meets or beats the
    // old floor; (5) this exact entry is not already spent on the base file.
    const rename = declaredRenames.find((e) => e && typeof e === 'object'
      && e.from === suite && !Object.hasOwn(base, e.to)
      && fromCounts.get(e.from) === 1 && toCounts.get(e.to) === 1
      && typeof current[e.to] === 'number' && current[e.to] >= base[suite]
      && nonEmptyString(e.decision) && !alreadyRenamedOnBase.has(renameKey(e)));
    if (rename) log(`test floors: RENAMED ${suite} -> ${rename.to}: ${rename.decision}`);
    else lowered.push(suite);
  }
  return lowered.length ? `floors may only rise; lowered or removed: ${lowered.map((k) => `${k} ${base[k]} -> ${current[k]}`).join(', ')}` : null;
}

// Compare real paths, so a symlinked invocation runs; an unresolvable argv[1] means "imported".
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const floors = JSON.parse(readFileSync(FLOORS, 'utf8'));
  const [first, second] = process.argv.slice(2);
  let problem;
  if (first === '--ratchet') {
    let lowerings = 0;
    problem = checkRatchet(JSON.parse(readFileSync(second, 'utf8')), floors, (line) => { lowerings += 1; console.log(line); });
    if (!problem && lowerings === 0) console.log('test floors: no floor lowered');
  } else {
    const counts = parseCounts(first, readFileSync(second, 'utf8'));
    problem = checkFloor(first, counts, floors);
    if (!problem) console.log(`test floors: ${first} ${counts.passed} passed (floor ${floors[first]}), ${counts.failed} failed, ${counts.total} total`);
  }
  if (problem) { console.error(`test floors: ${problem}`); process.exit(1); }
}
