// hooks/universal/post-tool/sync-lr-refined-date.sh: the lr_refined_date_synced line appended to
// .workflow/state/events.jsonl carries the edited file as trigger. A quote, backslash, newline or
// non-ASCII character in that path must round-trip, and the line must stay one JSON object. Issue
// #426. Runs in a disposable project; no plan file is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'post-tool', 'sync-lr-refined-date.sh');
const TRIGGER = 'docs/q"b\\s\nnl caf\u00e9 \u65e5/plan.md';

test('sync-lr-refined-date logs one JSON object whose trigger round-trips', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-lr-log-'));
  try {
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'docs', 'LAUNCH_READINESS.md'), '# Launch readiness\n\n**Last refined**: 2020-01-01 (initial draft)\n');
    const env = { ...process.env, LC_ALL: 'C' };
    const result = spawnSync('bash', [HOOK, TRIGGER], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    const today = new Date().toISOString().slice(0, 10);
    const text = readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
    assert.equal(text.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}: ${JSON.stringify(text)}`);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry), ['ts', 'event', 'old', 'new', 'trigger']);
    assert.equal(entry.event, 'lr_refined_date_synced');
    assert.equal(entry.old, '2020-01-01');
    assert.equal(entry.new, today);
    assert.equal(entry.trigger, TRIGGER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
