import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('resume args carry completed task pairs and a coder awaiting its tester', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-resume-test-'));
  try {
    const cycleDir = path.join(dir, 'graph-cycles', 'c7');
    mkdirSync(cycleDir, { recursive: true });
    const journalPath = path.join(dir, 'journal.jsonl');
    const plan = { tasks: [{ id: 'T1', description: 'first' }, { id: 'T2', description: 'second' }] };
    const events = [
      { type: 'started', key: 'p', label: 'planner' }, { type: 'result', key: 'p', result: plan },
      { type: 'started', key: 'c1', label: 'coder:T1' }, { type: 'result', key: 'c1', result: { task_id: 'T1', summary: 'coded T1' } },
      { type: 'started', key: 't1', label: 'tester:T1' }, { type: 'result', key: 't1', result: { task_id: 'T1', passed: true } },
      { type: 'started', key: 'c2', label: 'coder:T2' }, { type: 'result', key: 'c2', result: { task_id: 'T2', summary: 'coded T2' } },
      { type: 'started', key: 't2', label: 'tester:T2' }, { type: 'failed', key: 't2' },
    ];
    writeFileSync(journalPath, `${events.map(JSON.stringify).join('\n')}\n`);
    writeFileSync(path.join(cycleDir, 'run.json'), JSON.stringify({ schema_version: 1, cycleId: 'c7', backlogItem: 'one backlog item', runId: 'wf_test', journalPath, args: { backlogItem: 'one backlog item', cycleId: 'c7' } }));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'graph-resume-args.mjs'), 'c7'], {
      cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir, GRAPH_RESUME_JOURNAL_ROOT: dir }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.stdout);
    assert.deepEqual(args.plan, plan);
    assert.equal(args.priorBuildResults.length, 1);
    assert.equal(args.priorBuildResults[0].task.id, 'T1');
    assert.equal(args.priorCoderResults.length, 1);
    assert.equal(args.priorCoderResults[0].task.id, 'T2');
    assert.equal(args.resumedFrom, 'wf_test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume args merge earlier results with a journal that starts at tester T7', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-resume-test-'));
  try {
    const cycleId = 'cycle6';
    const cycleDir = path.join(dir, 'graph-cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    const journalPath = path.join(dir, 'journal.jsonl');
    const plan = { tasks: Array.from({ length: 13 }, (_, i) => ({ id: `T${i + 1}`, description: `task ${i + 1}` })) };
    const priorBuildResults = plan.tasks.slice(0, 6).map((task) => ({
      task, coderResult: { task_id: task.id }, testerResult: { task_id: task.id, passed: true },
    }));
    const priorCoderResults = [{ task: plan.tasks[6], coderResult: { task_id: 'T7' } }];
    const events = [
      { type: 'started', key: 't7', label: 'tester:T7' },
      { type: 'result', key: 't7', result: { task_id: 'T7', passed: true } },
    ];
    for (let n = 8; n <= 13; n++) {
      events.push(
        { type: 'started', key: `c${n}`, label: `coder:T${n}` },
        { type: 'result', key: `c${n}`, result: { task_id: `T${n}` } },
        { type: 'started', key: `t${n}`, label: `tester:T${n}` },
        { type: 'result', key: `t${n}`, result: { task_id: `T${n}`, passed: true } },
      );
    }
    writeFileSync(journalPath, `${events.map(JSON.stringify).join('\n')}\n`);
    const args = { backlogItem: 'cycle 6 fixture', cycleId, plan, priorBuildResults, priorCoderResults };
    writeFileSync(path.join(cycleDir, 'run.json'), JSON.stringify({ schema_version: 1, cycleId,
      backlogItem: args.backlogItem, runId: 'wf_9f295fe7-e33', journalPath, args }));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'graph-resume-args.mjs'), cycleId], {
      cwd: ROOT, env: { ...process.env, GRAPH_STATE_DIR: dir, GRAPH_RESUME_JOURNAL_ROOT: dir }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const resumed = JSON.parse(result.stdout);
    assert.deepEqual(resumed.plan, plan);
    assert.deepEqual(resumed.priorBuildResults.map((item) => item.task.id), plan.tasks.map((task) => task.id));
    assert.deepEqual(resumed.priorCoderResults, []);
    assert.equal(resumed.resumedFrom, 'wf_9f295fe7-e33');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
