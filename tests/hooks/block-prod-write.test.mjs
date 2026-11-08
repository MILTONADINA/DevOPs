// hooks/universal/pre-tool/block-prod-write.sh: a production command runs only after an
// approval for that exact command from the last five minutes. An approval for another
// command, a stale or future timestamp, a string timestamp or a line that is not JSON
// approves nothing. Runs the hook in a disposable project; no command is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'block-prod-write.sh');
const COMMAND = 'terraform apply -auto-approve';
const now = () => Math.floor(Date.now() / 1000);

function decide(command, approvals) {
  const dir = mkdtempSync(path.join(tmpdir(), 'block-prod-write-'));
  try {
    mkdirSync(path.join(dir, '.workflow', 'state'), { recursive: true });
    if (approvals !== undefined) writeFileSync(path.join(dir, '.workflow', 'state', 'approvals.jsonl'), approvals.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
    const result = spawnSync('bash', [HOOK, command], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(result.error, undefined, String(result.error));
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('block-prod-write allows a production command approved for that exact command just now', () => {
  assert.equal(decide(COMMAND, [{ ts: now(), command: COMMAND }]), 0);
});

test('block-prod-write refuses a production command with no approvals file', () => {
  assert.equal(decide(COMMAND), 2);
});

const REFUSED = {
  'an approval for a different command': [{ ts: now(), command: 'terraform plan' }],
  'an approval with no command': [{ ts: now() }],
  'an approval older than five minutes': [{ ts: now() - 600, command: COMMAND }],
  'an approval dated in the future': [{ ts: now() + 86_400, command: COMMAND }],
  'a string timestamp': [{ ts: String(now() + 86_400), command: COMMAND }],
  'a line that is not JSON': [`not json "ts":${now()} ${COMMAND}`],
  'a "ts" key inside another value': [{ note: `"ts":${now()}`, command: COMMAND }],
};
for (const [name, approvals] of Object.entries(REFUSED)) {
  test(`block-prod-write refuses a production command given ${name}`, () => {
    assert.equal(decide(COMMAND, approvals), 2);
  });
}

test('block-prod-write matches production SQL whatever its case', () => {
  assert.equal(decide('psql -c "drop table users"'), 2);
  assert.equal(decide('echo hello'), 0);
});

// The events.jsonl line for a blocked or approved command carries the command text, which is
// caller-supplied. A quote, backslash, newline or non-ASCII character in it must round-trip, and
// the line must stay one JSON object. The escape must not depend on jq: a jq that fails or is
// missing must not change the line. Issue #426. A stub jq that always fails stands in for both.
const LOG_COMMAND = 'terraform apply -var "x=\\y" # caf\u00e9\nline two';

function runLogged(approvals, { failingJq = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'block-prod-write-log-'));
  try {
    mkdirSync(path.join(dir, '.workflow', 'state'), { recursive: true });
    if (approvals !== undefined) writeFileSync(path.join(dir, '.workflow', 'state', 'approvals.jsonl'), approvals.map(line => JSON.stringify(line)).join('\n') + '\n');
    const env = { ...process.env, LC_ALL: 'C' };
    if (failingJq) {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'jq'), '#!/bin/sh\nexit 1\n');
      chmodSync(path.join(bin, 'jq'), 0o755);
      env.PATH = `${bin}:${process.env.PATH}`;
    }
    const result = spawnSync('bash', [HOOK, LOG_COMMAND], { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(result.error, undefined, String(result.error));
    const events = readFileSync(path.join(dir, '.workflow', 'state', 'events.jsonl'), 'utf8');
    assert.equal(events.endsWith('\n'), true, 'the entry ends with a newline');
    const lines = events.slice(0, -1).split('\n');
    assert.equal(lines.length, 1, `exactly one line, got ${lines.length}: ${JSON.stringify(events)}`);
    return { status: result.status, entry: JSON.parse(lines[0]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('block-prod-write logs a refused command that round-trips as one JSON object', () => {
  const { status, entry } = runLogged(undefined);
  assert.equal(status, 2);
  assert.deepEqual(Object.keys(entry), ['ts', 'event', 'command', 'pattern']);
  assert.equal(entry.event, 'prod_write_blocked');
  assert.equal(entry.command, LOG_COMMAND);
  assert.equal(entry.pattern, 'terraform apply');
});

test('block-prod-write logs an approved command that round-trips as one JSON object', () => {
  const { status, entry } = runLogged([{ ts: now(), command: LOG_COMMAND }]);
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(entry), ['ts', 'event', 'command']);
  assert.equal(entry.event, 'prod_action_approved');
  assert.equal(entry.command, LOG_COMMAND);
});

test('block-prod-write logs a refused command round-trip when jq fails', () => {
  const { status, entry } = runLogged([{ ts: now(), command: LOG_COMMAND }], { failingJq: true });
  assert.equal(status, 2);
  assert.equal(entry.event, 'prod_write_blocked');
  assert.equal(entry.command, LOG_COMMAND);
  assert.equal(entry.pattern, 'terraform apply');
});
