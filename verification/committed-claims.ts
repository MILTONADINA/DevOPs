// specs/verification/committed-claims.md REQ-1..3, REQ-6..7.
// Committed declarations are inert metadata; selected command text is never run.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeInput, loadSchema, parseInput, readInputBytes, type Claim, type ClaimDoc, type ValidationResult } from './claim-input.ts';
import { createGitContext } from './committed-git.ts';

export type CommittedSelection = { all: true } | { id: string };
type Category = 'usage' | 'manifest' | 'member' | 'publication' | 'git' | 'claim' | 'spec';
type Member = { path: string; sha256: string };
type ClaimMember = Member & { id: string };
type Manifest = { schema_version: 1; claims: ClaimMember[]; artifacts: Member[] };
const DIRECTORY = '.workflow/proofs/committed';
const MANIFEST = `${DIRECTORY}/manifest.json`;
const MANIFEST_CAP = 65536;
const MEMBER_CAP = 262144;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^claim-\d{4}-\d{2}-\d{2}-\d{3}$/;

class CommittedFailure extends Error {
  constructor(category: Category) { super(`committed: ${category}`); }
}
function requireValue(condition: unknown, category: Category): asserts condition {
  if (!condition) throw new CommittedFailure(category);
}
function within<T>(category: Category, operation: () => T): T {
  try { return operation(); } catch { throw new CommittedFailure(category); }
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length === 20 && ID.test(value);
}
function normalized(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function parseCommittedSelection(args: string[]): CommittedSelection | null {
  if (!args.some(arg => arg === '--all' || arg === '--claim' || arg.startsWith('--all=') || arg.startsWith('--claim='))) return null;
  if (args.length === 2 && ((args[0] === '--all' && args[1] === '--no-rerun') ||
      (args[0] === '--no-rerun' && args[1] === '--all'))) return { all: true };
  if (args.length === 3) {
    const id = args[0] === '--no-rerun' && args[1] === '--claim' ? args[2] :
      args[0] === '--claim' && args[2] === '--no-rerun' ? args[1] : undefined;
    if (identifier(id)) return { id };
  }
  throw new CommittedFailure('usage');
}

function manifestFrom(bytes: Buffer): Manifest {
  const value: unknown = within('manifest', () => JSON.parse(decodeInput(bytes, 'manifest')));
  requireValue(objectWithKeys(value, ['schema_version', 'claims', 'artifacts']) && value.schema_version === 1, 'manifest');
  requireValue(Array.isArray(value.claims) && value.claims.length > 0 && value.claims.length <= 100 &&
    Array.isArray(value.artifacts) && value.artifacts.length > 0 && value.artifacts.length <= 100, 'manifest');
  const names = new Set<string>(); const ids = new Set<string>();
  for (const [members, isClaim] of [[value.claims, true], [value.artifacts, false]] as const) {
    for (const member of members) {
      requireValue(objectWithKeys(member, isClaim ? ['id', 'path', 'sha256'] : ['path', 'sha256']), 'manifest');
      requireValue(normalized(member.path) && !/\.log$/i.test(member.path) &&
        typeof member.sha256 === 'string' && member.sha256.length === 64 && HASH.test(member.sha256), 'manifest');
      requireValue(!names.has(member.path), 'manifest'); names.add(member.path);
      if (isClaim) {
        requireValue(identifier(member.id) && member.path === `claims/${member.id}.yml` && !ids.has(member.id), 'manifest');
        ids.add(member.id);
      } else requireValue(member.path.startsWith('scripts/') || member.path.startsWith('_checks/'), 'manifest');
    }
  }
  return value as unknown as Manifest;
}

function anchorCount(markdown: string, fragment: string): number {
  let count = 0;
  let fence: { character: string; length: number } | undefined;
  for (const raw of markdown.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceLine && fenceLine[1][0] === fence.character && fenceLine[1].length >= fence.length && /^[ \t]*$/.test(fenceLine[2])) fence = undefined;
      continue;
    }
    if (fenceLine) { fence = { character: fenceLine[1][0], length: fenceLine[1].length }; continue; }
    const literal = /^ {0,3}<a id="([A-Za-z][A-Za-z0-9_-]*)"><\/a>[ \t]*$/.exec(line);
    if (literal?.[1] === fragment) count++;
    // Keep the heading's whitespace separator until stripping optional closing hashes.
    const heading = /^ {0,3}#{1,6}([ \t]+.*)$/.exec(line);
    if (heading) {
      const slug = heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim().toLowerCase()
        .replace(/[^a-z0-9 \t_-]/g, '').replace(/[ \t]/g, '-');
      if (slug !== '' && slug === fragment) count++;
    }
  }
  return count;
}

