// specs/verification/triage-replay-refusal.md REQ-1..4 / AC-1..4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync,
  symlinkSync, rmSync, existsSync, realpathSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ID = 'claim-2026-10-04-902';
const MARKER = 'FIXED OWNED TRIAGE PROBE EXECUTED\n';
const SENTINEL = 'TRIAGE_PRIVATE_SENTINEL';
const REFUSAL = 'claim triage: command replay is disabled\n';
const EXPORTS = ['CAUSES', 'buildQuestions', 'failingIdsFromLog', 'redactTail', 'renderTable', 'triageOne'];
const PYTHON_SOURCE = 'import json,sys,yaml;c=yaml.safe_load(open(sys.argv[1]))["claim"];p=c.get("proof",{});print(json.dumps({"description":c.get("description",""),"test_command":p.get("test_command",""),"expected_exit":p.get("test_exit_code",0)}))';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

function tree(directory, ignored) {
  return readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    if (ignored.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...tree(file, ignored)];
    return [[file, stat.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : hash(readFileSync(file))]];
  });
}

function fixture() {
  for (const file of ['/bin/bash', ...['triage-claims.mjs', 'jev.mjs'].map((n) => path.join(ROOT, 'scripts', n))]) {
    assert.ok(existsSync(file), `fixture prerequisite missing: ${file}`);
  }
  const state = path.join(ROOT, '.workflow/state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'triage-refusal-')));
  const cwd = path.join(outer, 'consumer');
  const scripts = path.join(outer, 'package/scripts');
  const bin = path.join(outer, 'bin');
  const triage = path.join(scripts, 'triage-claims.mjs');
  assert.match(triage, /^\/[A-Za-z0-9_./-]+$/, 'fixture requires a direct-entry-safe ASCII path');
  const log = path.join(cwd, 'owned-validator.log');
  const report = path.join(cwd, 'owned-report.md');
  const marker = path.join(cwd, 'owned-probe-marker');
  const claim = path.join(cwd, '.workflow/proofs', `${ID}.yml`);
  const callsPath = path.join(outer, 'calls.jsonl');
  mkdirSync(scripts, { recursive: true }); mkdirSync(bin);
  mkdirSync(path.dirname(claim), { recursive: true });
  mkdirSync(path.join(cwd, '.workflow/state'));
  for (const name of ['triage-claims.mjs', 'jev.mjs']) copyFileSync(path.join(ROOT, 'scripts', name), path.join(scripts, name));
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(claim, 'Owned synthetic placeholder; the fixed Python seam never reads this file.\n');
  writeFileSync(log, `✗ ${ID}\n`);
  writeFileSync(callsPath, '');
  symlinkSync('/bin/bash', path.join(bin, 'bash'));
  const probe = path.join(outer, 'fixed-probe.cjs');
  // This is the only old-source declared command. Actual Bash launches the
  // absolute current Node executable and this fixed owned, non-networked body.
  writeFileSync(probe, `const fs=require('node:fs');\nif(process.argv.length!==2)process.exit(91);\nfs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(MARKER)});\n`);
  const command = `${quote(process.execPath)} ${quote(probe)}`;
  const declaration = { description: 'Fixed owned triage witness.', test_command: command, expected_exit: 0 };
  const git = path.join(bin, 'git');
  writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({tool:'git',args})+'\\n');\nif(JSON.stringify(args)!==JSON.stringify(['rev-parse','--show-toplevel'])){fs.writeSync(2,'OWNED_STUB_UNEXPECTED_ARGV\\n');process.exit(89);}\nfs.writeSync(1,${JSON.stringify(cwd + '\n')});\n`);
  chmodSync(git, 0o755);
  const python = path.join(bin, 'python3');
  writeFileSync(python, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({tool:'python3',args})+'\\n');\nif(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(['-c', PYTHON_SOURCE, claim])})){fs.writeSync(2,'OWNED_STUB_UNEXPECTED_ARGV\\n');process.exit(90);}\nfs.writeSync(1,${JSON.stringify(JSON.stringify(declaration) + '\n')});\n`);
  chmodSync(python, 0o755);
  function invoke(args, { entry = triage, context } = {}) {
    writeFileSync(callsPath, '');
    const ignored = [callsPath, marker, report];
    const before = tree(outer, ignored);
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd, env: { PATH: bin, HOME: cwd, TMPDIR: outer, LANG: 'C' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 262144,
    });
    assert.equal(result.error, undefined, 'fixture launch must not time out or overflow');
    assert.equal(result.signal, null, 'fixture child must terminate normally');
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|OWNED_STUB_UNEXPECTED_ARGV/,
      'loader/stub syntax or routing failures are prerequisites, not intended refusal');
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    for (const call of calls) assert.deepEqual(call, call.tool === 'git'
      ? { tool: 'git', args: ['rev-parse', '--show-toplevel'] }
      : { tool: 'python3', args: ['-c', PYTHON_SOURCE, claim] });
    const artifacts = { probe: existsSync(marker), report: existsSync(report) };
    if (artifacts.probe) assert.equal(readFileSync(marker, 'utf8'), MARKER);
    const reportBytes = artifacts.report ? readFileSync(report) : null;
    if (reportBytes) {
      assert.match(reportBytes.toString('utf8'), /^# Claim triage \d{4}-\d{2}-\d{2}\n/);
      assert.match(reportBytes.toString('utf8'), /\| claim \| exit \| cause \|/);
    }
    assert.deepEqual(tree(outer, ignored), before, 'only exact observed calls/marker/report outputs may differ');
    if (context) {
      if (calls.length || artifacts.probe || artifacts.report) {
        assert.equal(artifacts.probe, true, 'old witness must execute the actual fixed probe');
        assert.equal(result.status, 0, 'old witness must finish successfully before refusal assertion');
        assert.deepEqual(calls.map((call) => call.tool), ['git', 'python3']);
        assert.ok(artifacts.report); assert.match(reportBytes.toString('utf8'), /\| passes_now \|/);
        assert.doesNotMatch(output, /JevUnavailableError|unclassified|->/);
      }
      context.diagnostic('TRIAGE_REPLAY_WITNESS ' + JSON.stringify({ case: 'fixed-owned-success',
        exit_code: result.status, git_calls: calls.filter((call) => call.tool === 'git').length,
        python_calls: calls.filter((call) => call.tool === 'python3').length,
        probe_executed: artifacts.probe, probe_sha256: artifacts.probe ? hash(MARKER) : null,
        report_written: artifacts.report, report_sha256: reportBytes ? hash(reportBytes) : null,
        passes_now: reportBytes ? reportBytes.toString('utf8').includes('| passes_now |') : false,
        inputs_unchanged: true }));
    }
    return { ...result, output, calls, artifacts };
  }
  return { outer, cwd, scripts, triage, log, report, invoke,
    cleanup() { rmSync(outer, { recursive: true, force: true }); } };
}

