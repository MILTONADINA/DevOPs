import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('SessionStart warns on failed preflight and never blocks the session', () => {
  const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.SessionStart?.length > 0);
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-hook-test-'));
  try {
    const fakeGit = path.join(dir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho "You have not agreed to the Xcode license agreements" >&2\nexit 69\n');
    chmodSync(fakeGit, 0o755);
    const result = spawnSync('bash', [path.join(ROOT, 'hooks', 'universal', 'session-start', 'graph-preflight.sh')], {
      cwd: ROOT, env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✗ git\.runs/);
    assert.match(result.stdout, /Xcode license agreements/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
