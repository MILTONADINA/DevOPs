import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const source = readFileSync(path.join(ROOT, '.claude', 'workflows', 'sprint-cycle.js'), 'utf8')
  .replace('export const meta =', 'const meta =');

async function run(agent, args = {}) {
  const execute = new AsyncFunction('args', 'agent', 'log', 'phase', source);
  return execute({ backlogItem: 'specs/graph/R-resilience.md', cycleId: 'c7', ...args }, agent, () => {}, () => {});
}

test('preflight needs_human stops before planner', async () => {
  const labels = [];
  await assert.rejects(run(async (_, options) => {
    labels.push(options.label);
    return { status: 'needs_human', check_ids: ['halt.absent'] };
  }), (error) => {
    assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/);
    assert.equal(JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length)).stage, 'preflight');
    return true;
  });
  assert.deepEqual(labels, ['preflight']);
});

test('null reviewer stops before security and validator', async () => {
  const labels = [];
  const plan = { tasks: [{ id: 'T1', description: 'already tested' }] };
  const priorBuildResults = [{ task: plan.tasks[0], coderResult: { task_id: 'T1', summary: 'done' }, testerResult: { task_id: 'T1', passed: true } }];
  await assert.rejects(run(async (_, options) => {
    labels.push(options.label);
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'reviewer') return null;
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan, priorBuildResults }), (error) => {
    const data = JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length));
    assert.equal(data.class, 'api');
    assert.equal(data.stage, 'reviewer');
    return true;
  });
  assert.deepEqual(labels, ['preflight', 'reviewer']);
});

test('each role can report a blocked fault and tester sees environment rules before stall rules', async () => {
  const calls = [];
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const responses = {
    preflight: { status: 'ready', check_ids: [] },
    'coder:T1': { task_id: 'T1', summary: 'done' },
    'tester:T1': { task_id: 'T1', passed: true },
    reviewer: { approved: true },
    security: { passed: true },
    validator: { signed_off: true, reason: 'verified' },
  };
  const result = await run(async (prompt, options) => {
    calls.push({ prompt, options });
    return responses[options.label];
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, true);
  for (const { options } of calls) {
    const blocked = options.schema.properties.blocked_by_environment;
    assert.deepEqual(blocked.required, ['class', 'check_ids', 'evidence'], options.label);
  }
  const tester = calls.find(({ options }) => options.label === 'tester:T1').prompt;
  assert.ok(tester.indexOf('ENVIRONMENT RULES') < tester.indexOf('STALL RULES'));
});
