#!/usr/bin/env node
// Masterpiece REQ-M23: an emptied or shrunken suite never reads as PASS.
//
//   node scripts/check-test-floor.mjs <suite> <test-output-log>   (suite: root | stratum)
//   node scripts/check-test-floor.mjs --ratchet <base-floors.json>
//
// The first form parses node --test (root) or vitest (stratum) output and exits 1 when the
// passed count is below governance/test-floors.json's floor, when any test failed, or when
// no count can be found. The second exits 1 when any floor is lower than in the base file.
import { readFileSync } from 'node:fs';
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

export function checkRatchet(base, current) {
  const lowered = Object.keys(base).filter((k) => typeof base[k] === 'number' && !(typeof current[k] === 'number' && current[k] >= base[k]));
  return lowered.length ? `floors may only rise; lowered or removed: ${lowered.map((k) => `${k} ${base[k]} -> ${current[k]}`).join(', ')}` : null;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const floors = JSON.parse(readFileSync(FLOORS, 'utf8'));
  const [first, second] = process.argv.slice(2);
  let problem;
  if (first === '--ratchet') {
    problem = checkRatchet(JSON.parse(readFileSync(second, 'utf8')), floors);
    if (!problem) console.log('test floors: no floor lowered');
  } else {
    const counts = parseCounts(first, readFileSync(second, 'utf8'));
    problem = checkFloor(first, counts, floors);
    if (!problem) console.log(`test floors: ${first} ${counts.passed} passed (floor ${floors[first]}), ${counts.failed} failed, ${counts.total} total`);
  }
  if (problem) { console.error(`test floors: ${problem}`); process.exit(1); }
}
