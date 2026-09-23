#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const signatures = [
  ['environment', 'xcode.license', /You have not agreed to the Xcode license agreements/i],
  ['environment', 'xcode.path', /xcrun: error: invalid active developer path/i],
  ['environment', 'tool.missing', /\b(?:git|node|npm|npx|cosign|gitleaks|semgrep): command not found\b|\b(?:spawn|execFileSync)\s+(?:git|node|npm|npx|cosign|gitleaks|semgrep)\s+ENOENT\b/i],
  ['environment', 'bin.permissions', /\bnode_modules\/\.bin\/\S+\s+EACCES\b/i],
  ['api', 'api.error', /\b(?:rate_limit_error|overloaded_error|authentication_error)\b/i],
  ['transient', 'remote.network', /\b(?:registry|remote|github|npmjs)\b[^\n]*\b(?:ECONNREFUSED|ETIMEDOUT)\b|\b(?:ECONNREFUSED|ETIMEDOUT)\b[^\n]*\b(?:registry|remote|github|npmjs)\b/i],
  ['code', 'test.failure', /\bAssertionError\b|\bFAIL\s+\S+\.test\.[cm]?[jt]sx?\b/i],
];

export function classifyFault(error, { exitCode, agentClass } = {}) {
  if (error === null) return { class: 'api', classified_by: 'signature', signature: 'agent.null' };
  const message = String(error);
  for (const [faultClass, signature, pattern] of signatures) {
    if (pattern.test(message)) return { class: faultClass, classified_by: 'signature', signature };
  }
  if (exitCode === 127 && /command not found/i.test(message)) {
    return { class: 'environment', classified_by: 'signature', signature: 'tool.exit127' };
  }
  if (!['environment', 'api', 'transient', 'code'].includes(agentClass)) {
    throw new Error('Unrecognized fault requires an explicit agent verdict');
  }
  return { class: agentClass, classified_by: 'agent', signature: null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCodeAt = process.argv.indexOf('--exit-code');
  const agentClassAt = process.argv.indexOf('--agent-class');
  const exitCode = exitCodeAt < 0 ? undefined : Number(process.argv[exitCodeAt + 1]);
  const agentClass = agentClassAt < 0 ? undefined : process.argv[agentClassAt + 1];
  try {
    const input = readFileSync(0, 'utf8');
    process.stdout.write(`${JSON.stringify(classifyFault(input, { exitCode, agentClass }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
