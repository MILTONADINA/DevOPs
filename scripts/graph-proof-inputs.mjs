#!/usr/bin/env node
// specs/graph/proof-inputs.md: inert extraction only; no execution or readiness.
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '..');
class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new Refusal(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, max = 128) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[^A-Za-z0-9_-]/.test(value);
const metadata = (value, max) => typeof value === 'string' && value.trim() !== ''
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

function inspectPath(file) {
  requireValue(file.startsWith(`${ROOT}${path.sep}`), 'INPUT_PATH');
  requireValue(realpathSync(ROOT) === ROOT, 'INPUT_PATH');
  let current = ROOT;
  const components = path.relative(ROOT, file).split(path.sep);
  let entry;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    entry = lstatSync(current, { bigint: true });
    requireValue(!entry.isSymbolicLink(), 'INPUT_PATH');
    requireValue(index === components.length - 1 ? entry.isFile() : entry.isDirectory(), 'INPUT_FILE');
  }
  requireValue(realpathSync(file) === file, 'INPUT_PATH');
  return entry;
}

function readContained(file, limit) {
  let descriptor;
  try {
    const entry = inspectPath(file);
    requireValue(entry.size >= 0n && entry.size <= BigInt(limit), 'INPUT_LIMIT');
    requireValue(typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_NONBLOCK === 'number', 'INPUT_FILE');
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    requireValue(before.isFile() && sameFile(entry, before), 'INPUT_CHANGED');
    requireValue(before.size <= BigInt(limit), 'INPUT_LIMIT');
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    requireValue(length <= limit, 'INPUT_LIMIT');
    const after = fstatSync(descriptor, { bigint: true });
    requireValue(after.isFile() && sameFile(before, after) && BigInt(length) === before.size, 'INPUT_CHANGED');
    let finalEntry;
    try { finalEntry = inspectPath(file); } catch { fail('INPUT_CHANGED'); }
    requireValue(sameFile(after, finalEntry), 'INPUT_CHANGED');
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('INPUT_ENCODING'); }
    return { bytes, text, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    fail('INPUT_FILE');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { fail('INPUT_FILE'); }
    }
  }
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { fail(code); }
}

function parseOptions(args) {
  requireValue(args.length === 4, 'USAGE');
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    requireValue(['--run', '--journal'].includes(name) && !options.has(name)
      && typeof args[index + 1] === 'string' && args[index + 1] !== '', 'USAGE');
    options.set(name, path.resolve(ROOT, args[index + 1]));
  }
  return { run: options.get('--run'), journal: options.get('--journal') };
}

function validateRun(run, journalPath) {
  requireValue(object(run) && run.schema_version === 1 && identifier(run.cycleId)
    && identifier(run.runId) && object(run.args) && typeof run.journalPath === 'string', 'RUN_RECORD');
  requireValue(!['resumedFrom', 'priorRunIds'].some((key) => Object.hasOwn(run, key))
    && !['resumedFrom', 'priorRunIds', 'plan', 'priorBuildResults', 'priorCoderResults']
      .some((key) => Object.hasOwn(run.args, key)), 'RESUME_UNSUPPORTED');
  requireValue(run.args.cycleId === run.cycleId && path.isAbsolute(run.journalPath)
    && run.journalPath === journalPath && path.basename(journalPath) === 'journal.jsonl'
    && path.basename(path.dirname(journalPath)) === run.runId, 'RUN_BINDING');
}

function journalLines(input) {
  let start = 0;
  let count = 0;
  const checkLine = (end) => {
    count += 1;
    requireValue(count <= 10000 && end - start <= 262144, 'INPUT_LIMIT');
  };
  for (let index = 0; index < input.bytes.length; index += 1) {
    if (input.bytes[index] !== 10) continue;
    checkLine(index > start && input.bytes[index - 1] === 13 ? index - 1 : index);
    start = index + 1;
  }
  if (start < input.bytes.length) checkLine(input.bytes.length);
  return input.text.split('\n').filter((line) => line.trim() !== '');
}

