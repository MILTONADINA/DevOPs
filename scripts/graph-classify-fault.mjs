#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, decide } from './jev.mjs';

const signatures = [
  ['environment', 'xcode.license', /You have not agreed to the Xcode license agreements/i],
  ['environment', 'xcode.path', /xcrun: error: invalid active developer path/i],
  ['environment', 'tool.missing', /\b(?:git|node|npm|npx|cosign|gitleaks|semgrep): command not found\b|\b(?:spawn|execFileSync)\s+(?:git|node|npm|npx|cosign|gitleaks|semgrep)\s+ENOENT\b/i],
  ['environment', 'bin.permissions', /\bnode_modules\/\.bin\/\S+\s+EACCES\b/i],
  ['api', 'api.error', /\b(?:rate_limit_error|overloaded_error|authentication_error)\b/i],
  ['transient', 'remote.network', /\b(?:registry|remote|github|npmjs)\b[^\n]*\b(?:ECONNREFUSED|ETIMEDOUT)\b|\b(?:ECONNREFUSED|ETIMEDOUT)\b[^\n]*\b(?:registry|remote|github|npmjs)\b/i],
  ['code', 'test.failure', /\bAssertionError\b|\bFAIL\s+\S+\.test\.[cm]?[jt]sx?\b/i],
];

function matchSignature(error, exitCode) {
  if (error === null) return { class: 'api', classified_by: 'signature', signature: 'agent.null' };
  const message = String(error);
  for (const [faultClass, signature, pattern] of signatures) {
    if (pattern.test(message)) return { class: faultClass, classified_by: 'signature', signature };
  }
  if (exitCode === 127 && /command not found/i.test(message)) {
    return { class: 'environment', classified_by: 'signature', signature: 'tool.exit127' };
  }
  return null;
}

export function classifyFault(error, { exitCode, agentClass } = {}) {
  const matched = matchSignature(error, exitCode);
  if (matched) return matched;
  if (!['environment', 'api', 'transient', 'code'].includes(agentClass)) {
    throw new Error('Unrecognized fault requires an explicit agent verdict');
  }
  return { class: agentClass, classified_by: 'agent', signature: null };
}

const FAULT_CLASSES = {
  environment: 'The toolchain, operating system or filesystem is broken or missing something: a program, library, file, permission or configuration outside the code under change. Re-running will fail the same way until the environment is fixed.',
  api: 'A model API refused or failed the request: quota or session limits, rate limits, overload, outage or authentication.',
  transient: 'A one-off network, registry or timing blip that a bounded re-run is likely to clear.',
  code: 'The change itself is wrong: a failing test, assertion, type error, lint error or other finding about the code being changed.',
};

/**
 * Classify a fault: deterministic signatures first, then an explicit agent verdict,
 * then a confidence-gated Jev judgment (classified_by: jev) for the residual. If Jev
 * is unavailable or uncertain, an explicit agent verdict is still required, exactly as
 * without Jev (specs/graph/J-jev-judgments.md REQ-J9; specs/graph/R-resilience.md REQ-R6).
 */
export async function classifyFaultWithJev(error, { exitCode, agentClass, evaluateImpl = evaluate, minConfidence = 0.8 } = {}) {
  const matched = matchSignature(error, exitCode);
  if (matched) return matched;
  if (agentClass !== undefined) return classifyFault(error, { exitCode, agentClass });
  let answer;
  try {
    const { answers } = await evaluateImpl({
      state: { error_lines: String(error).split('\n').slice(0, 20).join('\n'), exit_code: exitCode ?? null },
      questions: {
        fault_class: {
          type: 'choice',
          instructions: 'A step in an automated software-delivery pipeline failed with `error_lines` (and `exit_code` when known). Which kind of fault is this?',
          criteria: FAULT_CLASSES,
        },
      },
    });
    answer = answers.fault_class;
  } catch (err) {
    const why = err?.name === 'JevSecretInStateError' ? `Jev not asked: the error output holds a ${err.rule} secret shape` : `Jev unavailable: ${err.message}`;
    throw new Error(`Unrecognized fault requires an explicit agent verdict (${why})`);
  }
  const decided = decide(answer, { minConfidence });
  if (typeof decided !== 'string') {
    throw new Error(`Unrecognized fault requires an explicit agent verdict (Jev uncertain: ${answer.choice} at confidence ${answer.confidence})`);
  }
  return { class: decided, classified_by: 'jev', signature: null, confidence: answer.confidence, probabilities: answer.probabilities };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCodeAt = process.argv.indexOf('--exit-code');
  const agentClassAt = process.argv.indexOf('--agent-class');
  const exitCode = exitCodeAt < 0 ? undefined : Number(process.argv[exitCodeAt + 1]);
  const agentClass = agentClassAt < 0 ? undefined : process.argv[agentClassAt + 1];
  const input = readFileSync(0, 'utf8');
  classifyFaultWithJev(input, { exitCode, agentClass })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    });
}
