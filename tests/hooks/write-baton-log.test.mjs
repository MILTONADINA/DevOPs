// hooks/universal/session-end/write-baton.sh: the session_end line appended to
// .workflow/state/events.jsonl carries session_id, a caller-supplied string. A quote, backslash,
// newline or non-ASCII character in it must round-trip, and the line must stay one JSON object.
// The two counts on that line are numbers even when the blockers file has no blocker lines.
// Issue #426. Runs in a disposable directory that is not a git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'session-end', 'write-baton.sh');
const SESSION_ID = 'sess "one" \\ two\nthree caf\u00e9 \u65e5\u672c';

function run({ blockers } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'write-baton-log-'));
  try {
    if (blockers !== undefined) {
      mkdirSync(path.join(dir, '.workflow', 'state'), { recursive: true });
      writeFileSync(path.join(dir, '.workflow', 'state', 'blockers.md'), blockers);
    }
    const env = { ...process.env, LC_ALL: 'C', DEVOPS_SESSION_ID: SESSION_ID };
    delete env.DEVOPS_BATON;
    delete env.DEVOPS_TOOL;
    const result = spawnSync('bash', [HOOK], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
    assert.equal(text.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}: ${JSON.stringify(text)}`);
    return JSON.parse(lines[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('write-baton logs one JSON object whose session_id round-trips', () => {
  const entry = run();
  assert.deepEqual(Object.keys(entry), ['ts', 'event', 'session_id', 'verified_claims', 'open_blockers']);
  assert.equal(entry.event, 'session_end');
  assert.equal(entry.session_id, SESSION_ID);
  assert.equal(typeof entry.ts, 'number');
  assert.equal(entry.verified_claims, 0);
  assert.equal(entry.open_blockers, 0);
});

test('write-baton logs open_blockers as 0 when the blockers file has no blocker heading', () => {
  const entry = run({ blockers: '# Blockers\n\nnone\n' });
  assert.equal(entry.open_blockers, 0);
  assert.equal(entry.session_id, SESSION_ID);
});

test('write-baton logs the blocker count when the blockers file has blocker headings', () => {
  const entry = run({ blockers: '## Blocker one\n\n## Blocker two\n' });
  assert.equal(entry.open_blockers, 2);
});
