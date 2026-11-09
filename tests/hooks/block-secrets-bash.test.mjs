// hooks/universal/pre-tool/block-secrets-bash.sh: the Bash command guard (specs/release/npm-package.md
// AC-30, issue #426). It splits the command text into words and runs block-secrets.sh on each one,
// so `cat .env` through Bash is refused as a file read would be. A convenience guard, not a
// security boundary: a command that builds a path at run time, or hides it behind a glob or a
// variable, is not caught (docs/HOOKS.md). Runs the hook in a disposable directory; no file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-secrets-bash.sh');
const SPEC = 'specs/release/npm-package.md';

// run-hook.mjs passes the command as the one argument.
function decide(command) {
  const dir = mkdtempSync(path.join(tmpdir(), 'block-secrets-bash-'));
  try {
    const result = spawnSync('bash', [HOOK, command], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, String(result.error));
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BLOCKED = [
  'cat .env',
  'cat ./config/.ENV',
  'less ~/.ssh/id_rsa',
  'cp a.pem b',
  'cat .env|wc',
  'cat <.env',
  '(cat .env)',
  'cat ".env"',
  "cat '.env'",
  'cat "unclosed .env',
  "cat 'unclosed .env",
  'cat .env;ls',
  'head -1 deploy/credentials.json',
  'cat .en""v',
  "cat .en''v",
  'cat \\.env',
  'cat ~/.SSH/ID_RSA',
  // A stray quote must not turn quote stripping off (review of #441).
  "cat .e''nv '",
  'cat .e""nv #\'',
  // Backslash-newline inside double quotes is removed, as bash removes it.
  'cat ".e\\\nnv"',
  // A command substitution inside a quoted string is checked, and backticks separate words.
  'echo "$(cat .env)"',
  'echo `cat server.key`',
  // Command text cannot pose as the tokenizer's status line.
  "\u0001OPEN cat .e''nv",
  // The record separator awk once used, or a newline, cannot start a fresh quote state (second review of #441).
  "cat '\u0001\u0002\u0003' .env '\u0001\u0002\u0003 x",
  "cat '\n' .env '\n x",
  // Quotes and backslashes inside a substitution in a quoted string belong to the inner shell.
  "echo \"$(cat .e''nv)\"",
  'echo "$(cat .e\\nv)"',
  "echo \"$(cat '.e'nv)\"",
  'cat \\\n.env',
  'cat SERVICE-ACCOUNT',
];
const ALLOWED = [
  'cat .env.example',
  'ls src',
  'git commit -m "fix .env loading"',
  "git commit -m 'fix .env loading'",
  'echo hi',
  '',
  'cat <<EOF\nhello world\nEOF',
  'echo "it is $(date)"',
  'echo "multi\nline message with .env inside"',
  "git commit -m 'it'\\''s fine'",
];

for (const command of BLOCKED) {
  test(`block-secrets-bash refuses ${JSON.stringify(command)} (${SPEC}#ac-30)`, () => assert.equal(decide(command), 2));
}
for (const command of ALLOWED) {
  test(`block-secrets-bash allows ${JSON.stringify(command)} (${SPEC}#ac-30)`, () => assert.equal(decide(command), 0));
}

// A long command (a big heredoc) must still be decided well inside a hook timeout: the split is one
// awk pass and the check runs in-process, so this takes well under a second, not minutes.
// About 89 KB: under Linux's 128 KB limit on one argument (MAX_ARG_STRLEN), which this hook gets its command in.
const LONG = Array.from({ length: 10000 }, (_, i) => `word${i}`).join(' ');
test(`block-secrets-bash decides a 10000-word command quickly (${SPEC}#ac-30)`, () => {
  const started = process.hrtime.bigint();
  assert.equal(decide(`echo ${LONG}`), 0);
  assert.equal(decide(`echo ${LONG} ; cat .env`), 2);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e9 < 20, 'both runs finish in under 20 s');
});

// Without awk the command cannot be split, so the hook blocks rather than passing an unchecked command.
test(`block-secrets-bash blocks when awk is missing (${SPEC}#ac-30)`, () => {
  const bin = mkdtempSync(path.join(tmpdir(), 'block-secrets-bash-bin-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'block-secrets-bash-'));
  try {
    for (const tool of ['bash', 'tr', 'mkdir', 'date', 'cat']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, path.join(bin, tool));
    }
    const result = spawnSync(path.join(bin, 'bash'), [HOOK, 'ls src'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: bin } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /awk is not on PATH/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// Only a word that passes the filter in check_word (and in the awk flush) reaches secret_check. Every
// entry block-secrets.sh blocks on must pass that filter, or a new entry would never be checked in Bash.
test(`every block-secrets.sh pattern passes the Bash guard's word filter (${SPEC}#ac-30)`, () => {
  const source = readFileSync(path.join(path.dirname(HOOK), 'block-secrets.sh'), 'utf8');
  const entries = ['PATTERNS', 'EXT_BLOCK'].flatMap(name => {
    const block = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'm'));
    assert.ok(block, `${name} found in block-secrets.sh`);
    return [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  });
  assert.ok(entries.length > 20, 'the lists were read');
  for (const entry of entries) {
    assert.match(entry.toLowerCase(), /[./]|id_|service-account/, `${entry} passes the filter`);
    assert.equal(decide(`cat x${entry}`), 2, `cat x${entry} is refused`);
  }
});
