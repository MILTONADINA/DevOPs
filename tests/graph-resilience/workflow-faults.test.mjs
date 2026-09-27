import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const source = readFileSync(path.join(ROOT, '.claude', 'workflows', 'sprint-cycle.js'), 'utf8')
  .replace('export const meta =', 'const meta =');

async function run(agent, args = {}, log = () => {}) {
  const execute = new AsyncFunction('args', 'agent', 'log', 'phase', source);
  return execute({ backlogItem: 'specs/graph/R-resilience.md', cycleId: 'c7', ...args }, agent, log, () => {});
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
    // D2 (PB-84) schema change: every role's blocked_by_environment schema
    // must accept a literal JSON null at the top level (not anyOf/oneOf,
    // which would move `required` inside a branch and break the assertion
    // above).
    assert.deepEqual(blocked.type, ['object', 'null'], options.label);
  }
  const tester = calls.find(({ options }) => options.label === 'tester:T1').prompt;
  assert.ok(tester.indexOf('ENVIRONMENT RULES') < tester.indexOf('STALL RULES'));
  for (const { prompt, options } of calls.filter(({ options }) => options.label !== 'preflight')) {
    assert.match(prompt, /graph-classify-fault\.mjs/, options.label);
    assert.match(prompt, /classified_by/, options.label);
    // D2 (PB-84) prompt change: every role must also be told to omit
    // blocked_by_environment (or send null) absent a real fault, and never
    // fill it with a placeholder just because the schema declares the field.
    assert.ok(prompt.includes('OMIT blocked_by_environment'), `${options.label} prompt should instruct omitting blocked_by_environment absent a real fault`);
    assert.ok(prompt.toLowerCase().includes('not applicable'), `${options.label} prompt should warn against a placeholder like "not applicable"`);
  }
  const coder = calls.find(({ options }) => options.label === 'coder:T1');
  assert.deepEqual(coder.options.schema.properties.passed, { type: 'boolean' });
  assert.match(coder.prompt, /passed: false/);
});

// --- D2 (PB-84): an evidence-free blocked_by_environment is not a real fault -
// stopIfBlocked used to treat ANY non-null blocked_by_environment object as a
// real fault, even one carrying no check_ids and no evidence -- exactly the
// shape that halted cycle phase1-012's T4 twice on a spurious block from an
// agent whose own text said it was NOT blocked (polish-backlog PB-84). These
// cases pin the new rule: a real fault only when check_ids or evidence is
// actually non-empty. A `result === null` (agent() itself returned nothing)
// is unaffected and keeps throwing unconditionally -- REQ-R8's other half,
// already covered by the 'null reviewer stops before security and validator'
// test above, which must keep passing unchanged.

test('D2 (PB-84) RED-FIRST: an evidence-free blocked_by_environment ({class, check_ids:[], evidence:\'\'}) does not halt the cycle', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return {
      task_id: 'T1', summary: 'done', passed: true,
      blocked_by_environment: { class: 'environment', check_ids: [], evidence: '' },
    };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  // Pre-fix, this rejects with BLOCKED_BY_ENVIRONMENT because the object
  // itself is truthy even though it carries no real evidence; run() must now
  // resolve normally instead.
  assert.ok(result.cycleOutcome, 'run() should resolve normally, not reject');
  assert.equal(result.cycleOutcome.readyForPR, true);
});

test('D2 (PB-84) RED-FIRST: an evidence-free blocked_by_environment with check_ids/evidence keys entirely absent does not throw a TypeError and still continues', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return {
      task_id: 'T1', summary: 'done', passed: true,
      blocked_by_environment: { class: 'environment' }, // no check_ids, no evidence keys at all
    };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.ok(result.cycleOutcome, 'run() should resolve normally, with no TypeError from reading .length off an absent key');
  assert.equal(result.cycleOutcome.readyForPR, true);
});

