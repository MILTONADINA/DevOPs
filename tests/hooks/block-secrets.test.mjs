// hooks/universal/pre-tool/block-secrets.sh: a secret path is refused (exit 2) however
// its name is cased, and the example-file allowlist applies only to the file named,
// not to any path that contains an example name. Runs the hook in a disposable
// directory; no file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-secrets.sh');

function decide(file) {
  const dir = mkdtempSync(path.join(tmpdir(), 'block-secrets-'));
  try {
    const result = spawnSync('bash', [HOOK, file, 'read'], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(result.error, undefined, String(result.error));
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BLOCKED = [
  '.env',
  'app/.env.production',
  '.ENV',
  'config/.Env.Local',
  '/home/toy/.ssh/ID_RSA',
  'deploy/Credentials.json',
  'certs/server.PEM',
  'config/.env.example/../.env',
  'fixtures/.env.example.dir/.env',
  '.env.example.real',
];
const ALLOWED = [
  '.env.example',
  'app/.env.template',
  'app/.ENV.SAMPLE',
  'src/index.ts',
  'README.md',
];

for (const file of BLOCKED) {
  test(`block-secrets refuses: ${file}`, () => assert.equal(decide(file), 2));
}
for (const file of ALLOWED) {
  test(`block-secrets allows: ${file}`, () => assert.equal(decide(file), 0));
}

// The refusal is appended to .workflow/state/events.jsonl as one JSON object per line. The path
// and operation are caller-supplied text, so they must be escaped: a quote, backslash, newline or
// control character in them must neither break the line nor add keys. Issue #426.
function logged(file, operation, { shell = 'bash', locale = 'C' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'block-secrets-log-'));
  try {
    const result = spawnSync(shell, [HOOK, file, operation], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: locale } });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 2, result.stderr);
    return readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Bytes 0x80 and above (UTF-8) pass through unchanged in every locale, including under macOS
// /bin/bash 3.2, which reports them as negative character codes.
const SHELLS = ['bash', ...(existsSync('/bin/bash') ? ['/bin/bash'] : [])];
for (const shell of SHELLS) {
  for (const locale of ['C', 'en_US.UTF-8']) {
    test(`block-secrets logs a non-ASCII path unchanged (${shell}, LC_ALL=${locale})`, () => {
      const file = 'caf\u00e9/\u65e5\u672c/.env';
      const entry = JSON.parse(logged(file, 'read', { shell, locale }).trim());
      assert.equal(entry.path, file);
    });
  }
}

const LOG_CASES = [
  ['secrets/.env"quoted', 'read'],
  ['back\\slash/.env\\n\\"x', 'write'],
  ['multi/.env\nline two\r\ttab\u0001ctl', 'read'],
  ['.env","event":"forged","path":"x', 'write'],
  ['trailing-backslash.env\\', 'read'],
];
for (const [file, operation] of LOG_CASES) {
  test(`block-secrets logs one JSON object that round-trips the path: ${JSON.stringify(file)}`, () => {
    const text = logged(file, operation);
    assert.equal(text.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}`);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry), ['ts', 'event', 'path', 'operation']);
    assert.equal(entry.event, 'secret_block');
    assert.equal(entry.path, file);
    assert.equal(entry.operation, operation);
  });
}
