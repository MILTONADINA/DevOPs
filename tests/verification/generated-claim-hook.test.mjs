// specs/verification/committed-claims.md REQ-9 / AC-4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, chmodSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GENERATOR = path.join(ROOT, 'scripts/init-project.sh');
const SENTINEL = 'owned-command-must-not-execute';

function withHook(run) {
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'committed-hook-')));
  try {
    const consumer = path.join(outer, 'consumer'); const source = path.join(outer, 'source'); const bin = path.join(outer, 'bin');
    const log = path.join(outer, 'calls.jsonl');
    for (const dir of [path.join(consumer, '.workflow'), path.join(consumer, '.git'), path.join(source, 'scripts'), bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(consumer, '.workflow/profile.yml'), 'skills: []\n');
    copyFileSync(GENERATOR, path.join(source, 'scripts/init-project.sh'));
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
    // Only the generator's ordinary filesystem tools are exposed; no real tsx/gitleaks/node fallback.
    for (const tool of ['mkdir', 'chmod', 'ls', 'cat']) {
      assert.ok(existsSync(`/bin/${tool}`), `fixture tool prerequisite: /bin/${tool}`);
      symlinkSync(`/bin/${tool}`, path.join(bin, tool));
    }
    for (const tool of ['tsx', 'gitleaks']) {
      const file = path.join(bin, tool);
      writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:${JSON.stringify(tool)},args})+'\\n');if(${JSON.stringify(tool)}==='gitleaks')process.exit(Number(process.env.FIXTURE_GITLEAKS_EXIT||0));if(args[0]===${JSON.stringify(path.join(source, 'analyzer/install.ts'))})process.exit(0);if(args[0]===${JSON.stringify(path.join(source, 'verification/claim-validator.ts'))})process.exit(Number(process.env.FIXTURE_CLAIM_EXIT||0));process.exit(91);\n`);
      chmodSync(file, 0o755);
    }
    const env = { PATH: bin, HOME: consumer, DEVOPS_ROOT: source, LANG: 'C', LC_ALL: 'C' };
    writeFileSync(log, '');
    const generated = spawnSync('/bin/bash', [path.join(source, 'scripts/init-project.sh')], { cwd: consumer, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(generated.error, undefined); assert.equal(generated.signal, null); assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(calls(), [{ tool: 'tsx', args: [path.join(source, 'analyzer/install.ts')] }], 'generation must use only the owned analyzer stub');
    const hook = path.join(consumer, '.git/hooks/pre-commit'); assert.ok(existsSync(hook));
    const writeProof = (relative) => {
      const file = path.join(consumer, '.workflow/proofs', relative); mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'fixture text is never passed to the real validator\n'); return `.workflow/proofs/${relative}`;
    };
    const invoke = (extraEnv = {}) => {
      writeFileSync(log, '');
      const result = spawnSync('/bin/bash', [hook], { cwd: consumer, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      assert.equal(existsSync(path.join(consumer, SENTINEL)), false);
      return { ...result, calls: calls() };
    };
    run({ consumer, source, bin, writeProof, invoke });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}
function validatorCalls(result, source) {
  return result.calls.filter((call) => call.tool === 'tsx' && call.args[0] === path.join(source, 'verification/claim-validator.ts'));
}
function expectExplicit(result, source, files) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = validatorCalls(result, source); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1).sort(), [...files, '--no-rerun'].sort());
  assert.equal(calls[0].args.includes('--all'), false);
  assert.deepEqual(result.calls[0], { tool: 'gitleaks', args: ['protect', '--staged', '--no-banner'] });
}

for (const present of [false, true]) test(`generated hook skips empty local proofs, directory present=${present}`, () => withHook((f) => {
  if (present) mkdirSync(path.join(f.consumer, '.workflow/proofs'));
  const result = f.invoke(); assert.equal(result.status, 0); assert.deepEqual(validatorCalls(result, f.source), []);
}));

test('generated hook passes spaced top-level files as explicit argv data', () => withHook((f) => {
  const files = [f.writeProof('a regular.yml'), f.writeProof('second.yml')];
  expectExplicit(f.invoke(), f.source, files);
}));

test('generated hook includes hidden-only YAML', () => withHook((f) => {
  const file = f.writeProof('.hidden.yml'); expectExplicit(f.invoke(), f.source, [file]);
}));

test('generated hook includes mixed hidden/ordinary YAML without recursive or other extensions', () => withHook((f) => {
  const files = [f.writeProof('.hidden.yml'), f.writeProof('ordinary.yml')];
  f.writeProof('nested/ignored.yml'); f.writeProof('other.yaml');
  expectExplicit(f.invoke(), f.source, files);
}));

test('generated hook skips a nested-only or non-yml set', () => withHook((f) => {
  f.writeProof('nested/ignored.yml'); f.writeProof('other.yaml');
  const result = f.invoke(); assert.equal(result.status, 0); assert.deepEqual(validatorCalls(result, f.source), []);
}));

test('generated hook propagates the owned validator failure', () => withHook((f) => {
  f.writeProof('ordinary.yml'); const result = f.invoke({ FIXTURE_CLAIM_EXIT: '23' });
  assert.notEqual(result.status, 0); assert.equal(validatorCalls(result, f.source).length, 1);
}));

test('generated hook preserves gitleaks failure before validation', () => withHook((f) => {
  f.writeProof('ordinary.yml'); const result = f.invoke({ FIXTURE_GITLEAKS_EXIT: '17' });
  assert.notEqual(result.status, 0); assert.deepEqual(validatorCalls(result, f.source), []);
  assert.deepEqual(result.calls, [{ tool: 'gitleaks', args: ['protect', '--staged', '--no-banner'] }]);
}));

test('generated hook preserves missing-tsx compatibility after generation', () => withHook((f) => {
  f.writeProof('ordinary.yml'); rmSync(path.join(f.bin, 'tsx'));
  const result = f.invoke(); assert.equal(result.status, 0); assert.deepEqual(validatorCalls(result, f.source), []);
}));

test('generated hook validates when optional gitleaks is unavailable', () => withHook((f) => {
  const file = f.writeProof('ordinary.yml'); rmSync(path.join(f.bin, 'gitleaks'));
  const result = f.invoke(); assert.equal(result.status, 0);
  const calls = validatorCalls(result, f.source); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1).sort(), [file, '--no-rerun'].sort());
  assert.equal(result.calls.some((call) => call.tool === 'gitleaks'), false);
}));