// T2a: stopIfBlocked's evidence-free-swallow branch above (D2/PB-84) logs a
// message naming the stage and task id, but until now nothing observed it --
// run()'s log argument was hard-coded to a no-op. This test pins that log
// line via run()'s new optional third (log-capturing) parameter, reusing the
// exact evidence-free scenario from the RED-FIRST test just above (coder:T1
// returning {class: 'environment'} with no other keys). log() fires many
// times per cycle ('Starting sprint cycle...', 'Planner produced...', the
// final 'Cycle "..." outcome: ...', etc.), so captured calls are filtered to
// the 'Swallowed a spurious' prefix before counting -- this isolates
// stopIfBlocked's own log call from the cycle's ordinary log volume.
// Labeled (regression guard), not RED-FIRST, per this file's D1 convention:
// it passes against the current tree, where the log(...) call already
// exists. Killing mutation: delete the `log(...)` call inside stopIfBlocked's
// swallow branch (sprint-cycle.js ~line 80, the line reading `Swallowed a
// spurious...`). Verified by applying that exact deletion directly to the
// tracked source and running this file: 29 of 30 tests still pass -- only
// this test fails, on `assert.equal(swallowLogs.length, 1, ...)`, printing
// its own custom message ("stopIfBlocked should log the evidence-free
// swallow exactly once") followed by `0 !== 1` (actual !== expected) -- no
// collateral break. Reverted after (confirmed byte-identical via sha256 to
// the pre-mutation source); no behavior change here.
test('T2a: stopIfBlocked logs the evidence-free swallow exactly once, naming the stage and task id (regression guard)', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const logs = [];
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return {
      task_id: 'T1', summary: 'done', passed: true,
      blocked_by_environment: { class: 'environment' }, // no check_ids, no evidence keys at all
    };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan }, (message) => { logs.push(String(message)); });
  assert.ok(result.cycleOutcome, 'run() should resolve normally');
  assert.equal(result.cycleOutcome.readyForPR, true);

  const swallowLogs = logs.filter((message) => message.startsWith('Swallowed a spurious'));
  assert.equal(swallowLogs.length, 1, 'stopIfBlocked should log the evidence-free swallow exactly once');
  assert.match(swallowLogs[0], /at coder \(task T1\)/, 'the swallow log line should name both the stage (coder) and the task id (T1)');
});

