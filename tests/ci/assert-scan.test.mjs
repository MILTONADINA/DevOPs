// specs/graph/M-masterpiece-standard.md REQ-M14/AC-M14.1.
// Dedicated strict scan contract: specs/security/ci-semgrep-scan.md.
// CLI fixtures only: no scanner, shell, Git, network, provider or real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CHECKER = path.join(ROOT, 'scripts', 'assert-scan.mjs');
const SCANNED = ['tests/example.test.mjs', 'runtime/test/example.test.ts', 'scripts/example.mjs'];
const cleanReport = () => ({ results: [], errors: [], paths: { scanned: [...SCANNED] } });

function fixture(run, { report = cleanReport(), reportText = JSON.stringify(report), floor = 'semgrep: 3\n' } = {}) {
  // Every case must witness the missing implementation as RED. In particular,
  // Node's module-not-found exit must never satisfy a negative acceptance case.
  assert.ok(existsSync(CHECKER), 'FEATURE_ABSENT: scripts/assert-scan.mjs must exist before any refusal can count');
  const parent = path.join(ROOT, '.workflow', 'state');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'assert-scan-cli-'));
  const files = { dir, report: path.join(dir, 'report.json'), floor: path.join(dir, 'floor.yml') };
  writeFileSync(files.report, reportText);
  writeFileSync(files.floor, floor);
  try {
    run(files);
    assert.equal(readFileSync(files.report, 'utf8'), reportText, 'checker must not rewrite its report');
    assert.equal(readFileSync(files.floor, 'utf8'), floor, 'checker must not rewrite its floor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(files, args = [files.report, files.floor, '0']) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: files.dir, env: {}, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, 'checker must finish without a signal');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /MODULE_NOT_FOUND|Cannot find module/, 'missing implementation is not a valid refusal');
  return { ...result, output };
}

function refused(result, reason, status) {
  if (status === undefined) assert.ok(Number.isInteger(result.status) && result.status !== 0, result.output);
  else assert.equal(result.status, status, result.output);
  assert.match(result.output, /(?:^|\n)(?:semgrep|assert-scan):[^\n]+/i, 'refusal needs a checker diagnostic');
  assert.match(result.output, reason, result.output);
}

function passed(result, scanned, floor) {
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /(?:^|\n)semgrep:/);
  for (const expected of [`exit 0`, `${scanned} files scanned`, '0 findings', '0 errors', `floor ${floor}`]) {
    assert.ok(result.output.includes(expected), `missing success evidence ${expected}: ${result.output}`);
  }
}

test('AC-M14.1 a clean report exactly at its floor passes with the measured summary', () => {
  fixture((files) => passed(invoke(files), 3, 3));
});

test('AC-M14.1 a clean above-floor report allows unrelated scanner metadata', () => {
  const report = cleanReport();
  report.paths.scanned.push('runtime/src/example.ts');
  report.version = 'synthetic-scanner';
  report.time = { total: 0.01 };
  fixture((files) => passed(invoke(files), 4, 3), { report });
});

test('AC-M14.1 blank and full-line floor comments are accepted with relative CLI paths', () => {
  fixture((files) => passed(invoke(files, ['report.json', 'floor.yml', '0']), 3, 3), {
    floor: '\n# Measured synthetic fixture only\n\nsemgrep: 3\n  # Full-line comment\n',
  });
});

test('AC-M14.1 a report below its numeric floor refuses with the observed count', () => {
  fixture((files) => {
    const result = invoke(files);
    refused(result, /below.*floor|floor.*(?:not met|minimum)/i);
    assert.match(result.output, /3 files scanned/);
    assert.match(result.output, /floor 4/);
  }, { floor: 'semgrep: 4\n' });
});

test('AC-M14.1 an empty scanned array cannot pass', () => {
  const report = cleanReport();
  report.paths.scanned = [];
  fixture((files) => refused(invoke(files), /empty|no files|zero files|0 files scanned/i), { report });
});

