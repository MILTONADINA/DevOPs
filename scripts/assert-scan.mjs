#!/usr/bin/env node
// specs/security/ci-semgrep-scan.md REQ-2..5; masterpiece REQ-M14.
// Usage: node scripts/assert-scan.mjs REPORT FLOOR STATUS
// Reads only the supplied report and finite floor configuration; never runs a scan.
import { readFileSync, statSync } from 'node:fs';

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// JSON escapes C0 controls; also escape C1 controls and Unicode line separators.
const escapedJson = (value) => JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const escapedText = (value) => escapedJson(String(value ?? '?')).slice(1, -1);

function readInput(file, category) {
  try {
    requireValue(statSync(file).isFile(), 'input must be a regular file');
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${category}: ${error.message}`);
  }
}

function parseFloor(text) {
  // Finite YAML subset: blank/full-comment lines and one semgrep: positive integer.
  const entries = text.split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  requireValue(entries.length === 1, 'floor configuration requires exactly one semgrep entry');
  const match = /^semgrep:[ \t]+([1-9][0-9]*)$/.exec(entries[0]);
  requireValue(match, 'floor configuration requires semgrep: a positive decimal integer without leading zeros');
  const floor = Number(match[1]);
  requireValue(Number.isSafeInteger(floor), 'floor configuration requires a safe integer');
  return floor;
}

function scannedPaths(report) {
  requireValue(isObject(report.paths), 'report paths must be an object');
  requireValue(Array.isArray(report.paths.scanned), 'report paths.scanned must be an array');
  const unique = new Set();
  for (const file of report.paths.scanned) {
    requireValue(typeof file === 'string' && file.length > 0
      && !file.includes('\\') && !file.includes('\0')
      && file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      'report scanned path must be a nonempty normalized project-relative POSIX string');
    requireValue(!unique.has(file), 'report scanned paths contain a duplicate; paths must be unique');
    unique.add(file);
  }
  return [...unique];
}

const args = process.argv.slice(2);
const statusValid = typeof args[2] === 'string' && args[2] !== '' && !/[^0-9]/.test(args[2])
  && Number.isInteger(Number(args[2])) && Number(args[2]) <= 255;
const scannerStatus = statusValid ? Number(args[2]) : null;
// Capture this before argument/file validation so no checker failure erases it.
const failureStatus = scannerStatus || 1;

try {
  requireValue(args.length === 3, 'usage: assert-scan.mjs REPORT FLOOR STATUS requires exactly three arguments');
  requireValue(statusValid, 'scanner status must be a decimal integer from 0 through 255');
  let report;
  try {
    report = JSON.parse(readInput(args[0], 'report'));
  } catch (error) {
    throw new Error(`report JSON: ${error.message}`);
  }
  requireValue(isObject(report), 'report must be a JSON object');
  requireValue(Array.isArray(report.results), 'report results must be an array');
  requireValue(Array.isArray(report.errors), 'report errors must be an array');
  for (const error of report.errors) console.log(`SCAN_DIAGNOSTIC ${escapedJson(error)}`);
  for (const result of report.results) {
    console.log(`FINDING ${escapedText(result?.extra?.severity)} ${escapedText(result?.check_id)} ${escapedText(result?.path)}:${escapedText(result?.start?.line)}`);
  }
  const paths = scannedPaths(report);
  const floor = parseFloor(readInput(args[1], 'floor configuration'));
  console.log(`semgrep: exit ${scannerStatus}, ${paths.length} files scanned, ${report.results.length} findings, ${report.errors.length} errors, floor ${floor}`);

  const problems = [];
  if (paths.length === 0) problems.push('no files scanned: refusing to report a pass');
  if (paths.length < floor) problems.push(`scanned count is below floor ${floor}`);
  for (const tree of ['tests/', 'runtime/test/']) {
    if (!paths.some((file) => file.startsWith(tree))) problems.push(`no scanned file under ${tree}`);
  }
  if (report.results.length) problems.push('scanner reported findings');
  if (report.errors.length) problems.push('scanner reported errors');
  if (scannerStatus) problems.push(`scanner exited with status ${scannerStatus}`);
  requireValue(problems.length === 0, problems.join('; '));
} catch (error) {
  console.error(`assert-scan: ${escapedText(error.message)}`);
  process.exitCode = failureStatus;
}
