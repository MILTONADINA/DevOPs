#!/usr/bin/env bash
set -euo pipefail

# pwd -P: the physical path, the one realpathSync returns for every path compared with it below.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GRAPH_ROOT="$ROOT" node --input-type=module - "$@" <<'NODE'
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, existsSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import path from 'node:path';

const root = process.env.GRAPH_ROOT;
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error(`Invalid argument: ${args[i] || '(missing)'}`);
  options[args[i].slice(2)] = args[i + 1];
}
const cycle = options.cycle;
const stage = options.stage;
const task = options.task || 'none';
const faultClass = options.class;
if (!/^[a-zA-Z0-9_-]+$/.test(cycle || '') || !/^[a-zA-Z0-9_-]+$/.test(stage || '')) {
  throw new Error('cycle and stage must be simple identifiers');
}
if (!['environment', 'api', 'transient', 'needs_human'].includes(faultClass)) {
  throw new Error('class must be environment, api, transient, or needs_human');
}
const insideRoot = (value) => value === root || value.startsWith(`${root}${path.sep}`);
// The real path of a file that may not exist yet: the real path of its nearest existing ancestor,
// plus the names still missing below it (they do not exist, so they have no real path to resolve).
function realPathOf(file) {
  const missing = [];
  let current = file;
  for (;;) {
    try { lstatSync(current); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.join(realpathSync(current), ...missing);
}
const stateDir = path.resolve(process.env.GRAPH_STATE_DIR || path.join(root, '.workflow', 'state'));
if (!insideRoot(stateDir)) throw new Error('state directory must be inside the project root');
if (!insideRoot(realPathOf(stateDir))) throw new Error('state directory parent leaves the project root');
mkdirSync(stateDir, { recursive: true });
if (!insideRoot(realpathSync(stateDir))) throw new Error('state directory leaves the project root');
const secretPath = (value) => /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:pem|key))$/i.test(value);
if (options['evidence-file'] && secretPath(options['evidence-file'])) throw new Error('secret evidence file is forbidden');
const evidenceFile = options['evidence-file'] && existsSync(options['evidence-file']) ? realpathSync(options['evidence-file']) : undefined;
if (evidenceFile && secretPath(evidenceFile)) throw new Error('secret evidence file is forbidden');
if (evidenceFile && !insideRoot(evidenceFile)) throw new Error('evidence file must be inside the project root');
const redact = (value) => String(value)
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
  .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
const evidence = evidenceFile ? redact(readFileSync(evidenceFile, 'utf8').split('\n').slice(0, 20).join('\n'))
  : options['evidence-file'] ? 'Evidence file not found; no error text recorded.' : 'No error text provided.';
const checkIds = options.checks || 'none';
if (faultClass === 'needs_human' && !options.fix) throw new Error('needs_human requires --fix with the exact human action');
const fix = options.fix || (faultClass === 'api' || faultClass === 'transient'
  ? 'none needed — resumes when the API is back'
  : 'bash scripts/graph-preflight.sh');
const humanFix = faultClass === 'needs_human' ? `${redact(fix)}\nrm -- .workflow/state/blocked.md` : redact(fix);
const runPath = path.join(stateDir, 'graph-cycles', cycle, 'run.json');
let journal = 'unavailable';
try {
  if (!insideRoot(realpathSync(runPath))) throw new Error('run record leaves the project root');
  journal = JSON.parse(readFileSync(runPath, 'utf8')).journalPath || journal;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const record = [
  '# Graph cycle blocked',
  '',
  '## What happened',
  `${stage}${task === 'none' ? '' : ` task ${task}`} stopped on a ${faultClass} fault.`,
  '',
  '## Class',
  faultClass,
  '',
  '## Impact',
  `Cycle: ${cycle}; stage: ${stage}; task: ${task}; completed: ${options.completed || 'unknown'}; remaining: ${options.remaining || 'unknown'}.`,
  '',
  '## Fix',
  humanFix,
  '',
  '## Resume',
  `/sprint --resume ${cycle}`,
  '',
  '## Evidence',
  `Checks: ${checkIds}`,
  evidence,
  '',
  '## Run record',
  `${runPath}\nWorkflow journal: ${journal}`,
  '',
].join('\n');
const blockedPath = path.join(stateDir, 'blocked.md');
const temporary = `${blockedPath}.${process.pid}.tmp`;
// specs/phase-2/F-skill-provenance.md REQ-F10: exclusive create refuses a link
// planted at the temporary name, and the rename replaces a link at blocked.md.
writeFileSync(temporary, record, { mode: 0o600, flag: 'wx' });
renameSync(temporary, blockedPath);
const base = { timestamp: new Date().toISOString(), cycle_id: cycle, stage, task_id: task, class: faultClass, check_ids: checkIds.split(',') };
// The event log is appended without following a link out of the state directory.
const events = openSync(path.join(stateDir, 'events.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
try {
  writeFileSync(events, `${JSON.stringify({ event: 'graph.blocked', ...base })}\n${JSON.stringify({ event: 'graph.environment_fault', ...base })}\n`);
} finally {
  closeSync(events);
}
process.stdout.write(`${blockedPath}\n`);
NODE
