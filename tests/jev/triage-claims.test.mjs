// Tests for the pure parts of scripts/triage-claims.mjs (specs/graph/J-jev-judgments.md, REQ-J8).
// The Jev call is injected, so nothing here touches the network or runs a proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingIdsFromLog, redactTail, buildQuestions, triageOne, renderTable, CAUSES } from '../../scripts/triage-claims.mjs';

test('failingIdsFromLog reads every ✗ claim id once, in order', () => {
  const log = '✓ claim-2026-05-22-001\n✗ claim-2026-05-22-009\n    - Re-run exit code 1 != expected 0\n✗ claim-2026-09-23-032\n✗ claim-2026-05-22-009\n';
  assert.deepEqual(failingIdsFromLog(log), ['claim-2026-05-22-009', 'claim-2026-09-23-032']);
});

test('redactTail keeps the last N lines and masks any line with a secret shape', () => {
  const key = 'AK' + 'IA' + 'QWERTYUIOPASDFGH';
  const out = redactTail(['a', 'b', `token ${key}`, 'c', 'd'].join('\n'), 3);
  assert.deepEqual(out.split('\n'), ['[redacted: aws-access-key]', 'c', 'd']);
});

test('buildQuestions asks one cause choice over every cause and one re-pin noul', () => {
  const q = buildQuestions();
  assert.equal(q.cause.type, 'choice');
  assert.deepEqual(Object.keys(q.cause.criteria).sort(), [...CAUSES].sort());
  assert.equal(q.repin_would_fix.type, 'noul');
});

test('triageOne sends the claim facts as state and marks uncertain answers for escalation', async () => {
  const seen = [];
  const evaluateImpl = async ({ state, questions }) => {
    seen.push({ state, questions });
    return { model: 'jev-1.13.0', answers: {
      cause: { type: 'choice', choice: 'missing_tool_or_environment', confidence: 0.55, probabilities: { missing_tool_or_environment: 0.6 } },
      repin_would_fix: { type: 'noul', noul: 0.1 },
    }, usage: { input_tokens: 300, output_tokens: 20 } };
  };
  const row = await triageOne({ id: 'claim-x', description: 'd', test_command: 'bash p.sh', expected_exit: 0, actual_exit: 127, output_tail: 'tsx: command not found' }, { evaluateImpl });
  assert.deepEqual(Object.keys(seen[0].state).sort(), ['actual_exit', 'claim_id', 'description', 'expected_exit', 'output_tail', 'test_command']);
  assert.equal(row.cause, 'missing_tool_or_environment');
  assert.equal(row.escalate, true, 'confidence 0.55 is below the 0.8 threshold');
  assert.equal(row.repin, false);
});

test('triageOne escalates instead of throwing when Jev is unavailable', async () => {
  const evaluateImpl = async () => { const e = new Error('no key'); e.name = 'JevUnavailableError'; throw e; };
  const row = await triageOne({ id: 'claim-y', description: 'd', test_command: 'c', expected_exit: 0, actual_exit: 1, output_tail: '' }, { evaluateImpl });
  assert.equal(row.cause, 'unclassified');
  assert.equal(row.escalate, true);
  assert.match(row.note, /no key/);
});

test('renderTable lists every claim exactly once with an escalation column', () => {
  const md = renderTable([
    { id: 'claim-a', cause: 'drift_later_change', p: 0.9, confidence: 0.91, repin: true, escalate: false, actual_exit: 1, note: '' },
    { id: 'claim-b', cause: 'unclassified', p: 0, confidence: 0, repin: null, escalate: true, actual_exit: 127, note: 'x' },
  ]);
  assert.equal((md.match(/claim-a/g) || []).length, 1);
  assert.equal((md.match(/claim-b/g) || []).length, 1);
  assert.match(md, /\| escalate \|/);
});
