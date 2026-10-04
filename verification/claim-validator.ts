#!/usr/bin/env node
// verification/claim-validator.ts
//
// Committed selectors bind a nonempty manifest to HEAD and check declared
// schema, main ancestry, changed regular blobs, target spec anchors and hash.
// Legacy explicit-file/implicit modes retain their older Git checks and
// optional unsafe shell replay. --no-rerun never observes command execution.
//
// Usage:
//   npm run validate:claims -- <claim-file> [--no-rerun]
//   npm run validate:claims -- --all --no-rerun
//   npm run validate:claims -- --claim <id> --no-rerun
//
// Exit codes:
//   0  metadata accepted; legacy implicit discovery also permits an empty set
//   1  one or more invalid (schema failures included)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { InputFailure, readInput, parseInput, loadSchema, type Claim, type ClaimDoc, type ValidationResult } from './claim-input.ts';
import { parseCommittedSelection, validateCommitted } from './committed-claims.ts';

function failedInput(message: string): ValidationResult {
  return { claim_id: '[invalid claim]', ok: false, failures: [message] };
}

// ─── Validators ──────────────────────────────────────────────────────────

function validateGitSha(sha: string): string[] {
  try {
    execSync(`git rev-parse --verify "${sha}^{commit}"`, { stdio: 'pipe' });
    return [];
  } catch {
    return [`git_sha ${sha} does not exist in this repository`];
  }
}

function validateFilesInCommit(sha: string, files: string[]): string[] {
  const failures: string[] = [];
  try {
    const changed = execSync(`git show --name-only --pretty=format: ${sha}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().split('\n').map(s => s.trim()).filter(Boolean);
    const changedSet = new Set(changed);
    for (const f of files) {
      if (!changedSet.has(f)) {
        failures.push(`files_changed[${f}] not present in commit ${sha}`);
      }
    }
  } catch (e) {
    failures.push(`Could not list files for ${sha}: ${(e as Error).message}`);
  }
  return failures;
}

function rerunTest(command: string, expectedExit: number, outputPath: string): string[] {
  const failures: string[] = [];
  try {
    const start = Date.now();
    execSync(command, { stdio: 'pipe', timeout: 300_000 }); // 5 min cap
    const duration = Date.now() - start;
    if (expectedExit !== 0) {
      failures.push(`Re-run exited 0 but expected ${expectedExit}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath + '.rerun', `OK (${duration}ms)`);
  } catch (e: unknown) {
    const exitCode = (e as { status?: number }).status ?? -1;
    if (exitCode !== expectedExit) {
      failures.push(`Re-run exit code ${exitCode} != expected ${expectedExit}`);
    }
  }
  return failures;
}

function recomputeReproducibilityHash(claim: Claim): string {
  const env = claim.proof.environment ?? {};
  const sortedEnv = Object.keys(env).sort().map(k => `${k}=${env[k]}`).join('\n');
  const input = `${claim.proof.test_command}\n---\n${sortedEnv}\n---\n${claim.proof.git_sha}`;
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

// ─── Main ────────────────────────────────────────────────────────────────

function validateClaim(filePath: string, options: { rerun: boolean }, validate: ValidateFunction<ClaimDoc>): ValidationResult {
  let doc: unknown;
  try {
    const root = fs.realpathSync(process.cwd());
    doc = parseInput(readInput(filePath, root, 'claim'), 'claim');
    if (validate(doc) !== true) {
      return { claim_id: '[invalid claim]', ok: false, failures: (validate.errors ?? []).map(error =>
        `claim schema ${JSON.stringify(error.keyword)} at ${JSON.stringify(error.schemaPath)}`) };
    }
  } catch (error) {
    return failedInput(error instanceof InputFailure ? error.message : 'claim: validation failed');
  }
  const claim = (doc as ClaimDoc).claim;
  const id = claim.id;
  const failures: string[] = [];

  failures.push(...validateGitSha(claim.proof.git_sha));
  failures.push(...validateFilesInCommit(claim.proof.git_sha, claim.proof.files_changed));

  const expectedHash = recomputeReproducibilityHash(claim);
  if (expectedHash !== claim.reproducibility_hash) {
    failures.push(
      `reproducibility_hash mismatch: stored=${claim.reproducibility_hash}, recomputed=${expectedHash}`,
    );
  }

  if (options.rerun) {
    failures.push(...rerunTest(claim.proof.test_command, claim.proof.test_exit_code, claim.proof.test_output_path));
  }

  return { claim_id: id, ok: failures.length === 0, failures };
}

function main() {
  const args = process.argv.slice(2);
  let selection;
  try { selection = parseCommittedSelection(args); }
  catch { console.error('committed: usage'); process.exit(1); }
  if (selection) {
    const results = validateCommitted(selection, recomputeReproducibilityHash);
    for (const result of results) {
      if (result.ok) console.log(`✓ committed claim metadata accepted: ${result.claim_id}`);
      else {
        console.log(`✗ ${result.claim_id}`);
        for (const failure of result.failures) console.log(`    - ${failure}`);
      }
    }
    const passed = results.filter(result => result.ok).length;
    console.log(`${passed}/${results.length} committed claim metadata accepted`);
    process.exit(results.length > 0 && passed === results.length ? 0 : 1);
  }
  const rerun = !args.includes('--no-rerun');
  const proofsDir = '.workflow/proofs';
  let files: string[] = [];

  if (args.includes('--all')) {
    if (fs.existsSync(proofsDir)) {
      files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.yml')).map(f => path.join(proofsDir, f));
    }
  } else {
    files = args.filter(a => !a.startsWith('--'));
    if (files.length === 0 && fs.existsSync(proofsDir)) {
      files = fs.readdirSync(proofsDir).filter(f => f.endsWith('.yml')).map(f => path.join(proofsDir, f));
    }
  }

  if (files.length === 0) {
    console.log('No claim files to validate.');
    process.exit(0);
  }

  let validate: ValidateFunction<ClaimDoc> | undefined;
  let schemaError = 'schema: compilation failed';
  try { validate = loadSchema(); }
  catch (error) { if (error instanceof InputFailure) schemaError = error.message; }
  const results = files.map(f => validate ? validateClaim(f, { rerun }, validate) : failedInput(schemaError));
  let anyFailed = false;
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.claim_id}`);
    } else {
      anyFailed = true;
      console.log(`✗ ${r.claim_id}`);
      for (const f of r.failures) console.log(`    - ${f}`);
    }
  }

  console.log('');
  const passed = results.filter(r => r.ok).length;
  console.log(`${passed}/${results.length} claims valid`);
  process.exit(anyFailed ? 1 : 0);
}

main();
