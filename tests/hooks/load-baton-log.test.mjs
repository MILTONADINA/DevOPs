// hooks/universal/session-start/load-baton.sh: the session_start line appended to
// .workflow/state/events.jsonl carries session_id and tool, both caller-supplied strings. A quote,
// backslash, newline or non-ASCII character in either must round-trip, and the line must stay one
// JSON object. Issue #426. Runs in a disposable directory that is not a git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'session-start', 'load-baton.sh');
const SESSION_ID = 'sess "one" \\ two\nthree caf\u00e9 \u65e5\u672c';
const TOOL = 'tool "x"\\y\nz \u00fc';

test('load-baton logs one session_start JSON object whose session_id and tool round-trip', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'load-baton-log-'));
  try {
    const env = { ...process.env, LC_ALL: 'C', DEVOPS_SESSION_ID: SESSION_ID, DEVOPS_TOOL: TOOL };
    delete env.DEVOPS_BATON;
    delete env.DEVOPS_PROFILE;
    const result = spawnSync('bash', [HOOK], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
    assert.equal(text.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = text.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}: ${JSON.stringify(text)}`);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(entry), ['ts', 'event', 'session_id', 'tool']);
    assert.equal(entry.event, 'session_start');
    assert.equal(typeof entry.ts, 'number');
    assert.equal(entry.session_id, SESSION_ID);
    assert.equal(entry.tool, TOOL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