// T2b: BLOCKED_SCHEMA declares `type: ['object', 'null']` (D2/PB-84 above)
// specifically so a role can either report a real fault as an object
// matching `properties`/`required`, or send a literal JSON `null` when it
// has none. The "each role can report a blocked fault" test above already
// pins the schema's own *shape* (`required` and `type` themselves); this
// test goes one level deeper and checks *instance*-level semantics against
// representative object and null values -- does a value shaped like this
// actually validate.
//
// No JSON-Schema library is reachable to do this for real without adding a
// dependency or crossing a subtree boundary: this root project's own
// package.json (dependencies/devDependencies) and node_modules carry no
// ajv, zod, or jsonschema at any depth (checked directly, not just by
// reading package.json), and its package.json has no `workspaces` field
// linking it to stratum. `stratum/node_modules` does carry ajv
// transitively (Fastify pulls it in), but stratum is its own separate
// package (its own package.json names it "startum"), with its own
// independent install, not a workspace member of this root project (and
// per project memory, a Windows-origin install at that) -- importing
// across that boundary from a root-level test would create a real
// dependency coupling between two independently installed trees, not
// merely "use a validator that happens to be present". Adding a new root
// devDependency purely for one test file is also out of scope for this
// single-file, surgical task. And while the
// Workflow tool's own runtime does validate an agent() call's result
// against its `schema` option for real when sprint-cycle.js actually runs
// as a Workflow, that validator lives inside the Workflow tool's own
// execution environment, not in any importable package -- it is not
// reachable from a plain `node --test` process either, which is all this
// file (and its `run()` harness's fake `agent` callback) ever is. Given
// all three are unavailable, this pins the schema's declared nullable-type
// semantics structurally instead, via a small purpose-built check (NOT a
// general JSON-Schema engine) implementing only the two rules this exact
// schema needs: a `null` instance is valid whenever 'null' is a declared
// type, with `properties`/`required` simply not applied to it (real
// JSON-Schema type-union behavior); an object instance is valid only when
// 'object' is a declared type AND it carries every `required` key AND each
// `properties` entry it has a value for actually matches (primitive
// `type`, `enum` membership, array `items.type`).
//
// Labeled (regression guard) per this file's D1 convention: it passes
// against the current tree. Killing mutation #1 (verified): delete
// `items: { type: 'string' }` from BLOCKED_SCHEMA's `check_ids` property
// (sprint-cycle.js, the `check_ids: { type: 'array', items: { type:
// 'string' } }` line). Verified by copying sprint-cycle.js into the
// scratchpad, applying that exact deletion to the tracked source, and
// re-running this file: only this test fails, on the `['ok', 123]`
// check_ids negative-control assertion below (expected false, got true) --
// with no `items` rule the checker has nothing left to check array
// elements against, so a check_ids array containing a number wrongly
// validates. No collateral break (lines 93/98 never read
// `properties.check_ids.items`). Reverted after (confirmed byte-identical
// via sha256 to the pre-mutation source). Killing mutation #2 (verified):
// delete `enum: FAULT_CLASSES` from BLOCKED_SCHEMA's `class` property.
// Verified the same way: only this test fails, on the `'not-a-real-class'`
// negative-control assertion below (expected false, got true). Reverted
// after (confirmed byte-identical via sha256). Neither mutation is dead
// code for this test's fixtures, and neither touches `type`/`required`
// (what the "each role can report a blocked fault" test above already
// covers), so this test pins genuinely new coverage, not a duplicate of
// the existing schema check.
test("T2b: BLOCKED_SCHEMA's nullable type validates an object matching its properties, and also validates a literal null (structural check -- no JSON-Schema validator reachable at the root project without adding a dependency or coupling to stratum's separate install; see comment above) (regression guard)", async () => {
  const calls = [];
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const responses = {
    preflight: { status: 'ready', check_ids: [] },
    'coder:T1': { task_id: 'T1', summary: 'done' },
    'tester:T1': { task_id: 'T1', passed: true, outcome: 'PASS' },
    reviewer: { approved: true },
    security: { passed: true, outcome: 'PASS' },
    validator: { signed_off: true, outcome: 'PASS', reason: 'verified' },
  };
  await run(async (_, options) => {
    calls.push(options);
    return responses[options.label];
  }, { plan });

  // Pulled from the actual schema the real source hands to agent() for the
  // coder role -- the same BLOCKED_SCHEMA object reference every role gets
  // (see the "each role can report a blocked fault" test above) -- not a
  // hand-copied duplicate that could silently drift from the source.
  const schema = calls.find((options) => options.label === 'coder:T1').schema.properties.blocked_by_environment;
  const declaredTypes = [].concat(schema.type);

  function validatesAgainstBlockedShape(value) {
    if (value === null) return declaredTypes.includes('null');
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    if (!declaredTypes.includes('object')) return false;
    for (const key of schema.required) {
      if (!(key in value)) return false;
    }
    for (const [key, rule] of Object.entries(schema.properties)) {
      if (!(key in value)) continue;
      const v = value[key];
      if (rule.type === 'array') {
        if (!Array.isArray(v) || (rule.items && !v.every((item) => typeof item === rule.items.type))) return false;
      } else if (typeof v !== rule.type) {
        return false;
      }
      if (rule.enum && !rule.enum.includes(v)) return false;
    }
    return true;
  }

  const objectFixture = { class: 'environment', check_ids: ['git.runs'], evidence: 'Xcode license', classified_by: 'signature' };
  assert.equal(validatesAgainstBlockedShape(objectFixture), true, 'an object matching every declared property should validate');
  assert.equal(validatesAgainstBlockedShape(null), true, 'a literal null should validate solely because "null" is a declared type');

  // Negative controls: prove the check above is discriminating, not
  // vacuously true for any input (see the two verified killing mutations
  // above, each of which flips one of these two).
  assert.equal(validatesAgainstBlockedShape({ class: 'environment', evidence: 'missing check_ids key entirely' }), false, 'an object missing a required key must not validate');
  assert.equal(validatesAgainstBlockedShape({ class: 'not-a-real-class', check_ids: [], evidence: 'x' }), false, 'a class outside the enum must not validate');
  assert.equal(validatesAgainstBlockedShape({ class: 'environment', check_ids: ['ok', 123], evidence: 'x' }), false, 'a check_ids array containing a non-string element must not validate');
  assert.equal(validatesAgainstBlockedShape(undefined), false, 'undefined is neither null nor an object and must not validate');
});

