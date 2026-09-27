#!/usr/bin/env node
// Masterpiece REQ-M23: an emptied or shrunken suite never reads as PASS.
//
//   node scripts/check-test-floor.mjs <suite> <test-output-log>   (suite: root | stratum)
//   node scripts/check-test-floor.mjs --ratchet <base-floors.json>
//
// The first form parses node --test (root) or vitest (stratum) output and exits 1 when the
// passed count is below governance/test-floors.json's floor, when any test failed, or when
// no count can be found. The second exits 1 when any floor is lower than in the base file,
// unless the head file's `lowerings` array declares that exact drop with a new (not already
// on the base file), non-empty {suite, from, to, reason, decision} entry (specs/ops/
// payment-removal.md REQ-12). Every accepted lowering prints
// `test floors: LOWERED <suite> <from> -> <to>: <reason>`.
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
  if (suite === 'stratum') {
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
  if (counts.passed === null || counts.total === null) return `${suite}: no test count found in the output (refusing to report a pass)`;
  if (counts.failed) return `${suite}: ${counts.failed} test(s) failed`;
  if (counts.passed < floor) return `${suite}: ${counts.passed} passed, below the floor of ${floor}`;
  return null;
}

// specs/ops/payment-removal.md REQ-12: an entry already present in the base file's lowerings
// (compared field by field, so key order never matters) may not authorize a lowering again.
const loweringKey = (e) => JSON.stringify([e?.suite, e?.from, e?.to, e?.reason, e?.decision]);
const nonEmptyString = (s) => typeof s === 'string' && s.trim() !== '';

export function checkRatchet(base, current, log = (line) => console.log(line)) {
  const alreadyOnBase = new Set((Array.isArray(base.lowerings) ? base.lowerings : []).map(loweringKey));
  const declared = Array.isArray(current.lowerings) ? current.lowerings : [];
  const lowered = [];
  for (const suite of Object.keys(base)) {
    if (typeof base[suite] !== 'number') continue;
    if (typeof current[suite] === 'number' && current[suite] >= base[suite]) continue;
    // A suite with no numeric floor at all in the head file is removed, not lowered to a
    // value: no entry (however constructed) may authorize that, only a real `to` number.
    const entry = typeof current[suite] === 'number' && declared.find((e) => e && typeof e === 'object'
      && e.suite === suite && e.from === base[suite] && e.to === current[suite]
      && nonEmptyString(e.reason) && nonEmptyString(e.decision)
      && !alreadyOnBase.has(loweringKey(e)));
    if (entry) log(`test floors: LOWERED ${suite} ${base[suite]} -> ${current[suite]}: ${entry.reason}`);
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
