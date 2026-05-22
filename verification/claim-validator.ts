#!/usr/bin/env node
// verification/claim-validator.ts
//
// Validates claim artifacts in .workflow/proofs/ against:
//   1. Schema conformance (claim-schema.yml)
//   2. Git SHA exists in repo
//   3. files_changed exist at that SHA
//   4. Re-running test_command produces test_exit_code
//   5. reproducibility_hash recomputes to the same value
//
// Usage:
//   node verification/claim-validator.js <claim-file> [--no-rerun]
//   node verification/claim-validator.js --all
//   node verification/claim-validator.js --session <session_id>
//
// Exit codes:
//   0  all valid
//   1  one or more invalid
//   2  schema error in input file

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';

interface ClaimProof {
  git_sha: string;
  files_changed: string[];
  test_command: string;
  test_exit_code: number;
  test_output_path: string;
  duration_ms?: number;
  environment?: Record<string, string>;
}

interface Claim {
  id: string;
  type: string;
  spec_ref: string;
  description: string;
  proof: ClaimProof;
  confidence: 'high' | 'medium' | 'low';
  reproducibility_hash: string;
  caveats?: string;
  timestamp?: string;
  tenant_id?: string;
  session_id?: string;
}

interface ClaimDoc {
  claim: Claim;
}

interface ValidationResult {
  claim_id: string;
  ok: boolean;
  failures: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseYamlLite(text: string): ClaimDoc {
  // Minimal YAML parser sufficient for our claim format.
  // For production, swap to `yaml` package. We use a lite parser to avoid
  // a dependency just for validation.
  const lines = text.split('\n');
  const obj: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj, indent: -1 },
  ];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    // Pop the stack until we find the right parent indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    // List item
    if (line.startsWith('- ')) {
      // Find the most recent array context
      const value = line.slice(2).trim();
      const parentKeys = Object.keys(parent);
      const lastKey = parentKeys[parentKeys.length - 1];
      if (lastKey && Array.isArray(parent[lastKey])) {
        (parent[lastKey] as unknown[]).push(stripQuotes(value));
      }
      continue;
    }

    // key: value
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '') {
      // Nested object or list following
      const next = lines.slice(i + 1).find(l => l.trim());
      if (next && next.trim().startsWith('- ')) {
        parent[key] = [];
      } else {
        const child: Record<string, unknown> = {};
        parent[key] = child;
        stack.push({ obj: child, indent });
      }
    } else if (rest.startsWith('|') || rest.startsWith('>')) {
      // Block scalar (multi-line string)
      const folded = rest.startsWith('>');
      const indentNext = lines[i + 1] ? lines[i + 1].length - lines[i + 1].trimStart().length : 0;
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          if (folded) collected.push('');
          j++;
          continue;
        }
        const li = l.length - l.trimStart().length;
        if (li < indentNext) break;
        collected.push(l.slice(indentNext));
        j++;
      }
      parent[key] = collected.join(folded ? ' ' : '\n').trim();
      i = j - 1;
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return obj as unknown as ClaimDoc;
}

function parseScalar(s: string): string | number | boolean {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return stripQuotes(t);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Validators ──────────────────────────────────────────────────────────

function validateSchema(doc: ClaimDoc): string[] {
  const failures: string[] = [];
  const c = doc?.claim;
  if (!c) return ['Missing top-level `claim` key'];

  if (!c.id || !/^claim-\d{4}-\d{2}-\d{2}-\d{3}$/.test(c.id))
    failures.push(`Invalid id: ${c.id}`);
  if (!c.type) failures.push('Missing type');
  if (!c.spec_ref || !c.spec_ref.startsWith('specs/'))
    failures.push(`Invalid spec_ref: ${c.spec_ref}`);
  if (!c.description || c.description.length < 10)
    failures.push('Description too short');
  if (!c.proof) failures.push('Missing proof');
  else {
    if (!c.proof.git_sha || !/^[0-9a-f]{7,40}$/.test(c.proof.git_sha))
      failures.push(`Invalid git_sha: ${c.proof.git_sha}`);
    if (!c.proof.files_changed || !Array.isArray(c.proof.files_changed) || c.proof.files_changed.length === 0)
      failures.push('Missing or empty files_changed');
    if (!c.proof.test_command) failures.push('Missing test_command');
    if (typeof c.proof.test_exit_code !== 'number')
      failures.push('Missing test_exit_code');
    if (!c.proof.test_output_path?.startsWith('.workflow/proofs/'))
      failures.push(`Invalid test_output_path: ${c.proof.test_output_path}`);
  }
  if (!['high', 'medium', 'low'].includes(c.confidence))
    failures.push(`Invalid confidence: ${c.confidence}`);
  if (!c.reproducibility_hash?.startsWith('sha256:'))
    failures.push(`Invalid reproducibility_hash: ${c.reproducibility_hash}`);

  return failures;
}

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

function validateClaim(filePath: string, options: { rerun: boolean }): ValidationResult {
  const text = fs.readFileSync(filePath, 'utf-8');
  const doc = parseYamlLite(text);
  const claim = doc?.claim;
  const id = claim?.id ?? path.basename(filePath);
  const failures: string[] = [];

  failures.push(...validateSchema(doc));
  if (failures.length > 0) return { claim_id: id, ok: false, failures };

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

  const results = files.map(f => validateClaim(f, { rerun }));
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
