// REQ-M16: a hook accepts exactly one valid companion response, never a JSON stream.
// Synthetic installed companion output only; no tested command is evaluated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(BASE_ENV)) {
  if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete BASE_ENV[key];
}

for (const hookName of ['deploy-gate.sh', 'block-sealed-refs.sh']) {
  for (const fault of ['multiple valid objects', 'malformed JSON', 'empty output']) {
    test(`AC-M16.1 ${hookName} rejects ${fault} as a classifier fault without changing authority`, () => {
      const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-response-test-')));
      try {
        const hooks = path.join(dir, '.claude', 'hooks'); mkdirSync(hooks, { recursive: true });
        const installedHook = path.join(hooks, hookName);
        copyFileSync(path.join(ROOT, 'hooks/universal/pre-tool', hookName), installedHook);
        const allow = { decision: 'allow', reason: '', logAllowed: false, cycle: null, marker: null, sealedRef: null };
        const block = { ...allow, decision: 'block', reason: 'synthetic block',
          sealedRef: hookName === 'block-sealed-refs.sh' ? 'refs/tags/v0.2.0' : null };
        // Every object is independently valid for this hook. Thus a multi-object
        // failure witnesses cardinality validation, not an invalid field shape.
        assert.deepEqual(Object.keys(block).sort(), ['cycle', 'decision', 'logAllowed', 'marker', 'reason', 'sealedRef']);
        const output = fault === 'multiple valid objects'
          ? `${JSON.stringify(block)}\n${JSON.stringify(allow)}\n`
          : fault === 'malformed JSON' ? '{malformed' : '';
        const companion = path.join(hooks, 'graph-command-classifier.mjs');
        writeFileSync(companion, `process.stdout.write(${JSON.stringify(output)});\n`);

        const state = path.join(dir, '.workflow', 'state');
        mkdirSync(path.join(state, 'graph-cycles', 'active'), { recursive: true });
        mkdirSync(path.join(state, 'graph-approvals'));
        const authority = new Map([
          [path.join(state, 'graph-halt'), 'synthetic halt'],
          [path.join(state, 'graph-approvals', 'active.deploy'), '{}'],
          [path.join(state, 'graph-cycles', 'active', 'run.json'), JSON.stringify({
            schema_version: 1, cycleId: 'active', args: { cycleId: 'active' }, status: 'running', runId: null, journalPath: null,
          })],
        ]);
        for (const [file, bytes] of authority) writeFileSync(file, bytes);

        const result = spawnSync('bash', [installedHook, 'git status'], {
          cwd: dir, env: BASE_ENV, encoding: 'utf8', timeout: 30_000,
        });
        assert.equal(result.error, undefined); assert.equal(result.signal, null);
        assert.equal(result.status, 2, result.stderr);
        // Sealed's old wrapper already ends with2 for concatenated decisions;
        // this diagnostic is necessary to distinguish actual protocol refusal.
        assert.match(result.stderr, /graph-command-classifier\.mjs.*invalid decision/);
        for (const [file, bytes] of authority) assert.equal(readFileSync(file, 'utf8'), bytes);
        assert.equal(existsSync(path.join(state, 'events.jsonl')), false, 'invalid responses cannot authorize event writes');
        assert.equal(readFileSync(companion, 'utf8'), `process.stdout.write(${JSON.stringify(output)});\n`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
