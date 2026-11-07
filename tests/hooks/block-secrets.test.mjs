// hooks/universal/pre-tool/block-secrets.sh: a secret path is refused (exit 2) however
// its name is cased, and the example-file allowlist applies only to the file named,
// not to any path that contains an example name. Runs the hook in a disposable
// directory; no file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
