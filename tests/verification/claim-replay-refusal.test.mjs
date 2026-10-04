// specs/verification/claim-replay-refusal.md REQ-1..4 / AC-1..4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync,
  symlinkSync, rmSync, rmdirSync, existsSync, realpathSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const FILES = ['claim-validator.ts', 'claim-schema.yml', 'claim-input.ts', 'committed-claims.ts', 'committed-git.ts'];
const SHA = 'a'.repeat(40);
const ID = 'claim-2026-10-04-901';
const COMMAND = 'owned-proof-probe';
const MARKER = 'FIXED OWNED PROBE EXECUTED\n';
const SENTINEL = 'CLAIM_REPLAY_PRIVATE_SENTINEL';
const REFUSAL = 'claim validation: command replay is disabled; use --no-rerun\n';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const GIT_CALLS = [['rev-parse', '--verify', `${SHA}^{commit}`], ['show', '--name-only', '--pretty=format:', SHA]];

function tree(directory, ignored) {
  return readdirSync(directory).sort().flatMap((name) => {
    const file = path.join(directory, name);
    if (ignored.includes(file)) return [];
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[file, 'directory'], ...tree(file, ignored)];
    return [[file, stat.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : hash(readFileSync(file))]];
  });
}

function fixture({ gitFails = false } = {}) {
  for (const file of [TSX, ...FILES.map((name) => path.join(ROOT, 'verification', name))]) {
    assert.ok(existsSync(file), `fixture prerequisite missing: ${file}`);
  }
  const state = path.join(ROOT, '.workflow/state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'claim-replay-')));
  const pkg = path.join(outer, 'package');
  const cwd = path.join(outer, 'consumer');
  const bin = path.join(outer, 'bin');
  const ipc = path.join(outer, 'launcher-temp');
  const proofs = path.join(cwd, '.workflow/proofs');
  const validator = path.join(pkg, 'verification/claim-validator.ts');
  const schema = path.join(pkg, 'verification/claim-schema.yml');
  const claim = path.join(proofs, `${ID}.yml`);
  const gitLog = path.join(outer, 'git-calls.jsonl');
  const marker = path.join(cwd, 'probe-executed');
  const outputs = [];
  mkdirSync(path.dirname(validator), { recursive: true });
  mkdirSync(proofs, { recursive: true }); mkdirSync(bin); mkdirSync(ipc);
  writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}\n');
  for (const name of FILES) copyFileSync(path.join(ROOT, 'verification', name), path.join(pkg, 'verification', name));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  writeFileSync(path.join(cwd, 'claimed.txt'), 'owned fixture content\n');
  writeFileSync(gitLog, '');
  const git = path.join(bin, 'git');
  writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(args)+'\\n');\nconst expected=${JSON.stringify(GIT_CALLS)};\nconst at=expected.findIndex(v=>JSON.stringify(v)===JSON.stringify(args));\nif(at<0)process.exit(89);\nif(${JSON.stringify(gitFails)}){fs.writeSync(2,'owned Git metadata refusal\\n');process.exit(7);}\nfs.writeSync(1,at===0?${JSON.stringify(`${SHA}\n`)}:'claimed.txt\\n');\n`);
  chmodSync(git, 0o755);
  const probe = path.join(bin, COMMAND);
  // The only executable declaration used by old-source RED is this fixed,
  // owned, non-networked probe. No argument or claim field selects its path.
  writeFileSync(probe, `#!${process.execPath}\nconst fs=require('node:fs');\nif(process.argv.length!==2)process.exit(90);\nfs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(MARKER)});\n`);
  chmodSync(probe, 0o755);
  const data = { claim: { id: ID, type: 'doc', spec_ref: 'specs/fixture.md#ac-1',
    description: 'Synthetic replay-refusal declaration.',
    proof: { git_sha: SHA, files_changed: ['claimed.txt'], test_command: COMMAND,
      test_exit_code: 0, test_output_path: '.workflow/proofs/fixture-output.log',
      environment: { NOTE: SENTINEL } },
    confidence: 'high', timestamp: '2026-10-04T12:34:56Z', reproducibility_hash: '' } };
  function save(file = claim, value = data) {
    const c = value.claim;
    assert.equal(c.proof.test_command, COMMAND, 'fixture never permits arbitrary replay text');
    const env = c.proof.environment ?? {};
    c.reproducibility_hash = 'sha256:' + hash(`${c.proof.test_command}\n---\n${Object.keys(env).sort().map((key) => `${key}=${env[key]}`).join('\n')}\n---\n${c.proof.git_sha}`);
    const output = path.resolve(cwd, c.proof.test_output_path + '.rerun');
    assert.equal(path.dirname(output), proofs, 'only the owned literal proof directory may receive old replay output');
    if (!outputs.includes(output)) outputs.push(output);
    // JSON is a YAML subset; use the actual packaged parser/schema unchanged.
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
  save();
  return { outer, cwd, validator, schema, claim, proofs, data, save,
    invoke(args, { witness, context } = {}) {
      writeFileSync(gitLog, '');
      const ignored = [gitLog, ipc, marker, ...outputs];
      const before = tree(outer, ignored);
      const result = spawnSync(process.execPath, [TSX, validator, ...args], {
        cwd, env: { PATH: bin, HOME: cwd, TMPDIR: ipc, LANG: 'C', TSX_DISABLE_CACHE: '1' },
        encoding: 'utf8', timeout: 15000, maxBuffer: 524288,
      });
      assert.equal(result.error, undefined, 'fixture launch must complete without timeout or buffer error');
      assert.equal(result.signal, null, 'fixture child must terminate normally');
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)|SyntaxError:|TypeError:|\n\s+at /,
        'a loader or fixture exception is not an intended refusal');
      const calls = readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const artifacts = { probe: existsSync(marker), rerun: outputs.filter((file) => existsSync(file)).map((file) => readFileSync(file)) };
      if (artifacts.probe) assert.equal(readFileSync(marker, 'utf8'), MARKER, 'only the fixed probe marker is permitted');
      for (const bytes of artifacts.rerun) assert.match(bytes.toString('utf8'), /^OK \(\d+ms\)$/, 'only the bounded old replay receipt is permitted');
      assert.deepEqual(tree(outer, ignored), before, 'inputs/source remain unchanged outside exact logs, IPC and separately captured witnesses');
      if (witness) {
        // Emitted before the decisive refusal assertion. Root retains these
        // bounded facts from the SAME mixed RED run; no preliminary replay.
        context.diagnostic('REPLAY_WITNESS ' + JSON.stringify({ case: witness, exit_code: result.status,
          git_calls: calls.length, git_failure_reported: output.includes('does not exist in this repository'),
          hash_failure_reported: output.includes('reproducibility_hash mismatch'),
          probe_executed: artifacts.probe, probe_sha256: artifacts.probe ? hash(MARKER) : null,
          rerun_count: artifacts.rerun.length, rerun_sha256: artifacts.rerun.map(hash),
          inputs_unchanged: true }));
      }
      return { ...result, output, calls, artifacts };
    }, cleanup() { rmSync(outer, { recursive: true, force: true }); } };
}

