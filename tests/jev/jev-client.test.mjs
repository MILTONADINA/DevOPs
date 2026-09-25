// Tests for scripts/jev.mjs (specs/graph/J-jev-judgments.md, AC-J1.1).
// Every test injects a fake fetch, sleep and random: nothing here touches the
// network or waits in real time. Secret-shaped positive controls are assembled
// at runtime so no literal credential shape is ever committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, decide, findSecret,
  JevUnavailableError, JevSecretInStateError, JevHttpError,
} from '../../scripts/jev.mjs';

const KEY = 'test-key-' + 'x'.repeat(24);
const OK_BODY = {
  model: 'jev-1.13.0',
  answers: { is_urgent: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 120, output_tokens: 20 },
};

// A fresh Response per call: a Response body can be read only once.
function reply(status, body, headers = {}) {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof next === 'function' ? next(init) : next;
  };
  impl.calls = calls;
  return impl;
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const Q = { is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' } };

test('sends state, model and questions to /v1/systemone with a bearer token and returns the body unchanged', async () => {
  const f = fakeFetch([reply(200, OK_BODY)]);
  const out = await evaluate({ state: 'Payouts failing for 3 days.', questions: Q, apiKey: KEY, fetchImpl: f, ...noSleep });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(f.calls[0].body, { state: 'Payouts failing for 3 days.', model: 'jev-latest', questions: Q });
  assert.deepEqual(out, OK_BODY);
});

test('fails closed before any network call when no key is set', async () => {
  const f = fakeFetch([reply(200, OK_BODY)]);
  // env: {} keeps this independent of the developer's own TYPESAFE_API_KEY(_FILE).
  for (const apiKey of [undefined, '']) {
    await assert.rejects(() => evaluate({ state: 's', questions: Q, apiKey, env: {}, fetchImpl: f, ...noSleep }), JevUnavailableError);
  }
  assert.equal(f.calls.length, 0);
});

test('reads the key from TYPESAFE_API_KEY when none is passed', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = KEY;
  try {
    const f = fakeFetch([reply(200, OK_BODY)]);
    await evaluate({ state: 's', questions: Q, fetchImpl: f, ...noSleep }); // default env = process.env
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
  }
});

// Assembled at runtime; each is a shape the secret guard must refuse.
const SECRETS = {
  'private-key': ['-----BEGIN ', 'RSA PRIVATE KEY', '-----\nMIIE'].join(''),
  'aws-access-key': 'AK' + 'IA' + 'QWERTYUIOPASDFGH',
  'github-token': 'gh' + 'p_' + 'a'.repeat(36),
  'slack-token': 'xo' + 'xb-' + '1234567890-abcdefghij',
  'stripe-live-key': 'sk' + '_live_' + 'b'.repeat(24),
  'anthropic-key': 'sk' + '-ant-' + 'c'.repeat(40),
  'openai-key': 'sk' + '-proj-' + 'd'.repeat(40),
  'connection-uri-password': 'postgres' + '://admin:' + 's3cretpassw0rd' + '@db.internal:5432/app',
};

