// docs/STATE.md stays tied to the code (specs/release/npm-package.md AC-18).
// Walks the repo for code, templates and config files that carry a `schema_version` field and
// fails when one is not named in docs/STATE.md, so a new persisted file cannot ship undocumented.
// Reads files only; no git, npm or network (tests/hermeticity.test.mjs).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DOC = path.join(ROOT, 'docs/STATE.md');

// Prose and tests mention the field without persisting it; runtime output is not source.
const SKIP_DIRS = new Set(['node_modules', '.git', 'specs', 'docs', 'tests', 'plans', 'dast']);
const SKIP_PATHS = new Set(['.workflow/state', '.workflow/proofs/dast']);
const EXTENSIONS = /\.(?:json|jsonl|mjs|cjs|js|ts|py|ya?ml)$/;

export function filesWithSchemaVersion(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (SKIP_PATHS.has(rel)) return [];
    if (entry.isDirectory()) {
      // scripts/dast holds source; only its runtime-output namesake under .workflow is skipped.
      if (SKIP_DIRS.has(entry.name) && !(entry.name === 'dast' && rel.startsWith('scripts/'))) return [];
      return filesWithSchemaVersion(file);
    }
    if (!entry.isFile() || !EXTENSIONS.test(entry.name)) return [];
    return /\bschema_version\b/.test(readFileSync(file, 'utf8')) ? [rel] : [];
  });
}

test('docs/STATE.md exists and has the restore drill', () => {
  assert.ok(existsSync(DOC), 'docs/STATE.md is missing');
  const doc = readFileSync(DOC, 'utf8');
  for (const heading of ['## Persisted files', '## Restore drill']) {
    assert.ok(doc.includes(heading), `docs/STATE.md has no "${heading}" section`);
  }
});

test('every file with a schema_version field is named in docs/STATE.md', () => {
  const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  const found = filesWithSchemaVersion();
  assert.ok(found.length >= 10, `scan found only ${found.length} files; the walk is broken`);
  const missing = found.filter((rel) => !doc.includes('`' + rel + '`'));
  assert.deepEqual(missing, [], `add these to docs/STATE.md:\n${missing.join('\n')}`);
});

test('the scan reports an undocumented file', () => {
  const doc = '`a.json`';
  const found = ['a.json', 'b.json'];
  assert.deepEqual(found.filter((rel) => !doc.includes('`' + rel + '`')), ['b.json']);
});

test('every path docs/STATE.md claims as a source exists', () => {
  const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  const claimed = [...doc.matchAll(/`((?:scripts|hooks|governance|verification|runtime|\.github|\.workflow\/proofs\/committed)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)].map((m) => m[1]);
  const gone = claimed.filter((rel) => !existsSync(path.join(ROOT, rel)));
  assert.deepEqual(gone, [], `docs/STATE.md names files that do not exist:\n${gone.join('\n')}`);
});
