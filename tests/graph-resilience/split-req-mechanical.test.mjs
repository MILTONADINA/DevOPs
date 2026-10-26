// Behaviour checks for the mechanical halves of REQ-M8, M9, M10, M14 and M21 after their split
// (specs/graph/M-masterpiece-standard.md). Each test runs the real script or reads the real schema
// and workflow on synthetic inputs, so it fails when the stated behaviour changes, not when a file
// merely exists. Fixtures live under the scratch temp dir; nothing in the checkout is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const CI = read('.github/workflows/ci.yml');

function scratch(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'split-req-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function node(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}

// ---- REQ-M8: the spec-status lint -------------------------------------------------------------

function specProject(specs, baseline, run) {
  scratch((root) => {
    mkdirSync(path.join(root, 'specs'));
    mkdirSync(path.join(root, 'governance'));
    for (const [name, status] of Object.entries(specs)) writeFileSync(path.join(root, 'specs', name), `# Toy\n\n${status}\n\n## Requirements\n`);
    writeFileSync(path.join(root, 'governance/traceability-baseline.json'), JSON.stringify({ spec_status: baseline }));
    run((...extra) => node([path.join(ROOT, 'scripts/lint-spec-status.mjs'), '--root', root, ...extra], root), root);
  });
}

test('REQ-M8: a Status outside draft|approved|implemented|superseded fails and names the file', () => {
  specProject({ 'good.md': '**Status**: approved', 'bad.md': '**Status**: AUTHORED 2026-09-10', 'none.md': 'no status here' }, [], (lint) => {
    const result = lint();
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /specs\/bad\.md/);
    assert.match(result.stderr, /specs\/none\.md/);
    assert.doesNotMatch(result.stderr, /specs\/good\.md/);
  });
});

test('REQ-M8: both bold forms and an optional parenthetical note are accepted, a prefix of a word is not', () => {
  specProject({ 'a.md': '**Status**: draft', 'b.md': '**Status:** implemented (toy note)', 'c.md': '**Status**: approved for implementation' }, [], (lint) => {
    const result = lint();
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /specs\/c\.md/);
    assert.doesNotMatch(result.stderr, /specs\/[ab]\.md/);
  });
  specProject({ 'a.md': '**Status**: draft', 'b.md': '**Status:** superseded (toy note)' }, [], (lint) => assert.equal(lint().status, 0));
});

test('REQ-M8: the baseline absorbs only listed specs, and may only shrink against the base', () => {
  specProject({ 'old.md': '**Status**: AUTHORED' }, ['specs/old.md'], (lint, root) => {
    assert.equal(lint().status, 0);
    const base = path.join(root, 'base.json');
    writeFileSync(base, JSON.stringify({ spec_status: [] }));
    const grown = lint('--ratchet', base);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /baseline grew: specs\/old\.md/);
  });
  specProject({ 'new.md': '**Status**: AUTHORED' }, [], (lint) => assert.equal(lint().status, 1));
});

test('REQ-M8: ci.yml runs the lint and the baseline ratchet', () => {
  assert.match(CI, /run: node scripts\/lint-spec-status\.mjs\n/);
  assert.match(CI, /node scripts\/lint-spec-status\.mjs --ratchet "\$RUNNER_TEMP\/base-traceability\.json"/);
});

// ---- REQ-M9: validator schema and exit codes ---------------------------------------------------

test('REQ-M9: the schema enforces description maxLength 280 and requires proof.red for implementation and test claims', () => {
  const schema = parse(read('verification/claim-schema.yml'));
  const claim = schema.properties.claim;
  assert.equal(claim.properties.description.maxLength, 280);
  assert.ok(claim.required.includes('spec_ref'));
  const text = read('verification/claim-schema.yml');
  assert.match(text, /if:[\s\S]*?type:[\s\S]*?enum: \[implementation, test\][\s\S]*?then:[\s\S]*?required: \[red\]/);
});