function withFixture(run, options) { const f = fixture(options); try { return run(f); } finally { f.cleanup(); } }
function noReplay(result) {
  assert.equal(result.artifacts.probe, false, 'declared probe must stay inert');
  assert.deepEqual(result.artifacts.rerun, [], 'validator must not create replay artifacts');
}
function refused(result) {
  assert.equal(result.status, 1, 'omitted opt-in must refuse');
  assert.equal(result.stderr, REFUSAL);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.output, new RegExp(SENTINEL));
  assert.deepEqual(result.calls, [], 'admission must precede Git metadata');
  noReplay(result);
}
function accepted(result, ids) {
  assert.equal(result.status, 0, result.output);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, ids.map((id) => `✓ ${id}\n`).join('') + `\n${ids.length}/${ids.length} claims valid\n`);
  assert.deepEqual(result.calls, ids.flatMap(() => GIT_CALLS));
  noReplay(result);
}

test('omitted flag refuses valid explicit metadata before the fixed owned probe', (t) => withFixture((f) => {
  refused(f.invoke([f.claim], { witness: 'valid-metadata', context: t }));
}));

test('omitted flag refuses before replay even with deliberate Git and hash failures', (t) => withFixture((f) => {
  f.data.claim.reproducibility_hash = 'sha256:' + '0'.repeat(64);
  writeFileSync(f.claim, JSON.stringify(f.data) + '\n');
  refused(f.invoke([f.claim], { witness: 'invalid-git-and-hash', context: t }));
}, { gitFails: true }));

