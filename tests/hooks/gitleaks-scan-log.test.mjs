// hooks/universal/post-tool/gitleaks-scan.sh: when a scan finds a secret, the secret_detected line
// appended to .workflow/state/events.jsonl carries the file name. A quote, backslash, newline or
// non-ASCII character in the name must round-trip, and the line must stay one JSON object. Issue
// #426.
//
// The hook runs only when gitleaks is on PATH, and the machine may have a real one. The test puts a
// stub named gitleaks first on PATH that reports one leak, so the detection path runs and no
// scanner is needed. Runs in a disposable directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'post-tool', 'gitleaks-scan.sh');
const FILE_NAME = 'q"b\\s\nnl caf\u00e9 \u65e5.txt';
const STUB = '#!/bin/sh\necho "Finding: stub"\necho "leaks found: 1"\nexit 1\n';

test('gitleaks-scan logs one secret_detected JSON object whose file name round-trips', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitleaks-scan-log-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'gitleaks'), STUB);
    chmodSync(path.join(bin, 'gitleaks'), 0o755);
    writeFileSync(path.join(dir, FILE_NAME), 'AKIA-stub\n');
    const env = { ...process.env, LC_ALL: 'C', PATH: `${bin}:${process.env.PATH}` };
    const result = spawnSync('bash', [HOOK, FILE_NAME], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 2, result.stderr);
    const text = readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
    assert.equal(text.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}: ${JSON.stringify(text)}`);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry), ['ts', 'event', 'file']);
    assert.equal(entry.event, 'secret_detected');
    assert.equal(typeof entry.ts, 'number');
    assert.equal(entry.file, FILE_NAME);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
