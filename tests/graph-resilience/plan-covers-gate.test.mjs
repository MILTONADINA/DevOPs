// Story dv-covers: the cycle stops before Build when the spec holds [NEEDS CLARIFICATION]
// or an acceptance criterion is covered by no planned task. Toy data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const source = readFileSync(path.join(ROOT, '.claude', 'workflows', 'sprint-cycle.js'), 'utf8')
  .replace('export const meta =', 'const meta =');

async function run(agent, args = {}, logs = []) {
  const execute = new AsyncFunction('args', 'agent', 'log', 'phase', source);
  return execute({ backlogItem: 'specs/toy.md', cycleId: 'c1', ...args }, agent, (message) => logs.push(String(message)), () => {});
}

function stub(plan, labels, schemas = [], plannerThrows = false) {
  return async (_, options) => {
    labels.push(options.label);
    if (plannerThrows && options.label === 'planner') throw new Error('planner must not run on resume');
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'planner') { schemas.push(options.schema); return plan; }
    if (options.label.startsWith('coder:')) return { task_id: 'T1', summary: 'done' };
    if (options.label.startsWith('tester:')) return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
}

const blocked = (error) => JSON.parse(error.message.slice('SPEC_GATE_BLOCK:'.length));

test('planner leaving criterion AC2 uncovered stops the cycle before any coder runs', async () => {
  const labels = [];
  const plan = { criteria: ['AC1', 'AC2'], tasks: [{ id: 'T1', description: 'toy', covers: ['AC1'] }] };
  await assert.rejects(run(stub(plan, labels)), (error) => {
    assert.match(error.message, /^SPEC_GATE_BLOCK:/);
    assert.deepEqual(blocked(error), { clarification: [], uncovered: ['AC2'] });
    return true;
  });
  assert.ok(!labels.some((l) => l.startsWith('coder:')));
});

test('every criterion covered (across tasks) lets Build run', async () => {
  const labels = [];
  const plan = { criteria: ['AC1', 'AC2'], tasks: [{ id: 'T1', description: 'a', covers: ['AC1'] }, { id: 'T2', description: 'b', covers: ['AC2'] }] };
  const result = await run(stub(plan, labels));
  assert.ok(labels.includes('coder:T1'));
  assert.equal(result.cycleOutcome.readyForPR, true);
});

test('a task with no covers field covers nothing', async () => {
  const plan = { criteria: ['AC1'], tasks: [{ id: 'T1', description: 'a' }] };
  await assert.rejects(run(stub(plan, [])), (error) => { assert.deepEqual(blocked(error).uncovered, ['AC1']); return true; });
});

test('planner-reported clarification markers stop the cycle, and an ambiguity acknowledgement does not lift it', async () => {
  const labels = [];
  const plan = { tasks: [{ id: 'T1', description: 'a' }], clarification_markers: ['specs/toy.md:7 [NEEDS CLARIFICATION]'] };
  await assert.rejects(run(stub(plan, labels), { acknowledgedAmbiguities: ['specs/toy.md:7 [NEEDS CLARIFICATION]'] }), (error) => {
    assert.deepEqual(blocked(error).clarification, ['specs/toy.md:7 [NEEDS CLARIFICATION]']);
    return true;
  });
  assert.ok(!labels.some((l) => l.startsWith('coder:')));
});

test('the gate also applies to a precomputed args.plan on resume', async () => {
  const plan = { criteria: ['AC1'], tasks: [{ id: 'T1', description: 'a', covers: [] }] };
  const labels = [];
  await assert.rejects(run(stub(plan, labels, [], true), { plan }), /^Error: SPEC_GATE_BLOCK:/);
  assert.ok(!labels.includes('planner'));
});

test('the planner schema declares covers, criteria and clarification_markers', async () => {
  const schemas = [];
  const plan = { criteria: ['AC1'], tasks: [{ id: 'T1', description: 'a', covers: ['AC1'] }] };
  await run(stub(plan, [], schemas));
  const props = schemas[0].properties;
  assert.equal(props.tasks.items.properties.covers.type, 'array');
  assert.equal(props.criteria.type, 'array');
  assert.equal(props.clarification_markers.type, 'array');
  assert.deepEqual(schemas[0].required, ['tasks', 'criteria']);
});

test('a plan with no criteria logs that coverage was not checked and Build runs', async () => {
  for (const criteria of [undefined, []]) {
    const labels = [];
    const logs = [];
    const plan = { tasks: [{ id: 'T1', description: 'a' }], ...(criteria ? { criteria } : {}) };
    const result = await run(stub(plan, labels), {}, logs);
    assert.ok(logs.some((l) => l.includes('coverage not checked')));
    assert.ok(labels.includes('coder:T1'));
    assert.equal(result.cycleOutcome.readyForPR, true);
  }
});
