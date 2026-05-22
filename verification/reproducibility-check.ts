#!/usr/bin/env node
// verification/reproducibility-check.ts
//
// Standalone helper: given a claim, compute the reproducibility_hash
// the way the validator expects. Use this when emitting a new claim
// to ensure the stored hash will validate.
//
// Usage:
//   node verification/reproducibility-check.js <git_sha> "<command>"

import * as crypto from 'node:crypto';

function compute(gitSha: string, command: string, env: Record<string, string> = {}): string {
  const sortedEnv = Object.keys(env).sort().map(k => `${k}=${env[k]}`).join('\n');
  const input = `${command}\n---\n${sortedEnv}\n---\n${gitSha}`;
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

if (require.main === module) {
  const [, , sha, cmd] = process.argv;
  if (!sha || !cmd) {
    console.error('Usage: reproducibility-check <git_sha> "<command>"');
    process.exit(1);
  }
  console.log(compute(sha, cmd));
}

export { compute };
