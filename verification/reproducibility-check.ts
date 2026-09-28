#!/usr/bin/env node
// verification/reproducibility-check.ts
//
// Standalone helper: given a claim, compute the reproducibility_hash
// the way the validator expects. Use this when emitting a new claim
// to ensure the stored hash will validate.
//
// Usage:
//   npx tsx verification/reproducibility-check.ts <git_sha> "<command>"

import * as crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function compute(gitSha: string, command: string, env: Record<string, string> = {}): string {
  const sortedEnv = Object.keys(env).sort().map(k => `${k}=${env[k]}`).join('\n');
  const input = `${command}\n---\n${sortedEnv}\n---\n${gitSha}`;
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

// ESM entry check: the package is "type": "module", where require.main does not exist.
// Compare real paths: import.meta.url is resolved through symlinks (macOS /tmp is one)
// while process.argv[1] is not, and a mismatch would silently print nothing.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const [, , sha, cmd] = process.argv;
  if (!sha || !cmd) {
    console.error('Usage: reproducibility-check <git_sha> "<command>"');
    process.exit(1);
  }
  console.log(compute(sha, cmd));
}

export { compute };
