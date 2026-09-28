#!/usr/bin/env node
// verification/stale-proof-detector.ts
//
// Scans .workflow/proofs/ for claims that reference git_shas no longer
// reachable from any branch (e.g., force-pushed or garbage-collected).
//
// Such proofs are stale and must be regenerated.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const proofsDir = '.workflow/proofs';
if (!fs.existsSync(proofsDir)) {
  console.log('No proofs to check.');
  process.exit(0);
}

const files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.yml'));
let stale = 0;

for (const f of files) {
  const content = fs.readFileSync(path.join(proofsDir, f), 'utf-8');
  const shaMatch = content.match(/git_sha:\s*"?([0-9a-f]{7,40})"?/);
  if (!shaMatch) continue;
  const sha = shaMatch[1];
  try {
    execSync(`git rev-parse --verify ${sha}^{commit}`, { stdio: 'pipe' });
  } catch {
    console.log(`STALE: ${f} references unreachable SHA ${sha}`);
    stale++;
  }
}

console.log(`\n${stale}/${files.length} stale proofs`);
process.exit(stale > 0 ? 1 : 0);
