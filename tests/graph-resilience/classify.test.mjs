import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFault } from '../../scripts/graph-classify-fault.mjs';

const cases = [
  ['Xcode license', 'You have not agreed to the Xcode license agreements', 'environment'],
  ['Xcode xcrun', 'xcrun: error: invalid active developer path', 'environment'],
  ['Xcode exit', 'You have not agreed to the Xcode license agreements', 'environment', 69],
  ['missing git', 'spawn git ENOENT', 'environment'],
  ['missing node', 'node: command not found', 'environment', 127],
  ['bin permissions', 'spawn node_modules/.bin/vitest EACCES', 'environment'],
  ['API rate limit', 'rate_limit_error: account session limit', 'api'],
  ['API outage', 'overloaded_error: model API unavailable', 'api'],
  ['assertion', 'AssertionError: expected 200, got 500', 'code'],
  ['failed test', 'FAIL tests/proxy.test.ts > forwards requests', 'code'],
];

for (const [name, error, expected, exitCode] of cases) {
  test(name, () => {
    const result = classifyFault(error, { exitCode });
    assert.equal(result.class, expected);
    assert.equal(result.classified_by, 'signature');
  });
}

test('a null agent result is an API fault', () => {
  assert.deepEqual(classifyFault(null), { class: 'api', classified_by: 'signature', signature: 'agent.null' });
});

test('registry timeout is transient', () => {
  assert.equal(classifyFault('npm registry ETIMEDOUT').class, 'transient');
});

test('residual faults require an explicit agent verdict', () => {
  assert.throws(() => classifyFault('unrecognized failure'), /agent verdict/i);
  assert.equal(classifyFault('unrecognized failure', { agentClass: 'code' }).classified_by, 'agent');
});
