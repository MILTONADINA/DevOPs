// hooks/universal/pre-tool/block-prod-write.sh: a production command runs only after an
// approval for that exact command from the last five minutes. An approval for another
// command, a stale or future timestamp, a string timestamp or a line that is not JSON
// approves nothing. Runs the hook in a disposable project; no command is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