// (regression guard): passes against both the pre-fix and post-fix
// stopIfBlocked (pre-fix: any non-null blocked_by_environment always throws;
// post-fix: evidence is non-empty, so it's still judged a real fault).
// Killing mutation against the NEW code: drop the evidence-emptiness half of
// the `!hasCheckIds && !hasEvidence` disjunction, e.g. change the condition to
// `if (!hasCheckIds)`. Verified by applying that exact mutation directly to
// the tracked source and running this file: with check_ids empty and
// evidence no longer able to save it, stopIfBlocked wrongly swallows the
// block, the cycle proceeds past coder to the (unmocked) tester, and this
// test's own mock throws `unexpected agent: tester:T1` -- so the promise
// still rejects, but with that message instead of a BLOCKED_BY_ENVIRONMENT
// one, and the inner `assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/)`
// fails ("The input did not match the regular expression ... Input:
// 'unexpected agent: tester:T1'"). Confirmed this mutation kills only this
// test, not its check_ids sibling below. Reverted after (confirmed
// byte-identical to the pre-mutation source); no behavior change here.
test('D2 (PB-84): evidence text alone ("Not applicable -- no fault") with empty check_ids still throws BLOCKED_BY_ENVIRONMENT -- judging emptiness, never the meaning of the text (regression guard)', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  await assert.rejects(run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return {
      task_id: 'T1', summary: 'blocked', passed: false,
      blocked_by_environment: { class: 'environment', check_ids: [], evidence: 'Not applicable -- no fault' },
    };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan }), (error) => {
    assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/);
    const fault = JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length));
    assert.equal(fault.stage, 'coder');
    assert.equal(fault.taskId, 'T1');
    return true;
  });
});

// (regression guard): mirrors the case above onto check_ids. Passes against
// both pre-fix and post-fix code. Killing mutation against the NEW code: drop
// the check_ids-non-empty half of the disjunction, e.g. change the condition
// to `if (!hasEvidence)`. Verified by applying that exact mutation directly
// to the tracked source and running this file: with evidence empty and
// check_ids no longer able to save it, stopIfBlocked wrongly swallows the
// block, the cycle proceeds to the (unmocked) tester, and this test's own
// mock throws `unexpected agent: tester:T1` -- the promise still rejects, but
// the inner `assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/)` fails
// against that message instead. Confirmed this mutation kills only this
// test, not its evidence sibling above. Reverted after (confirmed
// byte-identical to the pre-mutation source); no behavior change here.
test('D2 (PB-84): non-empty check_ids alone (empty evidence) still throws BLOCKED_BY_ENVIRONMENT, exactly as today (regression guard)', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  await assert.rejects(run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return {
      task_id: 'T1', summary: 'blocked', passed: false,
      blocked_by_environment: { class: 'environment', check_ids: ['git.runs'], evidence: '' },
    };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan }), (error) => {
    assert.match(error.message, /^BLOCKED_BY_ENVIRONMENT:/);
    const fault = JSON.parse(error.message.slice('BLOCKED_BY_ENVIRONMENT:'.length));
    assert.equal(fault.stage, 'coder');
    assert.deepEqual(fault.check_ids, ['git.runs']);
    return true;
  });
});

