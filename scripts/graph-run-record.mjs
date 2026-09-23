#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const state = path.resolve(process.env.GRAPH_STATE_DIR || path.join(root, '.workflow', 'state'));
if (!state.startsWith(`${root}${path.sep}`) || !realpathSync(state).startsWith(`${root}${path.sep}`)) throw new Error('state directory leaves project root');
const command = process.argv[2];
const options = {};
for (let i = 3; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('options require values');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const cycleId = options.cycle;
if (!/^[a-zA-Z0-9_-]+$/.test(cycleId || '')) throw new Error('invalid cycle id');
const directory = path.join(state, 'graph-cycles', cycleId);
const file = path.join(directory, 'run.json');
const scriptPath = path.join(root, '.claude', 'workflows', 'sprint-cycle.js');

if (command === 'launch') {
  if (!options.backlog || existsSync(file)) throw new Error('launch needs backlog and a new cycle id');
  mkdirSync(directory, { recursive: true });
  const args = { backlogItem: options.backlog, cycleId };
  const record = { schema_version: 1, cycleId, backlogItem: options.backlog, scriptPath, args,
    runId: null, journalPath: null, startedAt: new Date().toISOString(), status: 'running' };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
} else if (command === 'update') {
  if (!existsSync(file) || realpathSync(file) !== file) throw new Error('run record missing or redirected');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.cycleId !== cycleId || !['running', 'blocked', 'completed', 'failed'].includes(options.status)) throw new Error('invalid run update');
  if (options.runId) record.runId = options.runId;
  if (options.journal) record.journalPath = options.journal;
  if (options.args) record.args = JSON.parse(options.args);
  if (options.resumedFrom) record.resumedFrom = options.resumedFrom;
  record.status = options.status;
  record.updatedAt = new Date().toISOString();
  if (options.clearBlocked === 'true') {
    if (options.status !== 'running') throw new Error('blocked record clears only on a running resume');
    const preflight = JSON.parse(readFileSync(path.join(state, 'preflight.json'), 'utf8'));
    if (!['ready', 'remediated'].includes(preflight.status)) throw new Error('preflight has not passed');
    const blocked = path.join(state, 'blocked.md');
    if (existsSync(blocked) && !realpathSync(blocked).startsWith(`${root}${path.sep}`)) throw new Error('blocked record leaves project root');
    if (existsSync(blocked) && /^## Class\nneeds_human$/m.test(readFileSync(blocked, 'utf8'))) {
      throw new Error('needs_human blocked record must be cleared by the human after the fix');
    }
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (options.clearBlocked === 'true') {
    const blocked = path.join(state, 'blocked.md');
    if (existsSync(blocked)) unlinkSync(blocked);
  }
} else throw new Error('Usage: graph-run-record.mjs launch|update --cycle id [--backlog text] [--status status]');
process.stdout.write(`${file}\n`);
