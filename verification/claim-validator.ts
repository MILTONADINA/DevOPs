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
//   npm run validate:claims -- <claim-file> [--no-rerun]
//   npm run validate:claims -- --all [--no-rerun]
//
// Exit codes:
//   0  all valid, or no claim files found
//   1  one or more invalid (schema failures included)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument, isAlias, isCollection, isMap, isScalar } from 'yaml';
import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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

const INPUT_LIMIT = 262144;
type InputRole = 'claim' | 'schema';

class InputFailure extends Error {
  constructor(role: InputRole, category: string) { super(`${role}: ${category}`); }
}

function readInput(filePath: string, root: string, role: InputRole): string {
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    const file = path.resolve(root, filePath);
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
    let cursor = root;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      const entry = fs.lstatSync(cursor);
      if (entry.isSymbolicLink() || (cursor !== file && !entry.isDirectory())) throw new Error();
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > BigInt(INPUT_LIMIT)) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    const same = (stat: fs.BigIntStats) => stat.isFile() &&
      stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
      stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    if (!same(opened)) throw new Error();
    const buffer = Buffer.alloc(INPUT_LIMIT + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, used);
      if (count === 0) break;
      used += count;
    }
    if (used > INPUT_LIMIT || BigInt(used) !== opened.size || !same(fs.fstatSync(fd, { bigint: true })) ||
        !same(fs.lstatSync(file, { bigint: true })) || fs.realpathSync(file) !== file) throw new Error();
    bytes = buffer.subarray(0, used);
  } catch {
    throw new InputFailure(role, 'input unavailable or outside size/path policy');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new InputFailure(role, 'invalid UTF-8'); }
}

const CORE_TAGS = new Set(['str', 'null', 'bool', 'int', 'float', 'map', 'seq'].map(t => `tag:yaml.org,2002:${t}`));

function inspectYaml(node: unknown, depth = 0): void {
  if (node === null) return;
  if (isAlias(node) || (!isScalar(node) && !isCollection(node))) throw new Error();
  if (node.anchor || (node.tag && !CORE_TAGS.has(node.tag))) throw new Error();
  if (isScalar(node)) {
    const value = node.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) throw new Error();
    return;
  }
  if (++depth > 64) throw new Error();
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error();
      inspectYaml(pair.key, depth);
      inspectYaml(pair.value, depth);
    }
  } else {
    for (const item of node.items) inspectYaml(item, depth);
  }
}

function parseInput(text: string, role: InputRole): unknown {
  try {
    const doc = parseDocument(text, {
      version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
      resolveKnownTags: false, merge: false, prettyErrors: false,
      // 'silent' suppresses parseDocument's MULTIPLE_DOCS error in yaml2.
      logLevel: 'error',
    });
    if (doc.errors.length || doc.warnings.length || doc.contents === null || doc.directives.yaml.version !== '1.2') throw new Error();
    inspectYaml(doc.contents);
    return doc.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch { throw new InputFailure(role, 'invalid YAML or unsupported data shape'); }
}

// Only schema positions are traversed; annotation data may contain inert $ref keys.
function inspectSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const s = schema as Record<string, unknown>;
  if (s.$async === true) throw new Error();
  for (const key of ['$ref', '$dynamicRef']) {
    if (key in s && (typeof s[key] !== 'string' || !s[key].startsWith('#'))) throw new Error();
  }
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
    const map = s[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) Object.values(map).forEach(inspectSchema);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(s[key])) s[key].forEach(inspectSchema);
  }
  for (const key of ['items', 'contains', 'not', 'if', 'then', 'else', 'additionalProperties',
    'unevaluatedProperties', 'propertyNames', 'unevaluatedItems', 'contentSchema']) {
    inspectSchema(s[key]);
  }
}

function loadSchema(): ValidateFunction<ClaimDoc> {
  let schema: unknown;
  try {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = fs.realpathSync(path.resolve(directory, '..'));
    schema = parseInput(readInput(path.join(directory, 'claim-schema.yml'), packageRoot, 'schema'), 'schema');
  } catch (error) {
    throw error instanceof InputFailure ? error : new InputFailure('schema', 'input unavailable');
  }
  try {
    inspectSchema(schema);
    const ajv = new Ajv2020({
      strict: true, allErrors: true, validateSchema: true, validateFormats: true,
      coerceTypes: false, useDefaults: false, removeAdditional: false,
      verbose: false, messages: false, logger: false, ownProperties: true,
    });
    addFormats(ajv, { formats: ['date-time'], mode: 'full', keywords: false });
    const validate = ajv.compile<ClaimDoc>(schema as AnySchema);
    if (validate.$async) throw new Error();
    return validate as ValidateFunction<ClaimDoc>;
  } catch { throw new InputFailure('schema', 'compilation or reference policy failed'); }
}

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
