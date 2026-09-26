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
    // AC-M4.1's null-result half: an unclassified blocked result must map to
    // needs_human, not the current default of 'api'.
    assert.equal(data.class, 'needs_human');
    assert.equal(data.stage, 'reviewer');
    return true;
  });
  assert.deepEqual(labels, ['preflight', 'reviewer']);
});

test('blocked coder stops before its tester and preserves fault details', async () => {
  const labels = [];
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  await assert.rejects(run(async (_, options) => {
    labels.push(options.label);
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'blocked', passed: false,
      blocked_by_environment: { class: 'environment', check_ids: ['git.runs'], evidence: 'Xcode license', classified_by: 'signature' } };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan }), (error) => {
    const fault = JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length));
    assert.equal(fault.stage, 'coder');
    assert.equal(fault.taskId, 'T1');
    assert.equal(fault.class, 'environment');
    assert.deepEqual(fault.check_ids, ['git.runs']);
    assert.equal(fault.classified_by, 'signature');
    return true;
  });
  assert.deepEqual(labels, ['preflight', 'coder:T1']);
});

test('each role can report a blocked fault and tester sees environment rules before stall rules', async () => {
  const calls = [];
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  // outcome: 'PASS' on tester/security/validator, plus the reviewer fake below
  // carrying no BLOCKER-prefixed (indeed no) violations, is AC-M1.2's positive
  // control: an all-PASS/approved cycle that must keep reading readyForPR: true
  // once REQ-M1/M3 land, so the new gate is not vacuously always-false either.
  const responses = {
    preflight: { status: 'ready', check_ids: [] },
    'coder:T1': { task_id: 'T1', summary: 'done' },
    'tester:T1': { task_id: 'T1', passed: true, outcome: 'PASS' },
    reviewer: { approved: true },
    security: { passed: true, outcome: 'PASS' },
    validator: { signed_off: true, outcome: 'PASS', reason: 'verified' },
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
  for (const { prompt, options } of calls.filter(({ options }) => options.label !== 'preflight')) {
    assert.match(prompt, /graph-classify-fault\.mjs/, options.label);
    assert.match(prompt, /classified_by/, options.label);
  }
  const coder = calls.find(({ options }) => options.label === 'coder:T1');
  assert.deepEqual(coder.options.schema.properties.passed, { type: 'boolean' });
  assert.match(coder.prompt, /passed: false/);
});

// --- REQ-M1: readyForPR is computed in code from every verdict ---------------

test('AC-M1.1: reviewer approved:false blocks readyForPR even when tester/security/validator all PASS', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: false };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  // REQ-M1's own falsification example: today readyForPR never reads the
  // reviewer verdict, so this currently comes back true.
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1: security outcome FAIL blocks readyForPR even when reviewer/tester/validator all PASS', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: false, outcome: 'FAIL', findings: ['TP-critical: forced test finding'] };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  // Today readyForPR never reads the security result at all.
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1: any tester outcome FAIL blocks readyForPR even when reviewer/security/validator all PASS', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    // passed:true deliberately disagrees with outcome:'FAIL' -- today's code
    // only reads .passed (via failedTasks), never .outcome, so this isolates
    // the exact gap REQ-M1/M3 close: outcome must be authoritative.
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'FAIL' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1: a BLOCKER: violation blocks readyForPR even when reviewer.approved is true', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    // approved:true but a BLOCKER: survives in violations -- the reviewer
    // prompt's own convention (line ~253: "set approved to false if any
    // BLOCKER remains") says this combination should not occur, but
    // readyForPR must not take approved's word for it uncrossed with
    // violations: a prompt-level instruction is not a structural guarantee.
    if (options.label === 'reviewer') return { approved: true, violations: ['BLOCKER: untraceable line in coder diff'] };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1 (negative control): a CONCERN:-only violations list does not block readyForPR', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    // Proves the BLOCKER: regex does not over-match CONCERN: (or anything
    // else) -- only an actual BLOCKER: prefix should gate readyForPR.
    if (options.label === 'reviewer') return { approved: true, violations: ['CONCERN: minor style nit, non-blocking'] };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, true);
});