test('REQ-M9: --claim for a missing claim and --all over an empty set both exit non-zero', () => {
  scratch((cwd) => {
    assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
    const validator = path.join(ROOT, 'verification/claim-validator.ts');
    for (const args of [['--claim', 'claim-2026-01-01-001', '--no-rerun'], ['--all', '--no-rerun']]) {
      const result = node([TSX, validator, ...args], cwd);
      assert.notEqual(result.status, 0, `${args.join(' ')}: ${result.output}`);
      assert.doesNotMatch(result.output, /valid\b.*claims? valid|claims valid/, 'an empty or missing set must not report success');
      assert.doesNotMatch(result.output, /MODULE_NOT_FOUND|Cannot find module|TypeError:/, 'a crash is not a refusal');
    }
  });
});

test('REQ-M9: ci.yml validates the committed proof set without replay', () => {
  assert.match(CI, /run: npx --no-install tsx verification\/claim-validator\.ts --all --no-rerun/);
});

// ---- REQ-M10: the state vocabulary and the readiness lint --------------------------------------

test('REQ-M10: the claim schema carries the closed state vocabulary, optional, in the specified order', () => {
  const claim = parse(read('verification/claim-schema.yml')).properties.claim;
  assert.deepEqual(claim.properties.state.enum, ['implemented', 'verified', 'code_converged', 'release_ready', 'fixed_not_live', 'production_complete']);
  assert.equal(claim.properties.state.type, 'string');
  assert.ok(!claim.required.includes('state'), 'state is optional');
});

test('REQ-M10: ci.yml runs scripts/lint-readiness-claims.mjs', () => {
  assert.match(CI, /run: npx --no-install tsx scripts\/lint-readiness-claims\.mjs\n/);
});

// ---- REQ-M14: a scan that scanned nothing never passes -----------------------------------------

function scanReport(report, floor, rc, run) {
  scratch((dir) => {
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    writeFileSync(path.join(dir, 'floor.yml'), `semgrep: ${floor}\n`);
    run(() => node([path.join(ROOT, 'scripts/assert-scan.mjs'), path.join(dir, 'report.json'), path.join(dir, 'floor.yml'), String(rc)], dir));
  });
}
const SCANNED = ['tests/a.test.mjs', 'runtime/test/b.test.ts', 'scripts/c.mjs'];
const report = (over = {}) => ({ results: [], errors: [], paths: { scanned: [...SCANNED] }, ...over });

test('REQ-M14: a report exactly at its floor passes; one below it fails', () => {
  scanReport(report(), 3, 0, (check) => assert.equal(check().status, 0));
  scanReport(report(), 4, 0, (check) => assert.notEqual(check().status, 0));
});

test('REQ-M14: a non-empty errors[] fails even when the scanner status is zero and the count is above the floor', () => {
  scanReport(report({ errors: [{ level: 'warn', message: 'toy rule parse error' }] }), 1, 0, (check) => assert.notEqual(check().status, 0));
});

test('REQ-M14: an abnormal scanner exit status fails despite a clean report', () => {
  scanReport(report(), 1, 2, (check) => assert.notEqual(check().status, 0));
  scanReport(report({ paths: { scanned: [] } }), 1, 0, (check) => assert.notEqual(check().status, 0));
});

test('REQ-M14: the Semgrep job is a pinned scan --error --json piped to assert-scan.mjs, not the retired action', () => {
  const workflow = read('.github/workflows/security-scan.yml');
  assert.doesNotMatch(workflow, /returntocorp\/semgrep-action/);
  assert.match(workflow, /semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/, 'scanner image is pinned by version and digest');
  assert.match(workflow, /scan [^\n]*\n?[^\n]*--error --json --output \/report\/semgrep\.json/);
  assert.match(workflow, /node scripts\/assert-scan\.mjs "\$scan_report_dir\/semgrep\.json" governance\/scan-floors\.yml "\$rc"/);
  assert.match(read('governance/scan-floors.yml'), /^semgrep: [1-9]\d*$/m, 'the committed floor is a positive count');
});

// ---- REQ-M21: closures cite evidence -----------------------------------------------------------

test('REQ-M21: ci.yml runs scripts/lint-closures.mjs on every PR', () => {
  // The refusals themselves are exercised against a copied fixture script in
  // tests/verification/closure-references.test.mjs, which REQ-M21 also cites.
  assert.match(CI, /run: npx --no-install tsx scripts\/lint-closures\.mjs\n/);
});