// (regression guard): blocked_by_environment: null already continues today --
// the pre-existing `if (result !== null && !result?.blocked_by_environment)
// return result` early return treats any falsy value, including a literal
// null, as "no block", and is untouched by this task's change. This task's
// new emptiness-check block never even runs for this input: that early
// return already exits the function first, so a mutation confined to the new
// block (e.g. its own `check_ids`/`evidence` checks) cannot affect this test
// at all -- it would be dead code for this specific input. The guard that
// actually matters here is that pre-existing line. Killing mutation: change
// its `return result` to `return null`. This is a broad mutation -- it nulls
// out the result of EVERY stage whose own result has no blocked_by_environment
// (i.e. almost every ordinary result in the cycle, not just this fixture's
// coder result) -- verified by copying sprint-cycle.js into the scratchpad,
// applying that exact edit there, and re-running this whole file against the
// mutated copy: all 31 tests in the file fail (as of this verification), not
// merely "most". Every test's run() call reaches the Preflight stage first,
// and preflight's own ordinary result equally lacks blocked_by_environment,
// so it too is nulled by the same mutation; the very next line reads
// preflight.status off that null and throws "Cannot read properties of null
// (reading 'status')" before the cycle ever reaches Plan/Build -- so no
// test's fixture-specific coder/tester/reviewer/security/validator branch
// runs, only the shared preflight mock does. A test that awaits run()
// directly surfaces that TypeError as its own failure (21 of the 31); one
// wrapped in assert.rejects instead has its validator callback run against
// that TypeError's message in place of the expected
// BLOCKED_BY_ENVIRONMENT/AMBIGUITY_BLOCK payload, failing either on an
// assert.match/deepEqual mismatch (7) or, when the validator's own first
// step is JSON.parse(error.message.slice(...)), on a SyntaxError from
// parsing that plain-English message as JSON (3). Reverted after
// (confirmed byte-identical to the pre-mutation source); no behavior change
// here.
test('D2 (PB-84): blocked_by_environment: null continues unchanged, exactly as today (regression guard)', async () => {
  const plan = { tasks: [{ id: 'T1', description: 'one task' }] };
  const result = await run(async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done', passed: true, blocked_by_environment: null };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  }, { plan });
  assert.equal(result.cycleOutcome.readyForPR, true);
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

// T1 (D1 gate): args.acknowledgements is the {item, answer, at} shape
// graph-run-record.mjs's `update --ack` writes onto run.json (REQ-M7's own
// text). Today the workflow never reads it -- an owner's recorded answer
// only unblocks Build once translated by hand into the flat
// args.acknowledgedAmbiguities list. These two cases are red on the current
// tree for that reason: not because the gate is wrong, but because this
// second channel does not exist yet.

test('REQ-M7 (D1 gate): args.acknowledgements alone (acknowledgedAmbiguities absent) lets Build run', async () => {
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

  // Today args.acknowledgements is never read, so this still throws
  // AMBIGUITY_BLOCK even though the owner's answer for 'X' is right here.
  const ackLabels = [];
  const result = await run(
    async (prompt, options) => { ackLabels.push(options.label); return mock(prompt, options); },
    { plan, acknowledgements: [{ item: 'X', answer: 'owner: X is fine as-is' }] }
  );
  assert.ok(ackLabels.includes('coder:T1'), 'coder should run once args.acknowledgements covers the only ambiguity');
  assert.equal(result.cycleOutcome.readyForPR, true);
});

test('REQ-M7 (D1 gate): one args.acknowledgements entry does not silently cover a different, unacknowledged ambiguity', async () => {
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], ambiguities: ['X', 'Y'] };

  const blockedLabels = [];
  await assert.rejects(
    run(
      async (prompt, options) => { blockedLabels.push(options.label); return mock(prompt, options); },
      { plan, acknowledgements: [{ item: 'X', answer: 'owner: X is fine as-is' }] }
    ),
    (error) => {
      assert.match(error.message, /^AMBIGUITY_BLOCK:/);
      // The discriminating assertion: today this payload is ['X','Y']
      // because args.acknowledgements is never read at all, so neither item
      // counts as acknowledged. It must become exactly ['Y'] once 'X' is
      // acknowledged through the new channel -- proving one acknowledged
      // item does not silently cover a different, unacknowledged one.
      assert.deepEqual(JSON.parse(error.message.slice('AMBIGUITY_BLOCK:'.length)), ['Y']);
      return true;
    }
  );
  assert.ok(!blockedLabels.some((label) => label.startsWith('coder:')), 'coder must not run while Y remains unacknowledged');
});

// Tester addendum to T1: the `'item' in entry` guard in the implementation
// (added specifically to stop a malformed entry from matching by coincidence)
// had no test of its own -- the two tests above never exercise an entry that
// omits `item`. This one closes that gap (the test right after it, on a
// conflicts-shaped item, is unrelated -- every entry there still carries
// `item`).

// D1 (regression-guard rule, cycle 13): passes today, unlabeled, against the
// current source -- labeled per D1 as a regression guard because it was
// verified red first. Killing mutation: delete the `'item' in entry &&`
// clause from the isAcknowledged combinator's `acknowledgements.some(...)`
// predicate in .claude/workflows/sprint-cycle.js (around line 210, the line
// containing `'item' in entry`). Observed: with that clause removed,
// JSON.stringify(entry.item) and JSON.stringify(item) both evaluate to the
// JS value `undefined` for this test's fixture and wrongly compare equal, so
// isAcknowledged(item) returns true, offendingItems comes back empty, and
// run() no longer throws AMBIGUITY_BLOCK at all -- assert.rejects then fails
// with "Missing expected rejection". Mutation applied, observed red, then
// reverted; no behavior change here.
test('REQ-M7 (D1 gate): an args.acknowledgements entry missing `item` never matches, even against an `undefined` plan item (closes the JSON.stringify(undefined) collision the guard exists for) (regression guard)', async () => {
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  // A real planner's JSON output can never contain `undefined` (JSON has no
  // such value), but a resumed cycle's args.plan is a live JS object, not a
  // JSON round-trip (see the comment above AC-M7.1), so this is reachable in
  // principle. It isolates the `'item' in entry` guard precisely:
  // JSON.stringify(undefined) is the JS value `undefined`, not a string, so
  // without the guard, an acknowledgements entry that omits `item`
  // (entry.item === undefined) would stringify-collide with this plan item
  // and silently acknowledge it -- letting Build run with a real,
  // unacknowledged ambiguity still on the table. With the guard, `'item' in
  // entry` is false for such an entry, so it is skipped regardless of what
  // it would otherwise stringify to, and the block still fires.
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], ambiguities: [undefined] };

  const blockedLabels = [];
  await assert.rejects(
    run(
      async (prompt, options) => { blockedLabels.push(options.label); return mock(prompt, options); },
      { plan, acknowledgements: [{ answer: 'no item field here' }] }
    ),
    (error) => {
      assert.match(error.message, /^AMBIGUITY_BLOCK:/);
      // JSON.stringify([undefined]) is '[null]' -- the offending-items array
      // still holds exactly one (unacknowledged) entry.
      assert.deepEqual(JSON.parse(error.message.slice('AMBIGUITY_BLOCK:'.length)), [null]);
      return true;
    }
  );
  assert.ok(!blockedLabels.some((label) => label.startsWith('coder:')), 'coder must not run: the item-less acknowledgements entry must not cover the undefined ambiguity');
});

