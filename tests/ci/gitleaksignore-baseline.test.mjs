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

// AC-HSB-1.2: the 2026-10-11 attribution rewrite gave the baselined fixtures new commit ids with
// identical trees, and the scheduled scan reports the new ids. Every baselined commit that the commit
// map replaces must also have its successor listed, for the same file, rule and line.
const COMMIT_MAP = 'governance/changelog/2026-10-11-attribution-rewrite-commit-map.txt';
test('AC-HSB-1.2: a baselined commit the attribution rewrite replaced also has its successor fingerprint', () => {
  const successor = new Map();
  for (const line of readFileSync(path.join(ROOT, COMMIT_MAP), 'utf8').split('\n')) {
    const pair = /^([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(line.trim());
    if (pair) successor.set(pair[1], pair[2]);
  }
  const baseline = entries(readFileSync(path.join(ROOT, '.gitleaksignore'), 'utf8'));
  const listed = new Set(baseline);
  const expected = baseline.flatMap((fingerprint) => {
    const [commit, ...location] = fingerprint.split(':');
    return successor.has(commit) ? [`${successor.get(commit)}:${location.join(':')}`] : [];
  });
  assert.ok(expected.length > 0, 'the commit map should replace at least one baselined commit');
  assert.deepEqual(expected.filter((fingerprint) => !listed.has(fingerprint)), []);
});