export function validateCommitted(selection: CommittedSelection, recomputeHash: (claim: Claim) => string): ValidationResult[] {
  try {
    const root = within('publication', () => fs.realpathSync(process.cwd()));
    const manifestBytes = within('manifest', () => readInputBytes(MANIFEST, root, 'manifest', MANIFEST_CAP));
    const manifest = manifestFrom(manifestBytes);
    const git = within('git', () => createGitContext(root));
    const entries = within('git', () => git.listPublication());
    const expected = new Set([MANIFEST, ...manifest.claims.map(m => `${DIRECTORY}/${m.path}`), ...manifest.artifacts.map(m => `${DIRECTORY}/${m.path}`)]);
    requireValue(entries.size === expected.size && [...entries.keys()].every(name => expected.has(name)), 'publication');
    const committedManifest = within('git', () => git.readRegularBlob(git.head, MANIFEST, MANIFEST_CAP));
    requireValue(manifestBytes.equals(committedManifest), 'publication');
    const selected = 'all' in selection ? manifest.claims : manifest.claims.filter(member => member.id === selection.id);
    requireValue(selected.length > 0, 'claim');
    const texts = new Map<string, string>();
    for (const member of [...manifest.claims, ...manifest.artifacts]) {
      const file = `${DIRECTORY}/${member.path}`;
      const working = within('member', () => readInputBytes(file, root, 'member', MEMBER_CAP));
      const text = within('member', () => decodeInput(working, 'member'));
      const committed = within('git', () => git.readRegularBlob(git.head, file, MEMBER_CAP));
      requireValue(working.equals(committed) && createHash('sha256').update(working).digest('hex') === member.sha256, 'member');
      if (selected.some(claim => claim.path === member.path)) texts.set(member.path, text);
    }
    const validate = within('claim', () => loadSchema());
    return selected.map(member => {
      try {
        const doc = within('claim', () => parseInput(texts.get(member.path)!, 'claim'));
        if (validate(doc) !== true) {
          return { claim_id: member.id, ok: false, failures: (validate.errors ?? []).map(error =>
            `committed: claim schema ${JSON.stringify(error.keyword)} at ${JSON.stringify(error.schemaPath)}`) };
        }
        const claim = (doc as ClaimDoc).claim;
        requireValue(claim.id === member.id, 'claim');
        requireValue(claim.proof.git_sha.length === 40 && /^[0-9a-f]{40}$/.test(claim.proof.git_sha) &&
          claim.proof.files_changed.every(normalized), 'claim');
        requireValue(within('claim', () => recomputeHash(claim)) === claim.reproducibility_hash, 'claim');
        within('git', () => git.assertClaimTarget(claim.proof.git_sha, claim.proof.files_changed));
        const parts = claim.spec_ref.split('#');
        requireValue(parts.length === 2 && normalized(parts[0]) && /^specs\/.+\.md$/.test(parts[0]) && parts[1].length > 0, 'spec');
        const spec = within('spec', () => decodeInput(git.readRegularBlob(claim.proof.git_sha, parts[0], MEMBER_CAP), 'spec'));
        requireValue(anchorCount(spec, parts[1]) === 1, 'spec');
        return { claim_id: member.id, ok: true, failures: [] };
      } catch (error) {
        return { claim_id: member.id, ok: false, failures: [error instanceof CommittedFailure ? error.message : 'committed: claim'] };
      }
    });
  } catch (error) {
    return [{ claim_id: '[invalid claim]', ok: false, failures: [error instanceof CommittedFailure ? error.message : 'committed: publication'] }];
  }
}