test('REQ-M7 (D1 gate): a conflicts-shaped object is acknowledged via args.acknowledgements too (the comparator is item-shape-agnostic)', async () => {
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  const conflict = { higher: 'AGENTS.md precedence line', lower: 'plan.md', clause: 'owner decision > plan' };
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], conflicts: [conflict] };

  const ackLabels = [];
  const result = await run(
    async (prompt, options) => { ackLabels.push(options.label); return mock(prompt, options); },
    { plan, acknowledgements: [{ item: conflict, answer: 'owner: precedence line wins here' }] }
  );
  assert.ok(ackLabels.includes('coder:T1'), 'coder should run once the conflict object is acknowledged through args.acknowledgements');
  assert.equal(result.cycleOutcome.readyForPR, true);
});

// T2 (D1 delivery): once args.acknowledgements has cleared T1's gate above,
// every entry's owner-recorded answer must actually reach the roles doing
// the work -- not just unblock Build silently. Extends the fake-agent
// harness (inline, matching this file's existing style) to capture every
// role's own prompt string, keyed by label, so all five can be asserted on
// from one run.
test("T2 (D1 delivery): args.acknowledgements's answer text reaches all five coder/tester/reviewer/security/validator prompts as an OWNER DECISIONS block; the old acknowledgedAmbiguities-only channel (no args.acknowledgements) adds no such block anywhere (negative control -- also the old-style-resume-still-works check on the prompt-delivery side)", async () => {
  const SENTINEL = 'sentinel-q7vx4k-owner-answer-do-not-collide-elsewhere';
  const OWNER_DECISIONS_HEADING = 'OWNER DECISIONS (acknowledged AMBIGUITY_BLOCK items)';
  const roles = ['coder:T1', 'tester:T1', 'reviewer', 'security', 'validator'];
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

  // Positive: the new args.acknowledgements channel. Today (pre-T2) nothing
  // ever renders this into a prompt, so every assertion in this block fails
  // on the current tree -- starting with coder:T1, the first role built.
  const ackedPrompts = {};
  const ackedResult = await run(
    async (prompt, options) => { ackedPrompts[options.label] = prompt; return mock(prompt, options); },
    { plan, acknowledgements: [{ item: 'X', answer: SENTINEL }] }
  );
  assert.equal(ackedResult.cycleOutcome.readyForPR, true);
  for (const label of roles) {
    assert.ok(ackedPrompts[label], `${label} prompt should have been captured`);
    assert.ok(ackedPrompts[label].includes(OWNER_DECISIONS_HEADING), `${label} prompt should carry the exact OWNER DECISIONS heading`);
    assert.ok(ackedPrompts[label].includes(SENTINEL), `${label} prompt should carry the owner's answer text`);
  }

  // Negative control: the OLD channel only -- acknowledgedAmbiguities, with
  // args.acknowledgements entirely absent. T1 already made this unblock
  // Build (REQ-M7 (D1 gate) tests above); this re-confirms that still holds
  // and additionally checks the prompt-delivery side introduced by T2: since
  // there is no args.acknowledgements entry at all, no OWNER DECISIONS block
  // should appear anywhere. (This half is true on the tree both before and
  // after T2's change -- it is a regression guard, not a red/green flip; the
  // acked half above is the one that is red pre-change.)
  const oldStylePrompts = {};
  const oldStyleResult = await run(
    async (prompt, options) => { oldStylePrompts[options.label] = prompt; return mock(prompt, options); },
    { plan, acknowledgedAmbiguities: ['X'] }
  );
  assert.equal(oldStyleResult.cycleOutcome.readyForPR, true);
  for (const label of roles) {
    assert.ok(oldStylePrompts[label], `${label} prompt should have been captured`);
    assert.ok(!oldStylePrompts[label].includes('OWNER DECISIONS'), `${label} prompt should not carry an OWNER DECISIONS heading`);
    assert.ok(!oldStylePrompts[label].includes(SENTINEL), `${label} prompt should not leak the sentinel from the other run() call`);
  }
});

