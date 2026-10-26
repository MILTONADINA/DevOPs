// specs/security/history-secret-scan-baseline.md REQ-HSB-1: the root .gitleaksignore lists only
// exact git-mode fingerprints (commit:file:rule:line), nothing broader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FINGERPRINT = /^[0-9a-f]{40}:[^:\s*?[\]{}]+:[a-z0-9][a-z0-9-]*:(?:[1-9][0-9]*|\*{3})$/;
const entries = (text) => text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

test('REQ-HSB-1: every active .gitleaksignore line is an exact commit:file:rule:line fingerprint', () => {
  const lines = entries(readFileSync(path.join(ROOT, '.gitleaksignore'), 'utf8'));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, FINGERPRINT, line);
  assert.equal(new Set(lines).size, lines.length, 'no duplicate fingerprints');
});

test('REQ-HSB-1: the grammar refuses broader or malformed entries', () => {
  const commit = 'a'.repeat(40);
  for (const bad of [`${commit}:toy/*.txt:jwt:3`, `${commit}:toy.txt:jwt`, `${commit}:toy.txt:jwt:0`,
    `${commit.slice(1)}:toy.txt:jwt:3`, 'toy/dir/', 'jwt', `${commit}:toy.txt::3`, `${commit}:toy.txt:jwt:3-9`]) {
    assert.doesNotMatch(bad, FINGERPRINT, bad);
  }
  assert.match(`${'b'.repeat(40)}:toy/file.txt:jwt:12`, FINGERPRINT);
});