function currentRoles(lines) {
  const fields = {
    launched: ['type'], started: ['type', 'key', 'agentId', 'label', 'phase'],
    result: ['type', 'key', 'agentId', 'result'], failed: ['type', 'key', 'agentId'],
  };
  const keys = new Map();
  const labels = new Map();
  const agents = new Set();
  let launched = false;
  for (const line of lines) {
    const event = parseJson(line, 'JOURNAL_JSON');
    requireValue(object(event) && typeof event.type === 'string' && Object.hasOwn(fields, event.type), 'JOURNAL_EVENT');
    const expected = fields[event.type];
    requireValue(Object.keys(event).length === expected.length && expected.every((key) => Object.hasOwn(event, key)), 'JOURNAL_EVENT');
    if (event.type === 'launched') {
      requireValue(!launched, 'JOURNAL_ORDER');
      launched = true;
      continue;
    }
    requireValue(metadata(event.key, 256) && metadata(event.agentId, 256), 'JOURNAL_EVENT');
    if (event.type === 'started') requireValue(typeof event.label === 'string' && metadata(event.phase, 64), 'JOURNAL_EVENT');
    requireValue(launched, 'JOURNAL_ORDER');
    const previous = keys.get(event.key);
    if (event.type === 'started') {
      requireValue(!previous || previous.label === event.label, 'JOURNAL_BINDING');
      requireValue(!labels.has(event.label) || labels.get(event.label) === event.key, 'JOURNAL_BINDING');
      requireValue(!previous || previous.agentId !== event.agentId, 'JOURNAL_ORDER');
      requireValue(!agents.has(event.agentId), 'JOURNAL_BINDING');
      agents.add(event.agentId);
      labels.set(event.label, event.key);
      keys.set(event.key, { label: event.label, agentId: event.agentId, terminal: null });
    } else {
      requireValue(previous, 'JOURNAL_ORDER');
      requireValue(previous.agentId === event.agentId, 'JOURNAL_BINDING');
      requireValue(previous.terminal === null, 'JOURNAL_ORDER');
      previous.terminal = event.type;
      previous.result = event.result;
    }
  }
  requireValue(launched, 'JOURNAL_ORDER');
  return new Map([...labels].map(([label, key]) => [label, keys.get(key)]));
}

function declarations(roles) {
  const resultFor = (label) => {
    const role = roles.get(label);
    requireValue(role?.terminal === 'result' && object(role.result), 'ROLE_INCOMPLETE');
    return role.result;
  };
  const plan = resultFor('planner');
  requireValue(Array.isArray(plan.tasks) && plan.tasks.length > 0
    && plan.tasks.every((task) => object(task) && identifier(task.id)), 'PLAN_INVALID');
  const ids = plan.tasks.map((task) => task.id);
  requireValue(new Set(ids).size === ids.length, 'PLAN_INVALID');
  const expected = new Set(['preflight', 'planner', 'reviewer', 'security', 'validator',
    ...ids.flatMap((id) => [`coder:${id}`, `tester:${id}`])]);
  requireValue([...roles.keys()].every((label) => expected.has(label)), 'ROLE_INCOMPLETE');
  for (const label of expected) resultFor(label);

  const validCommand = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 8192;
  const validExit = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
  const testers = ids.map((id) => {
    const coder = resultFor(`coder:${id}`);
    const tester = resultFor(`tester:${id}`);
    requireValue(coder.task_id === id && tester.task_id === id, 'ROLE_INCOMPLETE');
    const proof = tester.proof;
    requireValue(object(proof) && validCommand(proof.command) && validExit(proof.exit_code), 'DECLARATION_INVALID');
    return { task_id: id, command: proof.command, exit_code: proof.exit_code };
  });
  const scans = resultFor('security').scans;
  requireValue(Array.isArray(scans) && scans.length > 0, 'DECLARATION_INVALID');
  const security = scans.map((scan) => {
    requireValue(object(scan) && identifier(scan.tool, 64) && validCommand(scan.command)
      && validExit(scan.exit_code) && Number.isSafeInteger(scan.scanned_files) && scan.scanned_files >= 0, 'DECLARATION_INVALID');
    return { tool: scan.tool, command: scan.command, exit_code: scan.exit_code, scanned_files: scan.scanned_files };
  });
  return { tester_proofs: testers, security_scans: security };
}

try {
  const files = parseOptions(process.argv.slice(2));
  const runInput = readContained(files.run, 262144);
  const run = parseJson(runInput.text, 'RUN_JSON');
  validateRun(run, files.journal);
  const journalInput = readContained(files.journal, 8388608);
  const proofs = declarations(currentRoles(journalLines(journalInput)));
  const output = { schema_version: 1, cycleId: run.cycleId, runId: run.runId,
    run_sha256: runInput.sha256, journal_sha256: journalInput.sha256,
    ...proofs, verification: 'not_run' };
  const json = JSON.stringify(output).replace(/[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  process.stdout.write(`${json}\n`);
} catch (error) {
  process.stderr.write(`graph-proof-inputs: ${error instanceof Refusal ? error.code : 'INPUT_FILE'}\n`);
  process.exitCode = 2;
}