// Tester addendum to T2: the test above only ever renders a single, short,
// plan-matching item ('X'), so it never exercises two spec'd lines from the
// T2 task text itself: (1) "rendering each item as JSON.stringify(item)
// truncated to 300 characters", and (2) "emitting every entry present in
// args.acknowledgements rather than re-filtering it against
// plan.ambiguities/plan.conflicts". Both are correct by inspection of
// ownerDecisionsBlock, but neither had a test that would go red if a future
// edit broke it. These two close that gap; preflight is also spot-checked
// here since the task says it is unaffected (planner cannot be checked the
// same way -- these tests inject args.plan directly, bypassing a real
// planner agent call, same as every other test in this file).

test('T2 (D1 delivery): a long acknowledgements item is JSON.stringify-ed and truncated to exactly 300 characters, not more', async () => {
  const roles = ['coder:T1', 'tester:T1', 'reviewer', 'security', 'validator'];
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  const longItem = 'a'.repeat(400);
  const plan = { tasks: [{ id: 'T1', description: 'one task' }], ambiguities: [longItem] };
  // JSON.stringify(longItem) is the 400 a's plus two quote characters (402
  // chars total). Slicing that to exactly 300 keeps the opening quote and
  // 299 a's; slicing to 301 keeps one more a. Asserting the prompt contains
  // the first and not the second pins the truncation at exactly 300, not
  // merely "300 or fewer".
  const rendered = JSON.stringify(longItem);
  const truncatedTo300 = rendered.slice(0, 300);
  const oneCharPastTruncation = rendered.slice(0, 301);

  const prompts = {};
  const result = await run(
    async (prompt, options) => { prompts[options.label] = prompt; return mock(prompt, options); },
    { plan, acknowledgements: [{ item: longItem, answer: 'owner: fine as-is' }] }
  );
  assert.equal(result.cycleOutcome.readyForPR, true);
  for (const label of roles) {
    assert.ok(prompts[label].includes(truncatedTo300), `${label} prompt should include the item truncated to exactly 300 characters`);
    assert.ok(!prompts[label].includes(oneCharPastTruncation), `${label} prompt should not include the item's 301st character -- truncation must not run long`);
  }
});

