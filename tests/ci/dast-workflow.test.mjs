// specs/security/local-dast.md REQ1/2/9, AC1/2/11: static delivery wiring only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { parse } from 'acorn';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FILE = path.join(ROOT, '.github/workflows/dast.yml');
const PIN = {
  checkout: 'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd',
  node: 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
  upload: 'actions/upload-artifact@330a01c490aca151604b8cf639adc76d48f6c5d4',
};
function workflow() {
  assert.ok(existsSync(FILE), 'FEATURE_ABSENT: .github/workflows/dast.yml is not implemented');
  const doc = parseDocument(readFileSync(FILE, 'utf8')); assert.deepEqual(doc.errors, []);
  const value = doc.toJS(); assert.equal(Object.keys(value.jobs).length, 1);
  return { value, job: Object.values(value.jobs)[0] };
}
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, fn);
    else if (value && typeof value === 'object') visit(value, fn);
  }
}

test('DAST is weekly/manual only with read-only permissions, bounded Linux job and pinned actions', () => {
  const { value, job } = workflow();
  assert.deepEqual(Object.keys(value.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.ok(value.on.workflow_dispatch == null || Object.keys(value.on.workflow_dispatch).length === 0, 'no manual target/command inputs');
  assert.equal(value.on.schedule.length, 1);
  const cron = value.on.schedule[0].cron.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/);
  assert.ok(cron, 'one literal weekly schedule'); assert.ok(Number(cron[1]) < 60 && Number(cron[2]) < 24);
  assert.deepEqual(value.permissions, { contents: 'read' });
  if (job.permissions !== undefined) assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(job['continue-on-error'], undefined);
  const uses = job.steps.filter(step => step.uses).map(step => step.uses);
  assert.ok(uses.length >= 3); for (const use of uses) assert.match(use, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  for (const pin of Object.values(PIN)) assert.equal(uses.filter(use => use === pin).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, 'governance/required-checks.yml'), 'utf8')).contexts,
    ['validate', 'runtime-test', 'setup-linux', 'gitleaks', 'semgrep', 'dependency-audit']);
});

test('fixed preparation and runner commands precede always-upload without hiding failures', () => {
  const { value, job } = workflow(); const steps = job.steps;
  const pick = command => {
    const selected = steps.filter(step => step.run?.trim() === command); assert.equal(selected.length, 1); return selected[0];
  };
  const prepare = pick('node scripts/prepare-dast.mjs'); const run = pick('node scripts/run-dast.mjs');
  assert.ok(steps.indexOf(prepare) < steps.indexOf(run));
  for (const step of [prepare, run]) {
    assert.equal(step.if, undefined); assert.equal(step['continue-on-error'], undefined);
    assert.equal(step['working-directory'], undefined);
  }
  assert.equal({ ...value.env, ...job.env, ...run.env }.DAST_TARGET, 'http://127.0.0.1:18080/docs');
  for (const step of steps) if (typeof step.run === 'string') assert.doesNotMatch(step.run, /\$\{\{|\|\|\s*true\b/);
  const upload = steps.find(step => step.uses === PIN.upload); assert.ok(upload);
  assert.ok(steps.indexOf(upload) > steps.indexOf(run));
  assert.ok(['always()', '${{ always() }}'].includes(upload.if));
  assert.equal(upload['continue-on-error'], undefined); assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['include-hidden-files'], true, 'the selected evidence lives beneath .workflow');
  assert.equal(upload.with.path.trim(), '.workflow/proofs/dast/');
});

test('the actual runner finally invokes scoped cleanup before composing its final summary', () => {
  workflow();
  const file = path.join(ROOT, 'scripts/run-dast.mjs');
  assert.ok(existsSync(file), 'FEATURE_ABSENT: scripts/run-dast.mjs is not implemented');
  const ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 2022, sourceType: 'module' });
  const imports = ast.body.filter(node => node.type === 'ImportDeclaration' && node.source.value === './dast/owned-run.mjs');
  assert.equal(imports.length, 1);
  for (const name of ['cleanupOwned', 'finalizeSummary']) assert.ok(imports[0].specifiers.some(s => s.imported?.name === name && s.local.name === name));
  const finalizers = []; visit(ast, node => { if (node.type === 'TryStatement' && node.finalizer) finalizers.push(node.finalizer); });
  const matching = finalizers.filter(block => {
    const calls = []; visit(block, node => { if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.push(node); });
    const cleanup = calls.find(node => node.callee.name === 'cleanupOwned');
    const summary = calls.find(node => node.callee.name === 'finalizeSummary');
    return cleanup && summary && cleanup.start < summary.start;
  });
  assert.equal(matching.length, 1, 'the real finally must use tested cleanup and preserve its outcome');
});

test('runner target or argument refusal is usage before any workload setup', () => {
  const file = path.join(ROOT, 'scripts/run-dast.mjs');
  assert.ok(existsSync(file), 'FEATURE_ABSENT: scripts/run-dast.mjs is not implemented');
  const parent = path.join(ROOT, '.workflow/state'); mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, 'dast-usage-')); const secret = 'MR21_PRIVATE_TARGET_SENTINEL';
  try {
    for (const [target, args] of [[null, []], ['https://example.com/' + secret + '\n::error::synthetic', []], ['http://127.0.0.1:18080/docs', [secret]]]) {
      const env = { PATH: '', HOME: fixture, TMPDIR: fixture, LANG: 'C' };
      if (target !== null) env.DAST_TARGET = target;
      const result = spawnSync(process.execPath, [file, ...args], { cwd: fixture, env, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
      assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
      assert.equal(result.status, 1); assert.equal(result.stderr, '');
      assert.ok(Buffer.byteLength(result.stdout) <= 4096); assert.ok(result.stdout.endsWith('\n'));
      assert.equal(result.stdout.slice(0, -1).includes('\n'), false);
      const summary = JSON.parse(result.stdout); assert.equal(summary.verdict, 'INDETERMINATE'); assert.equal(summary.reason, 'usage');
      assert.equal(result.stdout.includes(secret), false); assert.equal(result.stdout.includes('\u001b'), false);
      assert.deepEqual(readdirSync(fixture), [], 'usage refusal creates no owned fixture workload');
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
