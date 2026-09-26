#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

// REQ-M5: launch and update --clearBlocked both need a fresh, passed,
// HEAD-matching preflight -- stale, mismatched, or failing preflight state
// must refuse the caller rather than let it launch or clear a block on
// out-of-date information. Returns preflight.ran_at (parsed) so clearBlocked
// can additionally compare it against blocked.md's mtime.
function requireFreshPreflight() {
  const preflightFile = path.join(state, 'preflight.json');
  if (existsSync(preflightFile) && realpathSync(preflightFile) !== preflightFile) throw new Error('preflight record redirected');
  const preflight = JSON.parse(readFileSync(preflightFile, 'utf8'));
  if (!['ready', 'remediated'].includes(preflight.status)) throw new Error('preflight has not passed');
  const sha = (spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();
  if (!sha || preflight.git_sha !== sha) throw new Error('preflight git_sha does not match HEAD');
  const ranAt = Date.parse(preflight.ran_at);
  if (!Number.isFinite(ranAt) || Date.now() - ranAt > 15 * 60 * 1000) throw new Error('preflight is stale (older than 15 minutes)');
  if (ranAt > Date.now() + 60_000) throw new Error('preflight ran_at is in the future');
  return ranAt;
}

if (command === 'launch') {
  if (!options.backlog || existsSync(file)) throw new Error('launch needs backlog and a new cycle id');
  requireFreshPreflight();
  mkdirSync(directory, { recursive: true });
  const args = { backlogItem: options.backlog, cycleId };
  const record = { schema_version: 1, cycleId, backlogItem: options.backlog, scriptPath, args,
    runId: null, journalPath: null, startedAt: new Date().toISOString(), status: 'running' };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
} else if (command === 'update') {
  if (!existsSync(file) || realpathSync(file) !== file) throw new Error('run record missing or redirected');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.cycleId !== cycleId || !['running', 'blocked', 'completed', 'failed', 'indeterminate'].includes(options.status)) throw new Error('invalid run update');
  if (options.runId && record.runId && options.runId !== record.runId) {
    if (options.resumedFrom !== record.runId || !options.args || !options.journal) {
      throw new Error('resume update requires prior run id, complete args, and new journal path');
    }
    const args = JSON.parse(options.args);
    if (args.cycleId !== cycleId || args.backlogItem !== record.backlogItem || args.resumedFrom !== record.runId
      || !Array.isArray(args.plan?.tasks) || !Array.isArray(args.priorBuildResults) || !Array.isArray(args.priorCoderResults)) {
      throw new Error('resume args are incomplete or do not match the prior run');
    }
    if (!path.isAbsolute(options.journal) || path.basename(options.journal) !== 'journal.jsonl'
      || path.basename(path.dirname(options.journal)) !== options.runId) {
      throw new Error('new journal path must identify the new Workflow run');
    }
  }
  if (options.runId) record.runId = options.runId;
  if (options.journal) record.journalPath = options.journal;
  if (options.args) record.args = JSON.parse(options.args);
  if (options.resumedFrom) record.resumedFrom = options.resumedFrom;
  // REQ-M7: update --ack <json> appends the owner's acknowledgements onto
  // run.json rather than replacing them, mirroring how every field above
  // layers onto the existing record. Shape per the spec text:
  // acknowledgements: [{item, answer, at}]. `item` is deliberately not
  // constrained to a string: a conflicts[] acknowledgement's item is the
  // {higher, lower, clause} object itself, and sprint-cycle.js's
  // isAcknowledged compares both shapes by JSON.stringify. Validated and
  // appended before writeFileSync below, so a rejected --ack leaves the
  // on-disk record untouched.
  if (options.ack) {
    let entries;
    try {
      entries = JSON.parse(options.ack);
    } catch {
      throw new Error('ack must be valid JSON');
    }
    const isAcknowledgement = (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && entry.item !== undefined && entry.item !== null
      && typeof entry.answer === 'string' && entry.answer.length > 0
      && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at));
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every(isAcknowledgement)) {
      throw new Error('ack must be a non-empty JSON array of {item, answer, at} objects');
    }
    if (record.acknowledgements !== undefined && !Array.isArray(record.acknowledgements)) {
      throw new Error('existing acknowledgements field is not an array');
    }
    record.acknowledgements = [...(record.acknowledgements || []), ...entries];
  }
  record.status = options.status;
  record.updatedAt = new Date().toISOString();
  if (options.clearBlocked === 'true') {
    if (options.status !== 'running') throw new Error('blocked record clears only on a running resume');
    const ranAt = requireFreshPreflight();
    const blocked = path.join(state, 'blocked.md');
    if (existsSync(blocked) && !realpathSync(blocked).startsWith(`${root}${path.sep}`)) throw new Error('blocked record leaves project root');
    if (existsSync(blocked) && /^## Class\nneeds_human$/m.test(readFileSync(blocked, 'utf8'))) {
      throw new Error('needs_human blocked record must be cleared by the human after the fix');
    }
    if (existsSync(blocked) && ranAt <= statSync(blocked).mtimeMs) {
      throw new Error('preflight ran before the current block was recorded');
    }
  }
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (options.clearBlocked === 'true') {
    const blocked = path.join(state, 'blocked.md');
    if (existsSync(blocked)) unlinkSync(blocked);
  }
} else throw new Error('Usage: graph-run-record.mjs launch|update --cycle id [--backlog text] [--status status] [--ack json]');
process.stdout.write(`${file}\n`);
