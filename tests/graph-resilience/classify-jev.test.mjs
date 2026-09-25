// Tests for the Jev tier of the fault classifier (specs/graph/J-jev-judgments.md REQ-J9).
// The Jev call is injected; nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFaultWithJev } from '../../scripts/graph-classify-fault.mjs';
import { evaluate } from '../../scripts/jev.mjs';

function fakeJev(answer) {
  const calls = [];
  const impl = async (req) => { calls.push(req); if (answer instanceof Error) throw answer; return { model: 'jev-1.13.0', answers: { fault_class: answer }, usage: {} }; };
  impl.calls = calls;
  return impl;
}

test('a deterministic signature still wins and Jev is not called', async () => {
  const jev = fakeJev({ type: 'choice', choice: 'code', confidence: 0.99 });
  const r = await classifyFaultWithJev('spawn git ENOENT', { evaluateImpl: jev });
  assert.equal(r.class, 'environment');
  assert.equal(r.classified_by, 'signature');
  assert.equal(jev.calls.length, 0);
});

test('an explicit agent verdict wins and Jev is not called', async () => {
  const jev = fakeJev({ type: 'choice', choice: 'code', confidence: 0.99 });
  const r = await classifyFaultWithJev('something odd happened', { agentClass: 'transient', evaluateImpl: jev });
  assert.deepEqual(r, { class: 'transient', classified_by: 'agent', signature: null });
  assert.equal(jev.calls.length, 0);
});

test('a residual error is classified by Jev when it is confident', async () => {
  const jev = fakeJev({ type: 'choice', choice: 'environment', confidence: 0.93, probabilities: { environment: 0.95, api: 0.02, transient: 0.02, code: 0.01 } });
  const r = await classifyFaultWithJev('ld: library not found for -lssl', { exitCode: 1, evaluateImpl: jev });
  assert.equal(r.class, 'environment');
  assert.equal(r.classified_by, 'jev');
  assert.equal(r.confidence, 0.93);
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(Object.keys(jev.calls[0].questions.fault_class.criteria).sort(), ['api', 'code', 'environment', 'transient']);
  assert.equal(jev.calls[0].state.exit_code, 1);
});

test('an uncertain Jev answer still requires an explicit agent verdict', async () => {
  const jev = fakeJev({ type: 'choice', choice: 'code', confidence: 0.51 });
  await assert.rejects(() => classifyFaultWithJev('ambiguous failure', { evaluateImpl: jev }), /agent verdict/i);
});

test('with Jev unavailable the residual path is unchanged: an agent verdict is required', async () => {
  const err = Object.assign(new Error('TYPESAFE_API_KEY is not set'), { name: 'JevUnavailableError' });
  await assert.rejects(() => classifyFaultWithJev('ambiguous failure', { evaluateImpl: fakeJev(err) }), /agent verdict/i);
});

test('error output holding a secret shape never leaves the machine: the guard refuses it and an agent verdict is required', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return new Response('{}', { status: 200 }); };
  const evaluateImpl = (req) => evaluate({ ...req, apiKey: 'test-key-' + 'x'.repeat(24), fetchImpl });
  const leaked = 'deploy failed\nDATABASE_URL=' + 'postgres' + '://admin:' + 's3cretpassw0rd' + '@db.internal:5432/app';
  await assert.rejects(() => classifyFaultWithJev(leaked, { evaluateImpl }), /agent verdict.*connection-uri-password/i);
  assert.equal(calls.length, 0);
});
