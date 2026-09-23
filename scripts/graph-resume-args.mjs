#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const stateDir = path.resolve(process.env.GRAPH_STATE_DIR || path.join(root, '.workflow', 'state'));
const journalRoot = path.resolve(process.env.GRAPH_RESUME_JOURNAL_ROOT
  || path.join(os.homedir(), '.claude', 'projects', root.replaceAll('/', '-')));
const inside = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);

function main() {
  const cycleId = process.argv[2];
  if (!/^[a-zA-Z0-9_-]+$/.test(cycleId || '') || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/graph-resume-args.mjs <cycleId>');
  }
  if (!inside(realpathSync(stateDir), root)) throw new Error('state directory leaves the project root');
  const runPath = path.join(stateDir, 'graph-cycles', cycleId, 'run.json');
  if (!inside(realpathSync(runPath), root)) throw new Error('run record leaves the project root');
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  if (run.cycleId !== cycleId || !run.runId) throw new Error('run record cycleId or runId is invalid');
  const journalPath = realpathSync(run.journalPath);
  if (!inside(journalPath, journalRoot)) throw new Error('journal leaves this project\'s Claude Workflow directory');
  const events = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const labels = new Map(events.filter((event) => event.type === 'started').map((event) => [event.key, event.label]));
  const results = new Map();
  for (const event of events) {
    if (event.type === 'result' && labels.has(event.key)) results.set(labels.get(event.key), event.result);
  }
  const plan = run.args?.plan || results.get('planner');
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('journal has no usable planner result');
  const backlogItem = run.backlogItem || run.args?.backlogItem;
  if (!backlogItem) throw new Error('run record has no exact backlogItem; add it before resuming');
  const priorBuildResults = [];
  const priorCoderResults = [];
  for (const task of plan.tasks) {
    const previousBuild = run.args?.priorBuildResults?.find((item) => item.task?.id === task.id);
    const previousCoder = run.args?.priorCoderResults?.find((item) => item.task?.id === task.id);
    const coderResult = results.get(`coder:${task.id}`) || previousBuild?.coderResult || previousCoder?.coderResult;
    const testerResult = results.get(`tester:${task.id}`) || previousBuild?.testerResult;
    if (testerResult && !coderResult) throw new Error(`tester result without coder result for ${task.id}`);
    if (testerResult) priorBuildResults.push({ task, coderResult, testerResult });
    else if (coderResult) priorCoderResults.push({ task, coderResult });
  }
  process.stdout.write(`${JSON.stringify({ backlogItem, cycleId, plan, priorBuildResults, priorCoderResults, resumedFrom: run.runId })}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`graph-resume-args: ${error.message}\n`); process.exitCode = 2; }