test('omitted flag refuses implicit nonempty discovery', () => withFixture((f) => {
  refused(f.invoke([]));
}));

test('omitted flag refuses no-argument empty selection before absent schema', () => {
  for (const present of [false, true]) withFixture((f) => {
    rmSync(f.claim); rmSync(f.schema);
    if (!present) rmdirSync(f.proofs);
    refused(f.invoke([]));
  });
});

test('omitted flag has private usage precedence over malformed, missing and schema inputs', () => {
  for (const kind of ['malformed', 'missing', 'schema']) withFixture((f) => {
    if (kind === 'malformed') writeFileSync(f.claim, `claim: [${SENTINEL}\n`);
    if (kind === 'missing') rmSync(f.claim);
    if (kind === 'schema') rmSync(f.schema);
    const selected = kind === 'missing' ? path.join(f.proofs, SENTINEL + '.yml') : f.claim;
    refused(f.invoke([selected]));
  });
});

test('lookalike opt-in token cannot enable legacy replay', () => withFixture((f) => {
  refused(f.invoke([f.claim, '--no-rerun=1']));
}));

test('flagged explicit single and multiple claims preserve metadata results (regression guard)', () => {
  // Mutation guard: do not replace omitted-mode replay with blanket metadata refusal.
  for (const multiple of [false, true]) withFixture((f) => {
    const files = [f.claim]; const ids = [ID];
    if (multiple) {
      const second = structuredClone(f.data); second.claim.id = 'claim-2026-10-04-902';
      second.claim.proof.test_output_path = '.workflow/proofs/second-output.log';
      const file = path.join(f.proofs, second.claim.id + '.yml');
      f.save(file, second); files.push(file); ids.push(second.claim.id);
    }
    accepted(f.invoke([...files, '--no-rerun']), ids);
  });
});

test('flagged implicit nonempty and empty discovery remain compatible (regression guard)', () => {
  // Mutation guard: preserve the old empty shortcut, even without packaged schema.
  withFixture((f) => accepted(f.invoke(['--no-rerun']), [ID]));
  for (const present of [false, true]) withFixture((f) => {
    rmSync(f.claim); rmSync(f.schema);
    if (!present) rmdirSync(f.proofs);
    const result = f.invoke(['--no-rerun']);
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'No claim files to validate.\n');
    assert.deepEqual(result.calls, []); noReplay(result);
  });
});

test('flagged invalid Git and hash metadata still refuse without replay (regression guard)', () => {
  // Mutation guard: removing replay does not turn failed metadata into acceptance.
  withFixture((f) => {
    f.data.claim.reproducibility_hash = 'sha256:' + '0'.repeat(64);
    writeFileSync(f.claim, JSON.stringify(f.data) + '\n');
    const result = f.invoke([f.claim, '--no-rerun']);
    assert.equal(result.status, 1); assert.equal(result.stderr, '');
    assert.match(result.stdout, /does not exist in this repository/);
    assert.match(result.stdout, /reproducibility_hash mismatch/);
    assert.match(result.stdout, /0\/1 claims valid\n$/);
    assert.deepEqual(result.calls, GIT_CALLS); noReplay(result);
  }, { gitFails: true });
});

test('committed selector usage keeps precedence and its exact diagnostic (regression guard)', () => {
  // Mutation guard: do not replace the existing committed argument parser.
  for (const args of [['--all'], ['--claim', ID], ['--all=1'], [`--claim=${ID}`]]) withFixture((f) => {
    rmSync(f.schema);
    const result = f.invoke(args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'committed: usage\n');
    assert.deepEqual(result.calls, []); noReplay(result);
  });
});