test('T2 (D1 delivery): every args.acknowledgements entry is rendered, including one whose item is absent from plan.ambiguities/plan.conflicts (no second plan-comparison filter, per PB-70 point 2); preflight carries no OWNER DECISIONS block', async () => {
  const SENTINEL2 = 'sentinel-9f3k2m-second-entry-item-not-in-plan';
  const roles = ['coder:T1', 'tester:T1', 'reviewer', 'security', 'validator'];
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

  const prompts = {};
  const result = await run(
    async (prompt, options) => { prompts[options.label] = prompt; return mock(prompt, options); },
    { plan, acknowledgements: [
      { item: 'X', answer: 'owner: X is fine as-is' },
      { item: 'not-anywhere-in-plan', answer: SENTINEL2 },
    ] }
  );
  assert.equal(result.cycleOutcome.readyForPR, true);
  for (const label of roles) {
    assert.ok(prompts[label].includes(SENTINEL2), `${label} prompt should carry the second entry's answer even though its item matches nothing in plan.ambiguities/plan.conflicts`);
  }
  assert.ok(prompts.preflight, 'preflight prompt should have been captured');
  assert.ok(!prompts.preflight.includes('OWNER DECISIONS'), 'preflight prompt should carry no OWNER DECISIONS block (preflight is unaffected per the T2 task text)');
});

// T5 (D3): the planner's own prompt (the 'Plan' phase template literal) is
// today silent about source conflicts -- it tells the planner to report an
// ambiguity, but never mentions the `conflicts` field the schema already
// declares (see the REQ-M7 comment above it), and never states AGENTS.md's
// precedence order for the planner to check contradictions against. This is
// the first test in this file that calls run() WITHOUT supplying args.plan:
// every test above short-circuits `let plan = (args && args.plan) || null`
// and so never actually builds/sends the real planner-labeled prompt string
// -- this one must not, or the template literal edit below could go
// unverified. The fake agent supplies a minimal valid planner result so the
// cycle actually completes; deliberately using the harness's default
// backlogItem ('specs/graph/R-resilience.md', set by run() itself, not
// passed here) rather than this very task's real backlog item, which
// contains the word 'conflicts' repeatedly -- interpolating that in would
// make the /conflicts/i assertion pass vacuously no matter what the prompt
// template says.
test("T5 (D3): the planner prompt names the `conflicts` field and AGENTS.md's precedence order verbatim", async () => {
  const prompts = {};
  const mock = async (_, options) => {
    if (options.label === 'preflight') return { status: 'ready', check_ids: [] };
    if (options.label === 'planner') return { tasks: [{ id: 'T1', description: 'x' }] };
    if (options.label === 'coder:T1') return { task_id: 'T1', summary: 'done' };
    if (options.label === 'tester:T1') return { task_id: 'T1', passed: true, outcome: 'PASS' };
    if (options.label === 'reviewer') return { approved: true };
    if (options.label === 'security') return { passed: true, outcome: 'PASS' };
    if (options.label === 'validator') return { signed_off: true, outcome: 'PASS', reason: 'verified' };
    throw new Error(`unexpected agent: ${options.label}`);
  };
  const result = await run(async (prompt, options) => { prompts[options.label] = prompt; return mock(prompt, options); });
  assert.equal(result.cycleOutcome.readyForPR, true);

  assert.ok(prompts.planner, 'planner prompt should have been captured');
  assert.match(prompts.planner, /conflicts/i);
  // AGENTS.md:285 reads "Precedence order: owner decision > law/safety >
  // approved spec > ADR/AC > plan > code." -- assert the bare ordering
  // string verbatim, not that whole line (no "Precedence order:" label and
  // no trailing period are required of the planner prompt's own wording).
  assert.ok(
    prompts.planner.includes('owner decision > law/safety > approved spec > ADR/AC > plan > code'),
    "planner prompt should state AGENTS.md's precedence order verbatim"
  );
});
