// specs/security/ci-dependency-audit.md: actual workflow shell, synthetic audit reports only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/security-scan.yml');
const STEP = 'npm audit (root and runtime)';
const PYTHON = '/usr/bin/python3';
const PRIVATE = 'MR19_PRIVATE_REPORT_SENTINEL';
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: {
  dependencies: { total: 3 }, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
} });
const result = (report = clean(), rc = 0) => ({ bytes: Buffer.from(JSON.stringify(report) + '\n'), rc });

function workflow() {
  const doc = parseDocument(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(doc.errors, [], 'workflow YAML prerequisite');
  return doc.toJS();
}
function selectedStep() {
  const job = workflow().jobs['dependency-audit']; assert.ok(job && Array.isArray(job.steps), 'existing dependency-audit job prerequisite');
  const matches = job.steps.filter(step => step.name === STEP); assert.equal(matches.length, 1, 'one existing audit step');
  const step = matches[0]; assert.equal(step.shell, 'bash'); assert.equal(typeof step.run, 'string'); assert.ok(step.run.trim());
  assert.doesNotMatch(step.run, /\$\{\{/); assert.equal(step['working-directory'], undefined);
  return step;
}
function snapshot(directory, omitted) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name); if (omitted.includes(file)) return [];
    const stat = lstatSync(file), identity = [stat.mode, stat.ino, stat.nlink];
    if (stat.isDirectory()) return [[file, 'directory', identity], ...snapshot(file, omitted)];
    return [[file, identity, stat.isSymbolicLink() ? ['symlink', readlinkSync(file)] : hash(readFileSync(file))]];
  });
}
function withReports(reports, check) {
  const step = selectedStep();
  const workflowBefore = readFileSync(WORKFLOW);
  assert.ok(existsSync('/bin/bash') && existsSync(PYTHON), 'fixture prerequisite: trusted Linux Bash/Python must exist');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'dependency-audit-')));
  const root = path.join(outer, 'repo'), bin = path.join(outer, 'bin'), scratch = path.join(outer, 'reports');
  const log = path.join(outer, 'npm.jsonl');
  try {
    for (const directory of [root, path.join(root, 'runtime'), bin, scratch]) mkdirSync(directory, { recursive: true });
    for (const directory of [root, path.join(root, 'runtime')]) {
      const name = directory === root ? 'owned-root' : 'owned-runtime';
      writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true }));
      writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3,
        packages: { '': { name, version: '1.0.0' }, 'node_modules/owned-dependency': { version: '1.0.0' } } }));
    }
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
    symlinkSync(PYTHON, path.join(bin, 'python3'));
    const values = reports.map(item => ({ data: item.bytes.toString('base64'), rc: item.rc }));
    const stub = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),cwd=process.cwd();\n` +
      `const index=cwd===${JSON.stringify(root)}?0:cwd===${JSON.stringify(path.join(root, 'runtime'))}?1:-1;\n` +
      `if(index<0||JSON.stringify(args)!==JSON.stringify(['audit','--audit-level=high','--json'])||!fs.existsSync(path.join(cwd,'package-lock.json'))){fs.writeSync(2,'FIXTURE_NPM_REJECTED\\n');process.exit(82);}\n` +
      `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cwd,args})+'\\n');const value=${JSON.stringify(values)}[index];fs.writeSync(1,Buffer.from(value.data,'base64'));process.exit(value.rc);\n`;
    writeFileSync(path.join(bin, 'npm'), stub); chmodSync(path.join(bin, 'npm'), 0o755); writeFileSync(log, '');
    const before = snapshot(outer, [scratch, log]);
    const invocation = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: root, env: { PATH: bin, HOME: root, RUNNER_TEMP: scratch, LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 10000, maxBuffer: 1048576,
    });
    assert.equal(invocation.error, undefined, invocation.error?.message); assert.equal(invocation.signal, null);
    assert.deepEqual(snapshot(outer, [scratch, log]), before, 'audit must preserve owned lockfiles/source and stub');
    assert.deepEqual(readFileSync(WORKFLOW), workflowBefore, 'test must not rewrite workflow source');
    assert.deepEqual(readFileSync(path.join(scratch, 'audit.json')), reports[1].bytes, 'parser must not rewrite final audit input');
    const output = invocation.stdout + invocation.stderr;
    assert.doesNotMatch(output, /FIXTURE_NPM_REJECTED|command not found|No such file or directory|MODULE_NOT_FOUND|Cannot find module/, 'tool/fixture failures cannot witness parser refusal');
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(calls, [root, path.join(root, 'runtime')].map(cwd => ({ cwd, args: ['audit', '--audit-level=high', '--json'] })), 'both lockfile audits remain attempted in order');
    check({ ...invocation, output });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

function summaries(r, codes = [0, 0]) {
  for (const [index, directory] of ['.', 'runtime'].entries()) assert.ok(r.stdout.includes(`npm audit ${directory}: exit ${codes[index]}, 3 dependencies, vulnerabilities `), r.output);
}
function passed(r) { assert.equal(r.status, 0, r.output); assert.equal(r.stderr, ''); summaries(r); }
function failed(r) { assert.equal(r.status, 1, r.output); }
function invalid(r, directory = '.') {
  failed(r);
  assert.equal(r.stderr, `npm audit ${directory}: invalid audit report; refusing to report a pass\n`);
  assert.equal(r.output.includes(PRIVATE), false); assert.doesNotMatch(r.output, /Traceback|JSONDecodeError|UnicodeDecodeError/);
}
function findings(level, { summary = true, entry = true } = {}) {
  const report = clean();
  if (summary) { report.metadata.vulnerabilities[level] = 1; report.metadata.vulnerabilities.total = 1; }
  if (entry) report.vulnerabilities['owned-' + level] = { severity: level, range: '<1.0.0' };
  return report;
}
function cases(name, variants, check) { test(name, () => { for (const variant of variants) check(variant); }); }

test('existing read-only job preserves pinned review action and fixed high threshold', () => {
  const source = workflow(), job = source.jobs['dependency-audit'], step = selectedStep();
  assert.deepEqual(source.permissions, { contents: 'read' });
  assert.equal(job['continue-on-error'], undefined); assert.equal(step['continue-on-error'], undefined); assert.equal(step.if, undefined);
  const actions = job.steps.filter(entry => entry.uses);
  for (const entry of actions) assert.match(entry.uses, /^[^@]+@[0-9a-f]{40}$/);
  assert.equal(actions.filter(entry => entry.uses.startsWith('actions/checkout@')).length, 1);
  const setup = actions.filter(entry => entry.uses.startsWith('actions/setup-node@')); assert.equal(setup.length, 1); assert.equal(setup[0].with['node-version'], 22);
  const review = actions.filter(entry => entry.uses.startsWith('actions/dependency-review-action@')); assert.equal(review.length, 1);
  assert.equal(review[0].uses, 'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294');
  assert.equal(review[0].if, "github.event_name == 'pull_request'"); assert.equal(review[0].with['fail-on-severity'], 'high');
  assert.equal(review[0]['continue-on-error'], undefined);
});
test('clean nonempty reports pass for both exact lockfile directories', () => withReports([result(), result()], passed));
test('info low and moderate findings preserve the high-only refusal threshold', () => {
  const report = clean();
  for (const level of LEVELS.slice(0, 3)) { report.metadata.vulnerabilities[level] = 1; report.vulnerabilities['owned-' + level] = { severity: level }; }
  report.metadata.vulnerabilities.total = 3;
  withReports([result(report), result(report)], r => { passed(r); assert.doesNotMatch(r.output, /VULNERABLE/); });
});
test('unused native fields and unequal lower-severity map counts do not invent a broader schema', () => {
  const report = findings('low'); report.metadata.vulnerabilities.low = 5; report.metadata.vulnerabilities.total = 5;
  report.unused = PRIVATE; report.metadata.dependencies.unused = PRIVATE; report.auditReportVersion = 'ignored-extra';
  withReports([result(report), result()], r => { passed(r); assert.equal(r.output.includes(PRIVATE), false); });
});
test('normal summary projects only the six validated counters', () => {
  const report = clean(); report.metadata.vulnerabilities.unused = PRIVATE;
  withReports([result(report), result()], r => { passed(r); assert.equal(r.output.includes(PRIVATE), false); });
});
cases('status0 high and critical entries independently refuse', ['high', 'critical'], level => {
  withReports([result(findings(level)), result()], r => { failed(r); summaries(r); assert.match(r.stdout, new RegExp(`VULNERABLE ${level} .*owned-${level}`)); });
});
cases('summary-only high and critical counts refuse an empty entry map', ['high', 'critical'], level => {
  withReports([result(findings(level, { entry: false })), result()], r => { failed(r); summaries(r); });
});
cases('entry-only high and critical findings refuse a zero summary', ['high', 'critical'], level => {
  withReports([result(findings(level, { summary: false })), result()], r => { failed(r); summaries(r); assert.match(r.stdout, new RegExp(`VULNERABLE ${level} .*owned-${level}`)); });
});
cases('every nonzero npm status refuses while both directories are still audited', [[7, 0], [0, 2]], codes => {
  withReports([result(clean(), codes[0]), result(clean(), codes[1])], r => { failed(r); summaries(r, codes); });
});
cases('numeric zero retains the explicit empty-audit refusal for either tree', [0, 1], index => {
  const reports = [result(), result()], report = clean(); report.metadata.dependencies.total = 0; reports[index] = result(report);
  withReports(reports, r => { failed(r); assert.equal(r.stderr, `npm audit ${index ? 'runtime' : '.'} saw no dependencies: refusing to report a pass\n`); });
});
cases('dependency totals must be positive nonboolean integers', [null, '0', '3', -1, true, false, 1.5, undefined], total => {
  const report = clean(); if (total === undefined) delete report.metadata.dependencies.total; else report.metadata.dependencies.total = total;
  withReports([result(report), result()], r => invalid(r));
});
cases('required report containers refuse absent or nonobject shapes safely', [
  () => null, () => [], report => { delete report.metadata; return report; },
  report => { report.metadata = []; return report; }, report => { report.metadata.dependencies = null; return report; },
  report => { report.metadata.vulnerabilities = []; return report; }, report => { delete report.vulnerabilities; return report; },
  report => { report.vulnerabilities = []; return report; },
], mutate => withReports([result(mutate(clean())), result()], r => invalid(r)));
cases('summary counters reject missing negative boolean floating and string values', [undefined, -1, true, 0.5, '0', null], value => {
  const report = clean(); if (value === undefined) delete report.metadata.vulnerabilities.high; else report.metadata.vulnerabilities.high = value;
  withReports([result(report), result()], r => invalid(r));
});
cases('nonfinite parser numbers cannot count as dependencies or findings', ['NaN', 'Infinity'], number => {
  const report = clean(); report.metadata.dependencies.total = 'REPLACE_NUMBER';
  const bytes = Buffer.from(JSON.stringify(report).replace('"REPLACE_NUMBER"', number));
  withReports([{ bytes, rc: 0 }, result()], r => invalid(r));
});
cases('summary total must equal the five severity counts', [report => { report.metadata.vulnerabilities.total = 1; }, report => { report.metadata.vulnerabilities.low = 1; }], mutate => {
  const report = clean(); mutate(report); withReports([result(report), result()], r => invalid(r));
});
cases('vulnerability entries require nonempty names object values and known severity', [
  { '': { severity: 'low' } }, { owned: null }, { owned: [] }, { owned: {} },
  { owned: { severity: 'severe' } }, { owned: { severity: 1 } },
], entries => { const report = clean(); report.vulnerabilities = entries; withReports([result(report), result()], r => invalid(r)); });
cases('every error member refuses without dumping its value', [null, { code: 'OWNED_ERROR', summary: PRIVATE }], error => {
  const report = clean(); report.error = error; withReports([result(report), result()], r => invalid(r));
});
cases('malformed JSON and UTF8 fail with the fixed private diagnostic', [
  Buffer.alloc(0), Buffer.from('{"private":"' + PRIVATE + '",'), Buffer.from([0xff, 0x0a]),
], bytes => withReports([{ bytes, rc: 0 }, result()], r => invalid(r)));
test('finding names and string ranges are escaped while nonstring optional ranges stay unprinted', () => {
  const name = 'owned\n::error::inert\t\u001b[31m', range = '<1\n::warning::inert';
  const first = clean(); first.vulnerabilities[name] = { severity: 'high', range };
  const second = clean(); second.vulnerabilities['owned-critical'] = { severity: 'critical', range: { ignored: PRIVATE } };
  withReports([result(first, 1), result(second, 1)], r => {
    failed(r); summaries(r, [1, 1]);
    const findings = r.stdout.split('\n').filter(line => line.startsWith('VULNERABLE ')); assert.equal(findings.length, 2);
    assert.ok(findings[0].includes(JSON.stringify(name))); assert.ok(findings[0].includes(JSON.stringify(range)));
    assert.ok(findings[1].includes(JSON.stringify('owned-critical')));
    assert.equal(r.output.includes(PRIVATE), false); assert.equal(r.output.includes('\u001b'), false); assert.doesNotMatch(r.output, /^::(?:error|warning)::/m);
  });
});
