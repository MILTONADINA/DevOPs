import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'scripts', 'graph-run-record.mjs');

test('run record preserves exact input and clears a block only after passing preflight', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-record-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    const launched = run('launch', '--cycle', 'c7', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'c7', 'run.json');
    assert.equal(JSON.parse(readFileSync(file)).args.backlogItem, 'exact backlog text');
    const block = path.join(dir, 'blocked.md');
    writeFileSync(block, 'blocked');
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'needs_human' }));
    const refused = run('update', '--cycle', 'c7', '--status', 'running', '--clearBlocked', 'true');
    assert.notEqual(refused.status, 0);
    assert.ok(existsSync(block));
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready' }));
    writeFileSync(block, '## Class\nneeds_human\n');
    const humanOnly = run('update', '--cycle', 'c7', '--status', 'running', '--clearBlocked', 'true');
    assert.notEqual(humanOnly.status, 0);
    assert.ok(existsSync(block));
    writeFileSync(block, '## Class\napi\n');
    const resumed = run('update', '--cycle', 'c7', '--status', 'running', '--runId', 'wf_new', '--resumedFrom', 'wf_old', '--clearBlocked', 'true');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(existsSync(block), false);
    assert.equal(JSON.parse(readFileSync(file)).runId, 'wf_new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
