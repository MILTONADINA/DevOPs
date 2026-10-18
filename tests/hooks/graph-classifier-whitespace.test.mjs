// REQ-M16 / AC-M16.9: shell blanks, quoted literals and harmless Bash parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLASSIFIER = path.join(ROOT, 'hooks/universal/pre-tool/graph-command-classifier.mjs');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
const UNICODE = [
  '\u00a0', '\u2028', '\u2029', '\ufeff', '\u3000', '\u200b', '\u202e', '\u0085', '\u1680',
  ...Array.from({ length: 11 }, (_, index) => String.fromCodePoint(0x2000 + index)),
];
const OTHER = ['\r', '\v', '\f', '\u{e0001}', '\u{e0020}'];
const label = (value) => 'U+' + value.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
// Exercise the real tokenizer without adding a production export or changing
// the CLI contract. Decisions below still run through the actual CLI.
const source = readFileSync(CLASSIFIER, 'utf8');
const start = source.indexOf('function tokenize(text) {');
const end = source.indexOf('// Only these literal prefixes', start);
assert.ok(start >= 0 && end > start, 'locate the production tokenizer');
const tokenize = runInNewContext('const MAX_TEXT = 64 * 1024;\n' + source.slice(start, end) + '\ntokenize;');

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-whitespace-test-')));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function decide(dir, mode, command) {
  const result = spawnSync(process.execPath, [CLASSIFIER, mode, command], {
    cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const sep of [...UNICODE, ...OTHER]) {
  for (const [mode, command] of [
    ['deploy', 'vercel deploy --prod'],
    ['sealed', 'git update-ref refs/tags/v0.2.0 deadbeef'],
  ]) {
    test(`AC-M16.9 ${mode} refuses unquoted ${label(sep)} before #`, () => {
      withProject((dir) => {
        const result = decide(dir, mode, `: ${sep}#; ${command}`);
        assert.equal(result.decision, 'block', result.reason);
        assert.match(result.reason, /unsupported command syntax: unsupported whitespace or format character/);
        assert.equal(decide(dir, mode, `: # ${sep}`).decision, 'block', 'comments are outside quotes too');
      });
    });
  }
  test(`AC-M16.9 ${label(sep)} stays literal only inside quotes`, () => {
    withProject((dir) => {
      for (const quote of ["'", '"']) {
        const literal = `a${sep}#;&&|| b`;
        const entries = tokenize(`: ${quote}${literal}${quote}; true`);
        assert.equal(entries.length, 2);
        assert.equal(entries[0].words.length, 2);
        assert.equal(entries[0].words[1].text, literal, 'no normalization, stripping or operator splitting');
        assert.equal(entries[1].words[0].text, 'true');
        assert.equal(decide(dir, 'deploy', `: ${quote}${literal}${quote}`).decision, 'allow');
        assert.equal(decide(dir, 'sealed', `: ${quote}${literal}${quote}`).decision, 'allow');
        assert.equal(decide(dir, 'deploy', `: ${quote}${literal}${quote}; vercel deploy --prod`).decision, 'block');
        assert.equal(decide(dir, 'sealed', `: ${quote}${literal}${quote}; git update-ref refs/tags/v0.2.0 deadbeef`).decision, 'block');
      }
      for (const prefix of [': ', ': a', ': \\']) {
        assert.throws(() => tokenize(prefix + sep), /unsupported whitespace or format character/);
      }
    });
  });
}

test('AC-M16.9 ASCII shell blanks, newline and comments retain their roles', () => {
  for (const sep of [' ', '\t']) {
    const entries = tokenize(`:${sep}word\ntrue`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].words.length, 2);
    assert.equal(entries[0].words[1].text, 'word');
    assert.equal(entries[1].words[0].text, 'true');
    assert.equal(tokenize(`:${sep}#; false\ntrue`)[1].words[0].text, 'true');
  }
});

for (const sep of [' ', '\t', ...UNICODE]) {
  test(`AC-M16.9 harmless Bash differential matrix for ${label(sep)}`, (t) => {
    withProject((dir) => {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      const stub = path.join(bin, 'STUBCMD');
      const marker = path.join(dir, 'marker');
      // No deploy/Git command is ever evaluated. The stub uses only a shell
      // builtin redirection to create its marker; PATH contains only this bin.
      writeFileSync(stub, '#!/bin/bash\n: > "$MARKER"\n', { mode: 0o700 });
      const failures = [];
      let cases = 0;
      let executed = 0;
      for (const prefix of [':', 'true', 'false', 'printf x']) {
        for (const hash of ['', '#']) {
          for (const operator of [';', '&&', '||', '|', '\n']) {
            const command = `${prefix}${sep}${hash}${operator} '${stub}'`;
            rmSync(marker, { force: true });
            const result = decide(dir, 'deploy', command);
            const shell = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
              cwd: dir, env: { PATH: bin, LC_ALL: 'C', MARKER: marker }, encoding: 'utf8', timeout: 5_000,
            });
            assert.equal(shell.error, undefined);
            assert.equal(shell.signal, null);
            assert.ok(Number.isInteger(shell.status), 'Bash exited normally (command-not-found is expected)');
            cases++;
            if (!existsSync(marker)) continue;
            executed++;
            let visible = false;
            try { visible = tokenize(command).some((entry) => entry.words[0]?.text === stub); }
            catch { /* A tokenizer refusal must also be a CLI block. */ }
            if (!visible && result.decision !== 'block') failures.push(JSON.stringify(command));
          }
        }
      }
      t.diagnostic(`${cases} cases; ${executed} stub executions; ${failures.length} mismatches`);
      assert.equal(cases, 40);
      assert.ok(executed > 0, 'the differential oracle must execute the stub');
      assert.deepEqual(failures, [], 'every executed stub is visible as a command or refused');
    });
  });
}
