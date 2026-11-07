// specs/phase-2/C-prompt-injection-hardening.md AC-C5.1, AC-C5.2: external-content-boundary.sh
// halts with exit 2 (the only status Claude Code treats as blocking) on a marker it
// cannot verify, and allows a marker whose HMAC matches. The markers travel inside a
// real PreToolUse JSON payload, where their quotes are escaped. Runs in a disposable
// project with a synthetic session key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'universal', 'pre-tool', 'external-content-boundary.sh');
const SOURCE = 'toy-web';
const BODY = 'Synthetic page text for the boundary test.';

function marker(key, { hmac } = {}) {
  const mac = hmac ?? createHmac('sha256', key).update(BODY + SOURCE + 'untrusted=true').digest('base64');
  return `<external-content untrusted="true" source="${SOURCE}" hmac="${mac}">${BODY}</external-content>`;
}

function boundary(payload, { key = randomBytes(16), withKey = true, events = '', path: pathOverride, escape = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'external-content-'));
  try {
    const state = path.join(dir, '.workflow', 'state');
    mkdirSync(state, { recursive: true });
    if (withKey) writeFileSync(path.join(state, 'session-key'), `${key.toString('hex')}\n`);
    if (events) writeFileSync(path.join(state, 'events.jsonl'), events);
    let PATH = process.env.PATH;
    if (pathOverride === 'no-python') {
      PATH = path.join(dir, 'bin');
      mkdirSync(PATH);
      for (const tool of ['bash', 'cat', 'date', 'dirname', 'grep', 'mkdir', 'printf']) {
        const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (found.startsWith('/')) symlinkSync(found, path.join(PATH, tool));
      }
    }
    const input = JSON.stringify(payload(key));
    const result = spawnSync('bash', [HOOK], { cwd: dir, input: escape ? input.replaceAll('external-content', 'external\\u002dcontent') : input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH, LC_ALL: 'C' } });
    assert.equal(result.error, undefined, String(result.error));
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = text => () => ({ tool_name: 'Read', tool_input: { file_path: 'notes.md', note: text } });
const withMarker = options => key => ({ tool_name: 'Read', tool_input: { file_path: 'notes.md', note: marker(key, options) } });

test('a payload without a marker is allowed (AC-C5.2)', () => {
  assert.equal(boundary(read('plain text')).status, 0);
});

test('a marker whose HMAC matches is allowed (AC-C5.2)', () => {
  const result = boundary(withMarker());
  assert.equal(result.status, 0, result.stderr);
});

test('a marker with a wrong HMAC halts with exit 2 (AC-C5.1)', () => {
  assert.equal(boundary(withMarker({ hmac: 'AAAA' })).status, 2);
});

test('a marker without an HMAC halts with exit 2 (AC-C5.1)', () => {
  assert.equal(boundary(key => ({ tool_name: 'Read', tool_input: { note: `<external-content untrusted="true" source="${SOURCE}">${BODY}</external-content>` } })).status, 2);
});

test('a malformed marker halts with exit 2 instead of being skipped (AC-C5.1)', () => {
  assert.equal(boundary(read(`<external-content source="${SOURCE}">${BODY}</external-content>`)).status, 2);
});

test('a marker with no session key halts with exit 2 (AC-C5.1)', () => {
  assert.equal(boundary(withMarker(), { withKey: false }).status, 2);
});

test('a marker halts with exit 2 when its verifier cannot run (AC-C5.1)', () => {
  assert.equal(boundary(withMarker(), { path: 'no-python' }).status, 2);
});

test('a destructive call after a rebuff block with no approval halts with exit 2 (AC-C6.1)', () => {
  const payload = key => ({ tool_name: 'Bash', tool_input: { command: `git push origin main # ${marker(key)}` } });
  const result = boundary(payload, { events: '{"event":"rebuff_confidence_block"}\n' });
  assert.equal(result.status, 2, result.stderr);
});

test('an uppercase marker without an HMAC halts with exit 2 (AC-C5.1)', () => {
  assert.equal(boundary(read(`<EXTERNAL-CONTENT untrusted="true" source="${SOURCE}">${BODY}</EXTERNAL-CONTENT>`)).status, 2);
});

test('a marker spelled with a JSON escape is still verified (AC-C5.1)', () => {
  assert.equal(boundary(withMarker({ hmac: 'AAAA' }), { escape: true }).status, 2);
});
