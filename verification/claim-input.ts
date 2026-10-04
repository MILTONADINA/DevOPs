// Shared bounded input and packaged schema policy (MR10-A / MR10-B).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isAlias, isCollection, isMap, isScalar } from 'yaml';
import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export interface ClaimProof {
  git_sha: string;
  files_changed: string[];
  test_command: string;
  test_exit_code: number;
  test_output_path: string;
  red?: { sha: string; exit_code: number };
  duration_ms?: number;
  environment?: Record<string, string>;
}

export interface Claim {
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

export interface ClaimDoc {
  claim: Claim;
}

export interface ValidationResult {
  claim_id: string;
  ok: boolean;
  failures: string[];
}

const INPUT_LIMIT = 262144;
export type InputRole = 'claim' | 'schema' | 'manifest' | 'member' | 'spec' | 'git';

export class InputFailure extends Error {
  constructor(role: InputRole, category: string) { super(`${role}: ${category}`); }
}

export function readInputBytes(filePath: string, root: string, role: InputRole, limit = INPUT_LIMIT): Buffer {
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
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    const same = (stat: fs.BigIntStats) => stat.isFile() &&
      stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
      stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    if (!same(opened)) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, used);
      if (count === 0) break;
      used += count;
    }
    if (used > limit || BigInt(used) !== opened.size || !same(fs.fstatSync(fd, { bigint: true })) ||
        !same(fs.lstatSync(file, { bigint: true })) || fs.realpathSync(file) !== file) throw new Error();
    bytes = buffer.subarray(0, used);
  } catch {
    throw new InputFailure(role, 'input unavailable or outside size/path policy');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return bytes;
}

export function decodeInput(bytes: Uint8Array, role: InputRole): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new InputFailure(role, 'invalid UTF-8'); }
}

export function readInput(filePath: string, root: string, role: InputRole): string {
  return decodeInput(readInputBytes(filePath, root, role), role);
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

export function parseInput(text: string, role: InputRole): unknown {
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

export function loadSchema(): ValidateFunction<ClaimDoc> {
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
