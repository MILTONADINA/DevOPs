// specs/verification/recovery-cli-refusal.md REQ-1..4 / AC-1..4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/recover-claim-provenance.sh');
const REFUSAL = 'claim provenance recovery: automatic recovery is disabled\n';
const VALIDATOR_REFUSAL = 'claim validation: command replay is disabled; use --no-rerun\n';
const OLD_SUCCESS = 'Running validate:claims to find currently-missing git_sha values...\nNo missing git_sha values found -- nothing to recover.\n';
const SENTINEL = 'RECOVERY_PRIVATE_SENTINEL';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function snapshot(directory, log) {
  return readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name); if (file === log) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...snapshot(file, log)];
    return [[file, stat.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : hash(readFileSync(file))]];
  });
}

function withFixture(check) {
  for (const file of [SCRIPT, '/bin/bash', '/usr/bin/grep', '/usr/bin/sort']) {
    assert.ok(existsSync(file), `fixture prerequisite missing: ${file}`);
  }
  const original = readFileSync(SCRIPT), mode = lstatSync(SCRIPT).mode & 0o777;
  assert.ok(original.toString('utf8').startsWith('#!/usr/bin/env bash\n'));
  assert.ok(mode & 0o111, 'existing executable entry prerequisite');
  const state = path.join(ROOT, '.workflow/state'); mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'recovery-refusal-')));
  try {
    const cwd = path.join(outer, 'ordinary'), bin = path.join(outer, 'bin');
    mkdirSync(cwd); mkdirSync(bin);
    assert.equal(existsSync(path.join(cwd, '.git')), false);
    const script = path.join(outer, 'recover-claim-provenance.sh');
    copyFileSync(SCRIPT, script); chmodSync(script, mode);
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
    const log = path.join(outer, 'owned-calls.jsonl'); writeFileSync(log, '');
    for (const [name, file] of [['bash', '/bin/bash'], ['grep', '/usr/bin/grep'], ['sort', '/usr/bin/sort']]) {
      symlinkSync(file, path.join(bin, name));
    }
    const git = path.join(bin, 'git');
    writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2),cwd=process.cwd();\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'git',args,cwd})+'\\n');\nif(cwd!==${JSON.stringify(cwd)}||JSON.stringify(args)!==JSON.stringify(['rev-parse','--show-toplevel'])){fs.writeSync(2,'OWNED_RECOVERY_STUB_REJECTED\\n');process.exit(89);}\nfs.writeSync(1,${JSON.stringify(cwd + '\n')});\n`);
    chmodSync(git, 0o755);
    const npm = path.join(bin, 'npm');
    // The exit event records this fixed stub's own exit, never a real validator.
    writeFileSync(npm, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2),cwd=process.cwd();\nif(cwd!==${JSON.stringify(cwd)}||JSON.stringify(args)!==JSON.stringify(['run','validate:claims','--silent'])){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'npm',args,cwd,rejected:true})+'\\n');fs.writeSync(2,'OWNED_RECOVERY_STUB_REJECTED\\n');process.exit(90);}\nprocess.on('exit',exit_code=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'npm',args,cwd,exit_code,stub_refusal:${JSON.stringify(VALIDATOR_REFUSAL)}})+'\\n'));\nfs.writeSync(2,${JSON.stringify(VALIDATOR_REFUSAL)});\nprocess.exit(1);\n`);
    chmodSync(npm, 0o755);
    const expectedCalls = [
      { tool: 'git', args: ['rev-parse', '--show-toplevel'], cwd },
      { tool: 'npm', args: ['run', 'validate:claims', '--silent'], cwd, exit_code: 1, stub_refusal: VALIDATOR_REFUSAL },
    ];
    function invoke(args, { direct = false, context } = {}) {
      writeFileSync(log, '');
      const before = snapshot(outer, log);
      const result = spawnSync(direct ? script : '/bin/bash', direct ? args : ['--noprofile', '--norc', script, ...args], {
        cwd, env: { PATH: bin, HOME: cwd, TMPDIR: outer, LANG: 'C', LC_ALL: 'C' },
        encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
      });
      assert.equal(result.error, undefined, 'fixture must launch and stay within its bounds');
      assert.equal(result.signal, null, 'fixture child must terminate normally');
      assert.doesNotMatch(result.stdout + result.stderr,
        /OWNED_RECOVERY_STUB_REJECTED|command not found|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:/,
        'missing tools, stub routing and generated syntax are prerequisites');
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      if (calls.length) assert.deepEqual(calls, expectedCalls, 'only the exact old lookup and failed fixed npm stub may run');
      assert.deepEqual(snapshot(outer, log), before, 'owned names, bytes and symlink targets must remain unchanged');
      assert.deepEqual(readFileSync(SCRIPT), original, 'actual source stays unchanged');
      if (context) {
        if (calls.length) {
          assert.equal(result.status, 0, 'old false-success witness must terminate successfully');
          assert.equal(result.stdout, OLD_SUCCESS); assert.equal(result.stderr, '');
        }
        context.diagnostic('RECOVERY_REFUSAL_WITNESS ' + JSON.stringify({
          case: 'default-refused-validator', exit_code: result.status,
          git_calls: calls.filter((call) => call.tool === 'git').length,
          npm_calls: calls.filter((call) => call.tool === 'npm').length,
          stub_refusal_observed: calls.some((call) => call.tool === 'npm' && call.exit_code === 1 && call.stub_refusal === VALIDATOR_REFUSAL),
          false_empty_success: result.status === 0 && result.stdout === OLD_SUCCESS,
          inputs_unchanged: true,
        }));
      }
      return { ...result, calls };
    }
    return check({ cwd, outer, invoke });
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

function refused(result) {
  assert.equal(result.status, 1, 'automatic recovery must refuse');
  assert.equal(result.stdout, ''); assert.equal(result.stderr, REFUSAL);
  assert.deepEqual(result.calls, []);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SENTINEL));
}

test('default recovery refuses the fixed swallowed-validator false success', (t) => withFixture((f) => {
  refused(f.invoke([], { context: t }));
}));

test('executable recovery entry refuses --push before any tool or ref action', () => withFixture((f) => {
  refused(f.invoke(['--push'], { direct: true }));
}));

test('recovery treats unusual options and missing or directory operands as private inert arguments', () => withFixture((f) => {
  const missing = path.join(f.cwd, SENTINEL + '-missing.yml');
  assert.equal(existsSync(missing), false);
  refused(f.invoke(['--push=true', '--no-rerun', '--help', missing, f.cwd, SENTINEL + '; $(not-a-command)']));
}));