function withFixture(run) { const f = fixture(); try { return run(f); } finally { f.cleanup(); } }
function inert(result) {
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.artifacts, { probe: false, report: false });
}
function refused(result) {
  assert.equal(result.status, 1, 'direct triage must refuse');
  assert.equal(result.stdout, ''); assert.equal(result.stderr, REFUSAL);
  assert.doesNotMatch(result.output, new RegExp(SENTINEL));
  inert(result);
}

test('direct triage refuses before the fixed owned successful proof', (t) => withFixture((f) => {
  refused(f.invoke(['--from-log', f.log, '--out', f.report, '--timeout-s', '2'], { context: t }));
}));

test('direct triage refuses no arguments and incomplete log option privately', () => {
  for (const args of [[], ['--from-log']]) withFixture((f) => refused(f.invoke(args)));
});

test('direct triage refuses empty and malformed owned selections without reports', () => {
  for (const text of ['', `✓ ${ID}\n`, '✗ claim-not-an-id\n']) withFixture((f) => {
    writeFileSync(f.log, text);
    refused(f.invoke(['--from-log', f.log, '--out', f.report]));
  });
});

test('direct triage refusal precedes missing and directory log input errors', () => {
  for (const directory of [false, true]) withFixture((f) => {
    const input = directory ? f.cwd : path.join(f.cwd, SENTINEL + '-missing.log');
    refused(f.invoke(['--from-log', input, '--out', f.report]));
  });
});

test('direct triage refuses inert unusual options and opt-in lookalikes', () => {
  for (const option of ['--no-rerun', '--help', '--no-rerun=true']) withFixture((f) => {
    writeFileSync(f.log, '');
    refused(f.invoke(['--from-log', f.log, '--out', f.report, '--concurrency', '2', '--timeout-s', '1',
      option, '--opaque', SENTINEL + '; $(not-a-command)']));
  });
});

test('import preserves all six exports without entering the CLI (regression guard)', () => withFixture((f) => {
  const caller = path.join(f.outer, 'import-only.mjs');
  writeFileSync(caller, `import * as api from './package/scripts/triage-claims.mjs';\nconsole.log(JSON.stringify(Object.keys(api).sort()));\n`);
  const result = f.invoke([], { entry: caller });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(EXPORTS) + '\n'); inert(result);
}));

test('injected triage helper remains callable without CLI processes (regression guard)', () => withFixture((f) => {
  const caller = path.join(f.outer, 'injected.mjs');
  writeFileSync(caller, `import {triageOne} from './package/scripts/triage-claims.mjs';\nlet calls=0;\nglobalThis.fetch=()=>{throw Error('UNEXPECTED_NETWORK');};\nconst row=await triageOne({id:'owned-id',description:'owned',test_command:'inert text',expected_exit:0,actual_exit:1,output_tail:'owned'}, {evaluateImpl:async()=>{calls++;return {answers:{cause:{type:'choice',choice:'proof_script_defect',confidence:0.95,probabilities:{proof_script_defect:0.95}},repin_would_fix:{type:'noul',noul:0.1}}};}});\nconsole.log(JSON.stringify({calls,cause:row.cause,escalate:row.escalate,repin:row.repin}));\n`);
  const result = f.invoke([], { entry: caller });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ calls: 1, cause: 'proof_script_defect', escalate: false, repin: false }) + '\n');
  inert(result);
}));

test('symlink entry preserves the existing inert guard quirk (regression guard)', () => withFixture((f) => {
  const alias = path.join(f.outer, 'triage-alias.mjs');
  symlinkSync(f.triage, alias);
  const result = f.invoke(['--from-log', f.log, '--out', f.report], { entry: alias });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  inert(result);
}));