// security-findings.md TP-warning #3: reviewerHasBlocker's regex was
// case-sensitive and anchored at position 0 (`/^BLOCKER:/`), so a violation
// reading as a blocker in any other surface form silently fell through to
// trust the reviewer's own `approved` boolean alone. These three cases each
// use a differently-formatted BLOCKER violation with approved:true.

test('AC-M1.1: a BLOCKER: violation formatted as markdown bold (`**BLOCKER:** x`) blocks readyForPR', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true, violations: ['**BLOCKER:** x'] };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1: a BLOCKER: violation with a leading space (` BLOCKER: x`) blocks readyForPR', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true, violations: [' BLOCKER: x'] };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, false);
});

test('AC-M1.1: a BLOCKER: violation with a lowercased initial (`Blocker: x`) blocks readyForPR', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true, violations: ['Blocker: x'] };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, false);
});

// --- REQ-M3: INDETERMINATE is a first-class outcome, never counted as clean --

test('AC-M3.1: an INDETERMINATE tester outcome makes readyForPR false and shows in the cycle outcome', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'INDETERMINATE' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  // REQ-M3's own falsification example, verbatim.
  assert.equal(result.cycleOutcome.readyForPR, false);
  assert.match(JSON.stringify(result.cycleOutcome), /INDETERMINATE/);
});

// --- REQ-M4: an unknown fault class is never reclassified as resumable ------

test('AC-M4.1: a blocked_by_environment class outside the enum is mapped to needs_human, not passed through', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  await assert.rejects(run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'blocked', passed: false,
      blocked_by_environment: { class: 'code', check_ids: ['x'], evidence: 'not one of the allowed classes' } };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan }), (error) => {
    const data = JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length));
    // Today `blocked.class || 'api'` passes any truthy class straight through.
    assert.equal(data.class, 'needs_human');
    return true;
  });
});

// --- REQ-M7: material ambiguity and source conflicts stop the cycle --------

test('AC-M7.1: unacknowledged planner ambiguities block Build; acknowledging them lets Build run', async () => {
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], ambiguities: ['X'] };

  const blockedLabels = [];
  await assert.rejects(
    run(async (prompt, options) => { blockedLabels.push(options.label); return mock(prompt, options); }, { plan }),
    (error) => { assert.match(error.message, /^AMBIGUITY_BLOCK:/); return true; }
  );
  assert.ok(!blockedLabels.some((label) => label.startsWith('coder:')), 'coder must not run before the ambiguity is acknowledged');

  // This second phase only executes once the block above actually throws;
  // today it does not, so the whole case fails at the assert.rejects above.
  const ackLabels = [];
  const result = await run(
    async (prompt, options) => { ackLabels.push(options.label); return mock(prompt, options); },
    { plan, acknowledgedAmbiguities: ['X'] }
  );
  assert.ok(ackLabels.includes('coder:T1'), 'coder should run once the ambiguity is acknowledged');
  assert.equal(result.cycleOutcome.readyForPR, true);
});

test('AC-M7.1: a non-empty planner conflicts[] blocks Build the same way; acknowledging it lets Build run', async () => {
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  // Acknowledged the same way as an ambiguity: the conflict object appears
  // verbatim in args.acknowledgedAmbiguities (REQ-M7 does not define a
  // separate acknowledgement channel for conflicts).
  const conflict = { higher: 'AGENTS.md precedence line', lower: 'plan.md', clause: 'owner decision > plan' };
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], conflicts: [conflict] };

  const blockedLabels = [];
  await assert.rejects(
    run(async (prompt, options) => { blockedLabels.push(options.label); return mock(prompt, options); }, { plan }),
    (error) => { assert.match(error.message, /^AMBIGUITY_BLOCK:/); return true; }
  );
  assert.ok(!blockedLabels.some((label) => label.startsWith('coder:')), 'coder must not run before the conflict is acknowledged');

  const ackLabels = [];
  const result = await run(
    async (prompt, options) => { ackLabels.push(options.label); return mock(prompt, options); },
    { plan, acknowledgedAmbiguities: [conflict] }
  );
  assert.ok(ackLabels.includes('coder:T1'), 'coder should run once the conflict is acknowledged');
  assert.equal(result.cycleOutcome.readyForPR, true);
});
