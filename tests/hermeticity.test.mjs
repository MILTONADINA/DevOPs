import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const forbidden = /\b(?:execFileSync|execSync|spawnSync|spawn|exec)\s*\(\s*(['"`])(git|brew|xcodebuild|xcrun|npm|npx)\1/g;

function violations(file) {
  const source = readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trimStart().startsWith('//') ? '' : line).join('\n');
  return [...source.matchAll(forbidden)].flatMap((match) => {
    const rest = source.slice(match.index);
    if (match[2] === 'git' && /\bexecFileSync\s*\(\s*(['"`])git\1\s*,\s*\[\s*(['"`])--version\2/.test(rest)) return [];
    return [`${file}:${source.slice(0, match.index).split('\n').length}`];
  });
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.workflow') return [];
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

test('toolchain subprocess calls in tests are reported with file and line', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-hermeticity-'));
  try {
    const file = path.join(dir, 'bad.test.mjs');
    writeFileSync(file, 'const x = ' + 'execFileSync' + "('git', ['rev-parse']);\n");
    assert.deepEqual(violations(file), [`${file}:1`]);
    writeFileSync(file, 'const x = ' + 'execFileSync' + "(\n  'git', ['rev-parse']);\n");
    assert.deepEqual(violations(file), [`${file}:1`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all test files avoid derivable toolchain subprocess calls', () => {
  const found = testFiles(ROOT).flatMap(violations);
  assert.deepEqual(found, [], `toolchain subprocesses found:\n${found.join('\n')}`);
});