for (const [rule, value] of Object.entries(SECRETS)) {
  test(`refuses to send state containing a ${rule} shape, before any network call`, async () => {
    const f = fakeFetch([reply(200, OK_BODY)]);
    await assert.rejects(
      () => evaluate({ state: { log: `line one\n${value}\nline three` }, questions: Q, apiKey: KEY, fetchImpl: f, ...noSleep }),
      (err) => err instanceof JevSecretInStateError && err.rule === rule,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(findSecret(`prefix ${value} suffix`), rule);
  });
}

test('refuses to send the API key itself, and checks questions as well as state', async () => {
  const f = fakeFetch([reply(200, OK_BODY)]);
  await assert.rejects(() => evaluate({ state: `key is ${KEY}`, questions: Q, apiKey: KEY, fetchImpl: f, ...noSleep }), JevSecretInStateError);
  const leakyQ = { q: { type: 'noul', instructions: `Is ${SECRETS['aws-access-key']} valid?` } };
  await assert.rejects(() => evaluate({ state: 's', questions: leakyQ, apiKey: KEY, fetchImpl: f, ...noSleep }), JevSecretInStateError);
  assert.equal(f.calls.length, 0);
});

test('ordinary text and look-alikes are not flagged', () => {
  for (const text of ['sk-learn is a library', 'AKIA is a prefix', 'https://example.com/path', 'ghp_short', 'postgres://localhost/app']) {
    assert.equal(findSecret(text), null, text);
  }
});

test('retries 429 and 529 with backoff, honoring retry-after, then succeeds', async () => {
  const sleeps = [];
  const f = fakeFetch([reply(429, { error: 'rate' }, { 'retry-after': '2' }), reply(529, { error: 'busy' }), reply(200, OK_BODY)]);
  const out = await evaluate({ state: 's', questions: Q, apiKey: KEY, fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 });
  assert.deepEqual(out, OK_BODY);
  assert.equal(f.calls.length, 3);
  assert.equal(sleeps[0], 2000, 'retry-after seconds are honored');
  assert.ok(sleeps[1] > 0 && sleeps[1] <= 8000, `jittered backoff within the cap, got ${sleeps[1]}`);
});

test('does not retry 401 or 422 and reports the status and body', async () => {
  for (const status of [401, 422]) {
    const f = fakeFetch([reply(status, { detail: 'nope' }), reply(200, OK_BODY)]);
    await assert.rejects(
      () => evaluate({ state: 's', questions: Q, apiKey: KEY, fetchImpl: f, ...noSleep }),
      (err) => err instanceof JevHttpError && err.status === status && /nope/.test(err.body),
    );
    assert.equal(f.calls.length, 1);
  }
});

test('stops after four attempts on persistent 529', async () => {
  const f = fakeFetch([reply(529, { error: 'busy' })]);
  await assert.rejects(() => evaluate({ state: 's', questions: Q, apiKey: KEY, fetchImpl: f, ...noSleep }), (err) => err instanceof JevHttpError && err.status === 529);
  assert.equal(f.calls.length, 4);
});

test('aborts a request that exceeds its timeout and counts it as a retryable failure', async () => {
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const f = fakeFetch([hang, reply(200, OK_BODY)]);
  const out = await evaluate({ state: 's', questions: Q, apiKey: KEY, fetchImpl: f, timeoutMs: 20, ...noSleep });
  assert.deepEqual(out, OK_BODY);
  assert.equal(f.calls.length, 2);
  const g = fakeFetch([hang]);
  await assert.rejects(() => evaluate({ state: 's', questions: Q, apiKey: KEY, fetchImpl: g, timeoutMs: 10, ...noSleep }), (err) => err instanceof JevHttpError && err.status === 'timeout');
  assert.equal(g.calls.length, 4);
});

test('decide returns a value only when confidence clears the threshold', () => {
  assert.equal(decide({ type: 'choice', choice: 'drift', confidence: 0.91 }, { minConfidence: 0.8 }), 'drift');
  assert.deepEqual(decide({ type: 'choice', choice: 'drift', confidence: 0.6 }, { minConfidence: 0.8 }), { uncertain: true });
  assert.equal(decide({ type: 'score', score: 1.7, confidence: 0.85 }, { minConfidence: 0.8 }), 1.7);
  assert.equal(decide({ type: 'noul', noul: 0.93 }, { minNoulMargin: 0.3 }), true);
  assert.equal(decide({ type: 'noul', noul: 0.04 }, { minNoulMargin: 0.3 }), false);
  assert.deepEqual(decide({ type: 'noul', noul: 0.55 }, { minNoulMargin: 0.3 }), { uncertain: true });
});

test('resolveApiKey prefers TYPESAFE_API_KEY, then reads TYPESAFE_API_KEY_FILE (plain or RTF), else fails closed', async () => {
  const { resolveApiKey } = await import('../../scripts/jev.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'jevkey-'));
  const key = 'api' + '_' + 'k'.repeat(40);
  const plain = path.join(dir, 'key.txt');
  writeFileSync(plain, `${key}\n`);
  const rtf = path.join(dir, 'key.rtf');
  writeFileSync(rtf, `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n\\pard\\tx560\\pardirnatural\\partightenfactor0\n\n\\f0\\fs24 \\cf0 ${key}}`);
  assert.equal(resolveApiKey({ TYPESAFE_API_KEY: 'direct-key-value-1234567890', TYPESAFE_API_KEY_FILE: plain }), 'direct-key-value-1234567890');
  assert.equal(resolveApiKey({ TYPESAFE_API_KEY_FILE: plain }), key);
  assert.equal(resolveApiKey({ TYPESAFE_API_KEY_FILE: rtf }), key);
  assert.equal(resolveApiKey({ TYPESAFE_API_KEY_FILE: path.join(dir, 'missing') }), undefined);
  assert.equal(resolveApiKey({}), undefined);
});
