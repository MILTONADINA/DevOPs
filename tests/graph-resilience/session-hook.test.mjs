import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('SessionStart warns on failed preflight and never blocks the session', () => {
  const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.SessionStart?.length > 0);
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-hook-test-'));
  // The shared report gates `graph-run-record.mjs launch` (masterpiece REQ-M5), so this test's fake-git
  // failure must go to its own report, never the checkout's .workflow/state/preflight.json.
  const sharedReport = path.join(ROOT, '.workflow', 'state', 'preflight.json');
  const sharedBefore = existsSync(sharedReport) ? readFileSync(sharedReport, 'utf8') : null;
  try {
    const fakeGit = path.join(dir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho "You have not agreed to the Xcode license agreements" >&2\nexit 69\n');
    chmodSync(fakeGit, 0o755);
    const result = spawnSync('bash', [path.join(ROOT, 'hooks', 'universal', 'session-start', 'graph-preflight.sh')], {
      cwd: ROOT, env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, PATH: `${dir}:${process.env.PATH}`, GRAPH_PREFLIGHT_REPORT: path.join(dir, 'preflight.json') }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✗ git\.runs/);
    assert.match(result.stdout, /Xcode license agreements/);
    assert.match(readFileSync(path.join(dir, 'preflight.json'), 'utf8'), /Xcode license agreements/);
    assert.equal(existsSync(sharedReport) ? readFileSync(sharedReport, 'utf8') : null, sharedBefore, 'the shared preflight report must not change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart loads the baton then recalls memory through the project-local runtime', () => {
  const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const commands = settings.hooks.SessionStart[0].hooks.map(hook => hook.command);
  const batonIndex = commands.findIndex(command => command.includes('load-baton.sh'));
  const memoryIndex = commands.findIndex(command => command.includes('session-start-context.ts'));
  assert.ok(batonIndex >= 0 && memoryIndex > batonIndex);
  assert.match(commands[memoryIndex], /stratum\/node_modules\/\.bin\/tsx/);
  const result = spawnSync('bash', ['-c', commands[memoryIndex]], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, DEVOPS_STRATUM_PROJECT_ROOT: ROOT, DEVOPS_STRATUM_ORG_ID: '' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
