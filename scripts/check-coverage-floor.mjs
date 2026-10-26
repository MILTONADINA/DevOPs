#!/usr/bin/env node
// specs/ops/ci-product-suites.md REQ-5: fail when the runtime's total line coverage is below
// governance/coverage-floor.json, or when either input is missing or malformed.
//
//   node scripts/check-coverage-floor.mjs <coverage-summary.json> <coverage-floor.json>
import { readFileSync } from 'node:fs';

const fail = (msg) => { console.error(`coverage floor: ${msg}`); process.exit(1); };
const readJson = (file, what) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return fail(`malformed or unreadable ${what} ${file}: ${e.message}`); }
};
const pct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

const [summaryFile, floorFile] = process.argv.slice(2);
if (!summaryFile || !floorFile) fail('usage: check-coverage-floor.mjs <coverage-summary.json> <coverage-floor.json>');

const floors = readJson(floorFile, 'floor file');
const floor = floors?.runtime;
if (!pct(floor)) fail(`floor file ${floorFile} needs a "runtime" number from 0 to 100`);

const lines = readJson(summaryFile, 'summary')?.total?.lines;
if (!pct(lines?.pct)) fail(`malformed summary ${summaryFile}: total.lines.pct is not a number from 0 to 100`);
if (!(lines.total > 0)) fail(`summary ${summaryFile} measured no lines (refusing to report a pass)`);

if (lines.pct < floor) fail(`${lines.pct}% of lines covered, below the floor of ${floor}%`);
console.log(`coverage floor: ${lines.pct}% of lines covered, at or above the floor of ${floor}%`);
