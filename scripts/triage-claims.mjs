// Triage failing proof-of-work claims with Jev (specs/graph/J-jev-judgments.md, REQ-J8).
//
// For each claim a full `npm run validate:claims` reported as failing, re-run its
// test_command with a timeout, then ask Jev one Choice (the failure's cause) and one
// Noul (would re-pinning the proof to its own commit fix it). Code decides what to do
// with each answer; uncertain ones are marked for escalation to an agent or a person.
//
// Usage:
//   TYPESAFE_API_KEY=... node scripts/triage-claims.mjs --from-log <validator log> [--out <md>] [--concurrency 4] [--timeout-s 300]
//
// Reads claim YAML through python3 + PyYAML (a developer-machine dependency the
// proof scripts already use). Sends only the claim's own fields and the redacted tail
// of its proof output.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluate, decide, findSecret } from './jev.mjs';

export const CAUSES = [
  'missing_tool_or_environment',
  'drift_later_change',
  'moved_or_deleted_path',
  'external_state_dependent',
  'product_regression',
  'proof_script_defect',
  'flaky_or_timing',
];

const CAUSE_CRITERIA = {
  missing_tool_or_environment: 'Something outside the repository is missing or unreachable: a program not installed or not on PATH (exit 127, "command not found"), a missing module or package, absent credentials, or an unreachable network service.',
  drift_later_change: 'The proof reads the live working tree and a later, legitimate change altered what it asserts: text, counts, line numbers, file contents or configuration moved on while the claim\'s own commit is still correct.',
  moved_or_deleted_path: 'A file or directory the proof names was renamed, moved or deleted, so the proof cannot find it.',
  external_state_dependent: 'The proof depends on mutable state outside the repository that has changed: live CI logs, package-registry advisories, the current date or time, a remote service\'s current response.',
  product_regression: 'The code under test now behaves differently from what the claim asserts: a real defect in the product, not in the proof.',
  proof_script_defect: 'The proof script itself is broken: a syntax error, wrong working directory, bad quoting, a wrong relative path inside the script.',
  flaky_or_timing: 'A timeout, race, port collision or other timing effect; the same command would likely pass on a retry.',
};

/** Unique failing claim ids from a validator log, in order. */
export function failingIdsFromLog(log) {
  const seen = new Set();
  const out = [];
  for (const m of log.matchAll(/^✗ (claim-\d{4}-\d{2}-\d{2}-\d{3})\s*$/gm)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/** Last `n` lines of output, with any line holding a secret shape replaced. */
export function redactTail(text, n = 60) {
  return text.split('\n').slice(-n).map((line) => {
    const rule = findSecret(line);
    return rule ? `[redacted: ${rule}]` : line;
  }).join('\n');
}

export function buildQuestions() {
  return {
    cause: {
      type: 'choice',
      instructions: 'A proof-of-work claim\'s re-run failed. Using `description`, `test_command`, `expected_exit`, `actual_exit` and `output_tail`, what is the most likely cause of the failure?',
      criteria: CAUSE_CRITERIA,
    },
    repin_would_fix: {
      type: 'noul',
      instructions: 'Would the proof most likely pass again if it read the files as they were at the claim\'s own commit (for example through `git show <commit>:<path>`) instead of the current working tree?',
      criteria: {
        true: 'The failure comes from later changes to files the proof reads live.',
        false: 'The failure comes from something else: a missing tool, external state, a script bug, or a real regression.',
      },
    },
  };
}

/**
 * Classify one failing claim. Never throws: Jev failures become an escalated row.
 * @param {{id: string, description: string, test_command: string, expected_exit: number, actual_exit: number|string, output_tail: string}} c
 */
export async function triageOne(c, { evaluateImpl = evaluate, minConfidence = 0.8 } = {}) {
  const state = {
    claim_id: c.id,
    description: c.description,
    test_command: c.test_command,
    expected_exit: c.expected_exit,
    actual_exit: c.actual_exit,
    output_tail: c.output_tail,
  };
  try {
    const { answers } = await evaluateImpl({ state, questions: buildQuestions() });
    const cause = answers.cause;
    const decided = decide(cause, { minConfidence });
    const repin = decide(answers.repin_would_fix);
    return {
      id: c.id,
      actual_exit: c.actual_exit,
      cause: cause.choice,
      p: cause.probabilities?.[cause.choice] ?? null,
      confidence: cause.confidence,
      repin: repin && typeof repin === 'object' ? null : repin,
      repin_p: answers.repin_would_fix.noul,
      escalate: typeof decided === 'object',
      note: '',
    };
  } catch (err) {
    return { id: c.id, actual_exit: c.actual_exit, cause: 'unclassified', p: 0, confidence: 0, repin: null, repin_p: null, escalate: true, note: String(err?.message ?? err) };
  }
}

export function renderTable(rows) {
  const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? v.toFixed(2) : String(v));
  const lines = [
    '| claim | exit | cause | p(cause) | confidence | re-pin fixes | escalate | note |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.id} | ${fmt(r.actual_exit)} | ${r.cause} | ${fmt(r.p)} | ${fmt(r.confidence)} | ${fmt(r.repin)} | ${r.escalate ? 'yes' : 'no'} | ${String(r.note).replace(/\|/g, '/').slice(0, 120)} |`);
  }
  return lines.join('\n') + '\n';
}

function readClaim(repo, id) {
  const file = path.join(repo, '.workflow/proofs', `${id}.yml`);
  const py = 'import json,sys,yaml;c=yaml.safe_load(open(sys.argv[1]))["claim"];p=c.get("proof",{});print(json.dumps({"description":c.get("description",""),"test_command":p.get("test_command",""),"expected_exit":p.get("test_exit_code",0)}))';
  return JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf-8' }));
}

function runProof(repo, command, timeoutS) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY; // proofs never need the Jev key
    const child = spawn('bash', ['-c', command], { cwd: repo, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += `\n[triage: killed after ${timeoutS}s]`; child.kill('SIGKILL'); }, timeoutS * 1000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exit: code ?? `signal ${signal}`, out }); });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const logPath = opt('--from-log');
  if (!logPath) { console.error('usage: node scripts/triage-claims.mjs --from-log <validator log> [--out <md>] [--concurrency 4] [--timeout-s 300]'); process.exit(2); }
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const out = opt('--out', path.join(repo, `.workflow/state/claim-triage-${date}.md`));
  const ids = failingIdsFromLog(readFileSync(logPath, 'utf-8'));
  console.error(`triage: ${ids.length} failing claims`);
  const rows = await pool(ids, Number(opt('--concurrency', 4)), async (id) => {
    const c = readClaim(repo, id);
    const run = await runProof(repo, c.test_command, Number(opt('--timeout-s', 300)));
    if (run.exit === c.expected_exit) {
      return { id, actual_exit: run.exit, cause: 'passes_now', p: null, confidence: null, repin: null, escalate: false, note: 'passed on this re-run' };
    }
    const row = await triageOne({ id, ...c, actual_exit: run.exit, output_tail: redactTail(run.out) });
    console.error(`triage: ${id} -> ${row.cause}${row.escalate ? ' (escalate)' : ''}`);
    return row;
  });
  writeFileSync(out, `# Claim triage ${date}\n\nSource log: \`${logPath}\`. Cause and re-pin answers from Jev; "escalate" means confidence below the threshold or no answer.\n\n${renderTable(rows)}`);
  console.error(`triage: wrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