test('AC-M14.1 both exact test-tree prefixes remain mandatory at an otherwise sufficient floor', () => {
  for (const [scanned, missing] of [
    [['runtime/test/a.ts', 'scripts/b.mjs', 'src/c.ts'], /tests\//],
    [['tests/a.test.mjs', 'scripts/b.mjs', 'src/c.ts'], /runtime\/test\//],
    [['tests-other/a.mjs', 'runtime/testing/b.ts', 'src/c.ts'], /tests\//],
  ]) {
    fixture((files) => refused(invoke(files), missing), {
      report: { results: [], errors: [], paths: { scanned } },
    });
  }
});

test('AC-M14.1 warn, info and fatal scanner errors all refuse', () => {
  for (const level of ['warn', 'info', 'error']) {
    const report = cleanReport();
    report.errors = [{ level, type: 'SyntheticParseError', message: `synthetic ${level}` }];
    fixture((files) => {
      const result = invoke(files);
      refused(result, /errors?/i);
      const lines = result.output.split('\n').filter((line) => line.startsWith('SCAN_DIAGNOSTIC '));
      assert.equal(lines.length, 1, result.output);
      assert.deepEqual(JSON.parse(lines[0].slice('SCAN_DIAGNOSTIC '.length)), report.errors[0]);
    }, { report });
  }
});

test('AC-M14.1 every complete error object is JSON-escaped without truncation or workflow-command emission', () => {
  const report = cleanReport();
  report.errors = [
    {
      code: 3, level: 'warn', type: ['PartialParsing', [{ line: 7 }]], path: 'tests/example.test.mjs',
      message: `first line\n::error::synthetic metadata\t\u001b[31m${'x'.repeat(320)}`,
      spans: [{ start: { line: 7, col: 2 }, end: { line: 8, col: 9 } }],
      details: { nested: ['retained', { value: true }] },
    },
    { code: 4, level: 'info', type: 'SyntheticInfo', message: 'second diagnostic', extra: { retained: 42 } },
  ];
  fixture((files) => {
    const result = invoke(files);
    refused(result, /errors?/i);
    const lines = result.output.split('\n').filter((line) => line.startsWith('SCAN_DIAGNOSTIC '));
    assert.deepEqual(lines.map((line) => JSON.parse(line.slice('SCAN_DIAGNOSTIC '.length))), report.errors);
    assert.doesNotMatch(result.output, /^::/m);
    assert.equal(result.output.includes('\u001b'), false, 'raw terminal control character must stay escaped');
  }, { report });
});

test('AC-M14.1 findings refuse even with scanner status zero and preserve all finding summaries', () => {
  const report = cleanReport();
  report.results = [
    { check_id: 'fixture.first', path: SCANNED[0], start: { line: 12 }, extra: { severity: 'WARNING', lines: 'DO_NOT_EMIT_MATCH_BODY' } },
    { check_id: 'fixture.second', path: SCANNED[1], start: { line: 23 }, extra: { severity: 'ERROR', lines: 'DO_NOT_EMIT_MATCH_BODY' } },
  ];
  fixture((files) => {
    const result = invoke(files);
    refused(result, /findings?/i);
    assert.match(result.output, /FINDING WARNING fixture\.first tests\/example\.test\.mjs:12/);
    assert.match(result.output, /FINDING ERROR fixture\.second runtime\/test\/example\.test\.ts:23/);
    assert.doesNotMatch(result.output, /DO_NOT_EMIT_MATCH_BODY/);
  }, { report });
});

test('AC-M14.1 finding metadata stays on one safely escaped summary line', () => {
  const report = cleanReport();
  report.results = [{
    check_id: 'fixture.rule\n::error::rule-continuation\t\u001b[31m',
    path: 'tests/example\n::warning::path-continuation.test.mjs',
    start: { line: 12 },
    extra: { severity: 'WARNING\nseverity-continuation', lines: 'DO_NOT_EMIT_MATCH_BODY' },
  }];
  fixture((files) => {
    const result = invoke(files);
    refused(result, /findings?/i);
    const lines = result.output.split('\n').filter((line) => line.startsWith('FINDING '));
    assert.equal(lines.length, 1, result.output);
    for (const value of ['WARNING', 'severity-continuation', 'fixture.rule', 'rule-continuation', 'tests/example', 'path-continuation', '12']) {
      assert.ok(lines[0].includes(value), `finding summary lost ${value}: ${result.output}`);
    }
    assert.doesNotMatch(result.output, /^::/m);
    assert.equal(lines[0].includes('\t'), false, 'metadata tab must stay escaped');
    assert.equal(result.output.includes('\u001b'), false, 'metadata terminal control must stay escaped');
    assert.doesNotMatch(result.output, /DO_NOT_EMIT_MATCH_BODY/);
  }, { report });
});

test('AC-M14.1 valid nonzero scanner statuses, including 255, cannot be erased by clean JSON', () => {
  for (const status of ['1', '2', '137', '255']) {
    fixture((files) => {
      const result = invoke(files, [files.report, files.floor, status]);
      refused(result, /scanner|scan.*(?:exit|status)|semgrep: exit/i, Number(status));
      assert.ok(result.output.includes(`exit ${status}`) || result.output.includes(`status ${status}`), result.output);
    });
  }
});

test('AC-M14.1 valid scanner failure survives malformed report, bad floor and surplus arguments', () => {
  fixture((files) => refused(invoke(files, [files.report, files.floor, '7']), /report|JSON/i, 7), { reportText: '{invalid' });
  fixture((files) => refused(invoke(files, [files.report, files.floor, '7']), /floor|configuration/i, 7), { floor: 'semgrep: 0\n' });
  fixture((files) => refused(invoke(files, [files.report, files.floor, '7', 'extra']), /arguments|usage|exactly.*3|exactly.*three/i, 7));
});

test('AC-M14.1 missing report or floor preserves a valid scanner failure', () => {
  fixture((files) => {
    refused(invoke(files, [path.join(files.dir, 'missing-report.json'), files.floor, '9']), /report/i, 9);
    refused(invoke(files, [files.report, path.join(files.dir, 'missing-floor.yml'), '9']), /floor|configuration/i, 9);
  });
});

test('AC-M14.1 exactly three CLI arguments are required', () => {
  fixture((files) => {
    for (const args of [[], [files.report], [files.report, files.floor], [files.report, files.floor, '0', 'extra']]) {
      refused(invoke(files, args), /arguments|usage|exactly.*3|exactly.*three/i);
    }
  });
});

test('AC-M14.1 invalid scanner status text fails instead of defaulting to zero', () => {
  fixture((files) => {
    for (const status of ['', '-1', '1.5', '256', '1e0', ' 0']) {
      refused(invoke(files, [files.report, files.floor, status]), /scanner.*status|status.*(?:invalid|decimal|integer|255)/i);
    }
  });
});

test('AC-M14.1 missing and nonregular report/config inputs fail with the input category', () => {
  fixture((files) => {
    const directory = path.join(files.dir, 'not-a-file');
    mkdirSync(directory);
    for (const input of [path.join(files.dir, 'missing'), directory]) {
      refused(invoke(files, [input, files.floor, '0']), /report/i);
      refused(invoke(files, [files.report, input, '0']), /floor|configuration/i);
    }
  });
});

test('AC-M14.1 malformed or concatenated report JSON refuses', () => {
  for (const reportText of ['', '{malformed', `${JSON.stringify(cleanReport())}\n${JSON.stringify(cleanReport())}`]) {
    fixture((files) => refused(invoke(files), /report|JSON/i), { reportText });
  }
});

test('AC-M14.1 report roots must be objects and all required fields must have their specified shapes', () => {
  const missingResults = cleanReport(); delete missingResults.results;
  const missingErrors = cleanReport(); delete missingErrors.errors;
  const missingPaths = cleanReport(); delete missingPaths.paths;
  for (const [report, reason] of [
    [null, /report.*object|object.*report/i],
    [[], /report.*object|object.*report/i],
    ['text', /report.*object|object.*report/i],
    [missingResults, /results/], [missingErrors, /errors/], [missingPaths, /paths/],
    [{ ...cleanReport(), results: {} }, /results/],
    [{ ...cleanReport(), errors: null }, /errors/],
    [{ ...cleanReport(), paths: null }, /paths/],
    [{ ...cleanReport(), paths: {} }, /scanned/],
    [{ ...cleanReport(), paths: { scanned: 'tests/example.test.mjs' } }, /scanned/],
  ]) {
    fixture((files) => refused(invoke(files), reason), { report });
  }
});

test('AC-M14.1 scanned entries must be normalized project-relative POSIX path strings', () => {
  for (const invalid of [null, 42, '', '.', '..', '/absolute/file.ts', 'tests\\file.ts', 'tests//file.ts', 'tests/./file.ts', 'tests/../file.ts', './file.ts', 'tests/']) {
    const report = cleanReport();
    report.paths.scanned.push(invalid);
    fixture((files) => refused(invoke(files), /scanned.*(?:path|string)|path.*(?:invalid|relative|POSIX|normalized|empty|segment)/i), { report });
  }
});

test('AC-M14.1 duplicate paths refuse even when the unique paths already meet the floor', () => {
  const report = cleanReport();
  report.paths.scanned.push(SCANNED[0]);
  fixture((files) => refused(invoke(files), /duplicate|unique/i), { report });
});

test('AC-M14.1 floor numbers must be positive decimal safe integers', () => {
  for (const number of ['0', '03', '-1', '1.5', '1e0', '"3"', '9007199254740992']) {
    fixture((files) => refused(invoke(files), /floor|configuration/i), { floor: `semgrep: ${number}\n` });
  }
});

test('AC-M14.1 the maximum safe integer is a valid floor but cannot be met by a small report', () => {
  fixture((files) => {
    const result = invoke(files);
    refused(result, /below.*floor|floor.*(?:not met|minimum)/i);
    assert.match(result.output, /9007199254740991/);
  }, { floor: 'semgrep: 9007199254740991\n' });
});

test('AC-M14.1 floor syntax permits one known flat entry and no inline comments, mappings or aliases', () => {
  for (const floor of [
    '', '# no floor\n', 'semgrep: 3\nsemgrep: 3\n', 'unknown: 3\n',
    'semgrep: 3\nunknown: 3\n', 'semgrep: 3 # inline comment\n',
    'semgrep:\n  files: 3\n', 'semgrep: *shared\n', 'semgrep: &shared 3\n',
  ]) {
    fixture((files) => refused(invoke(files), /floor|configuration/i), { floor });
  }
});
