#!/usr/bin/env node
// analyzer/install.ts
//
// Reads .workflow/profile.yml and installs the recommended components
// into the project's .claude/ (or equivalent tool config dir).
//
// Phase 2 Area F (REQ-F1..F7) extends this with skill-provenance verification
// at install time. Pre-existing copy semantics + AGENTS.md/CLAUDE.md/skills/
// hooks/subagents installation are preserved per NFR-F5 (surgical scope).
//
// F.01 — CLI flags: --target, --allow-unsigned, --rationale="...", --dry-run, --manifest <path>
// F.02 — Verification call-site (cosign verify-blob; gracefully falls back to
//        sha256 manifest hash check when cosign binary unavailable — defense-in-depth
//        per NFR-F3: manifest hash is ALWAYS checked).
// F.03 — Reject-unsigned exits 2 (distinct from generic-error 1), names the skill.
// F.04 — --allow-unsigned + --rationale path: copies + logs decision=overridden.
// F.05 — --allow-unsigned without --rationale: exits non-zero with directive message.
// F.06 — install.log JSONL writer for every verification decision.
// F.07 — --dry-run prints "would copy N skills"; no target mutation.
// F.08 — --manifest <path> loads alternate manifest.
// --no-agile-graph skips the optional Agile Graph link (specs/graph/agile-graph-link.md).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkAgileGraph } from './agile-graph.js';
import { ADOPTED_NOTICE, LOCAL_STATE_IGNORES, ignoreLines, openManifest, readRegular, replaceWhole, sha256 } from './install-manifest.js';
import { UnsafeWriteError, backupIfChanged, copyInside, freshBackupStamp, mkdirInside, present, writeInside } from './safe-write.js';

// specs/release/npm-package.md REQ-2: DEVOPS_ROOT if set, else the package this file
// ships in (analyzer/ sits directly under the package root).
const DEVOPS_ROOT = process.env.DEVOPS_ROOT && process.env.DEVOPS_ROOT.trim() !== ''
  ? process.env.DEVOPS_ROOT
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── CLI parsing (F.01) ──────────────────────────────────────────────────

interface CliFlags {
  target: string;
  allowUnsigned: boolean;
  rationale: string | null;
  dryRun: boolean;
  manifestPath: string;
  noAgileGraph: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    target: process.cwd(),
    allowUnsigned: false,
    rationale: null,
    dryRun: false,
    manifestPath: path.join(DEVOPS_ROOT, 'governance/skill-manifest.yml'),
    noAgileGraph: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Both forms, as scripts/init-project.sh reads them, so the git hook and the
    // installed components always land in the same project.
    if (a === '--target' || a.startsWith('--target=')) {
      const value = a === '--target' ? argv[++i] : a.slice('--target='.length);
      if (!value) { console.error('--target needs a directory'); process.exit(1); }
      flags.target = value;
    }
    else if (a === '--allow-unsigned') { flags.allowUnsigned = true; }
    else if (a.startsWith('--rationale=')) { flags.rationale = a.slice('--rationale='.length).replace(/^"|"$/g, ''); }
    else if (a === '--rationale') { flags.rationale = (argv[++i] || '').replace(/^"|"$/g, ''); }
    else if (a === '--dry-run') { flags.dryRun = true; }
    else if (a === '--manifest') { flags.manifestPath = argv[++i]; }
    else if (a === '--no-agile-graph') { flags.noAgileGraph = true; }
  }
  // F.05: --allow-unsigned without non-empty --rationale → exit non-zero
  if (flags.allowUnsigned && (flags.rationale === null || flags.rationale.trim() === '')) {
    console.error('--rationale="..." is required when --allow-unsigned is used');
    process.exit(1);
  }
  return flags;
}

// ─── Manifest loader (F.08) ──────────────────────────────────────────────

interface ManifestEntry {
  name: string;
  path: string;
  sha256: string;
  sig_path?: string;
  bundle_path?: string;
  signed_by?: string;
}

function loadManifest(manifestPath: string): ManifestEntry[] {
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  const txt = fs.readFileSync(manifestPath, 'utf-8');
  // Lightweight YAML parse: extract entries under `skills:` list
  const entries: ManifestEntry[] = [];
  const lines = txt.split(/\r?\n/);
  let current: Partial<ManifestEntry> | null = null;
  for (const ln of lines) {
    if (/^- name:/.test(ln)) {
      if (current) entries.push(current as ManifestEntry);
      const m = ln.match(/^- name:\s*(.+)$/);
      current = { name: m ? m[1].trim() : '' };
    } else if (current && /^  \w/.test(ln)) {
      const m = ln.match(/^  (\w+):\s*(.*)$/);
      if (m) (current as Record<string, string>)[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  if (current) entries.push(current as ManifestEntry);
  return entries;
}

// ─── Verification (F.02) ─────────────────────────────────────────────────
// Defense-in-depth (NFR-F3): hash check ALWAYS runs; signature check
// runs in addition when a .sig + bundle pair exists.

interface VerifyResult {
  ok: boolean;
  reason: string;
  sha256: string;
  signedBy?: string;
  // The cosign binary could not be started (not installed, or not executable): the skill
  // is not verified for lack of a verifier, not because a check failed (REQ-F12).
  verifierMissing?: boolean;
}

// docs/SKILL_SIGNING.md "Signing identity": only release-sign.yml in MILTONADINA/DevOPs,
// dispatched on a branch, signs skills. Any other GitHub workflow's certificate is refused.
const SIGNER_IDENTITY_REGEXP = '^https://github\\.com/MILTONADINA/DevOPs/\\.github/workflows/release-sign\\.yml@refs/heads/.+$';
const SIGNER_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const COSIGN_TIMEOUT_MS = 5000;
// The committed Sigstore trust root (AC-E5.1), read offline by cosign --trusted-root for
// new-format bundles. .workflow/ is not in the npm package, so an installed copy lacks it.
const TRUST_ROOT = path.join(DEVOPS_ROOT, '.workflow/sigstore/trust-bundle.json');
// cosign --new-bundle-format writes a Sigstore bundle with a mediaType; the legacy bundle
// (base64Signature, cert, rekorBundle) has none.
const NEW_BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle';

function isNewFormatBundle(bundlePath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf-8')) as { mediaType?: unknown };
    return typeof parsed.mediaType === 'string' && parsed.mediaType.startsWith(NEW_BUNDLE_MEDIA_TYPE);
  } catch {
    // Unreadable JSON takes the legacy path, which fails closed when cosign rejects it.
    return false;
  }
}

// ENOENT: no such binary. EACCES: present but not executable. Both mean no verifier runs.
const isMissingBinary = (code: string | undefined) => code === 'ENOENT' || code === 'EACCES';

// Whether the cosign binary (COSIGN_BIN, else `cosign` on PATH) is there and executable.
// It is looked up, not run: a run here would be a verification call to the binary.
function cosignInstalled(): boolean {
  const bin = process.env['COSIGN_BIN'] ?? 'cosign';
  const candidates = bin.includes(path.sep)
    ? [bin]
    : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir || '.', bin));
  return candidates.some(candidate => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function verifySkill(skillFullPath: string, entry: ManifestEntry, allowUnsigned: boolean): VerifyResult {
  // Step 1: NFR-F3 hash check — ALWAYS run, even with --allow-unsigned.
  if (!fs.existsSync(skillFullPath)) {
    return { ok: false, reason: `skill file missing: ${entry.path}`, sha256: '' };
  }
  const fileBytes = fs.readFileSync(skillFullPath);
  const actualHash = createHash('sha256').update(fileBytes).digest('hex');
  if (entry.sha256 && actualHash !== entry.sha256) {
    return { ok: false, reason: `manifest hash mismatch (expected ${entry.sha256.slice(0, 16)}…, got ${actualHash.slice(0, 16)}…)`, sha256: actualHash };
  }

  // Step 2: signature check — bypassable only by --allow-unsigned --rationale. The manifest
  // ships in the same package as the skill, so its hash alone cannot detect a modified
  // package: every way the signature cannot be verified fails closed.
  const unverified = (why: string, verifierMissing = false): VerifyResult => allowUnsigned
    ? { ok: true, reason: `${why}; override`, sha256: actualHash, signedBy: entry.signed_by }
    : { ok: false, reason: why, sha256: actualHash, verifierMissing };

  const sigPath = entry.sig_path ? path.join(DEVOPS_ROOT, entry.sig_path) : `${skillFullPath}.sig`;
  const bundlePath = entry.bundle_path ? path.join(DEVOPS_ROOT, entry.bundle_path) : `${skillFullPath}.bundle`;

  // A new-format bundle is checked offline against the committed trust root and needs no .sig.
  // A legacy .sig + .bundle pair keeps the cosign-cache check until its skill is re-signed (#345).
  const newFormat = fs.existsSync(bundlePath) && isNewFormatBundle(bundlePath);
  if (!newFormat && !fs.existsSync(sigPath)) return unverified('unsigned (no .sig present)');
  if (entry.signed_by && !new RegExp(SIGNER_IDENTITY_REGEXP).test(entry.signed_by)) {
    return unverified(`manifest signer is not the DevOPs release-sign workflow: ${entry.signed_by.slice(0, 120)}`);
  }
  if (!newFormat && !fs.existsSync(bundlePath)) return unverified('unverified (.sig present but no .bundle)');
  if (newFormat && !fs.existsSync(TRUST_ROOT)) return unverified(`unverified (trust root missing: ${TRUST_ROOT})`);

  // Per NFR-F1: ≤ 200 ms per skill. Local-only call; no network dep beyond
  // cosign's Sigstore trust-root cache.
  const cosign = process.env['COSIGN_BIN'] ?? 'cosign';
  const result = spawnSync(cosign, [
    'verify-blob',
    ...(newFormat ? ['--new-bundle-format', '--trusted-root', TRUST_ROOT] : []),
    '--bundle', bundlePath,
    '--certificate-identity-regexp', SIGNER_IDENTITY_REGEXP,
    '--certificate-oidc-issuer', SIGNER_OIDC_ISSUER,
    skillFullPath,
  ], { encoding: 'utf-8', timeout: COSIGN_TIMEOUT_MS });

  if (result.error || result.status === null) {
    // cosign is missing, could not start, timed out or was killed: nothing was verified.
    const code = result.error ? (result.error as NodeJS.ErrnoException).code : undefined;
    const why = result.error ? code ?? result.error.message : `signal ${result.signal}`;
    return unverified(`unverified (cosign did not complete: ${why})`, isMissingBinary(code));
  }
  if (result.status === 0) {
    return { ok: true, reason: 'verified (cosign + hash)', sha256: actualHash, signedBy: entry.signed_by };
  }
  return unverified(`cosign verify failed: ${(result.stderr || '').trim().slice(0, 200)}`);
}

// ─── install.log JSONL writer (F.06) ─────────────────────────────────────

function logDecision(targetRoot: string, decision: 'pass' | 'fail' | 'overridden' | 'skipped',
                     skillPath: string, sha256: string, signedBy: string | undefined,
                     rationale: string | null, dryRun: boolean) {
  if (dryRun) return; // F.07: dry-run does not mutate
  const logPath = path.join(targetRoot, '.workflow/state/install.log');
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    skill_path: skillPath,
    decision,
    sha256,
  };
  if (signedBy) entry.signed_by = signedBy;
  if (rationale && decision === 'overridden') entry.rationale = rationale;
  recorded(targetRoot, logPath, () => writeInside(targetRoot, logPath, JSON.stringify(entry) + '\n', { append: true }));
}

// ─── copy primitives (preserved) ─────────────────────────────────────────

// specs/phase-2/F-skill-provenance.md REQ-F10: every destination is inside
// `root`, and no write, append or mode change follows a symlink out of it.
// REQ-F11 (#349): a destination whose bytes differ from the packaged copy (a
// local edit, or an older release's file) is backed up before it is replaced.
// DEVOPS_BACKUP_STAMP, when it is a valid stamp, names the run's folder.
let backupStampOfRun: string | undefined;
function runBackupStamp(root: string): string {
  backupStampOfRun ??= /^[0-9TZ-]+$/.test(process.env.DEVOPS_BACKUP_STAMP ?? '')
    ? process.env.DEVOPS_BACKUP_STAMP!
    : freshBackupStamp(root);
  return backupStampOfRun;
}
const backedUp: string[] = [];

// specs/release/npm-package.md REQ-15 (#353): every file a real (not dry) run
// writes is recorded in .workflow/state/install-manifest.json, so uninstall can
// remove it and restore what was there. Saved when the process ends, even on an
// early exit, so a half-finished run is still recorded.
let record: ReturnType<typeof openManifest> | null = null;
const keyOf = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
function recorded(root: string, file: string, write: () => void) {
  record?.before(keyOf(root, file));
  try {
    write();
  } finally {
    // After a failed write, save() still hashes whatever reached the disk.
    if (record && fs.existsSync(file)) record.after(keyOf(root, file));
  }
}
function startRecord(root: string) {
  record = openManifest(root);
  if (record.started && record.data.adopted) console.log(ADOPTED_NOTICE);
  process.on('exit', code => {
    try {
      record?.save();
    } catch (error) {
      console.error(`devops: could not save the install manifest: ${(error as Error).message}`);
      if (code === 0) process.exitCode = 1;
    }
  });
}

function copy(root: string, src: string, dst: string, mode?: number) {
  const backup = backupIfChanged(root, dst, fs.readFileSync(src), runBackupStamp(root));
  recorded(root, dst, () => copyInside(root, src, dst, mode));
  if (backup) {
    backedUp.push(backup);
    console.log(`↻ Replaced ${path.relative(root, dst).split(path.sep).join('/')}; the previous copy is in ${backup}`);
  }
}

function copyDir(root: string, src: string, dst: string) {
  record?.dir(keyOf(root, dst));
  mkdirInside(root, dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(root, s, d);
    else copy(root, s, d);
  }
}

// ─── profile reader (preserved) ──────────────────────────────────────────

function loadProfileText(projectRoot: string): string {
  const p = path.join(projectRoot, '.workflow/profile.yml');
  if (!fs.existsSync(p)) {
    console.error('No .workflow/profile.yml found. Run `devops analyze` first.');
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf-8');
}

function extractList(text: string, sectionKey: string): string[] {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim() === `${sectionKey}:`);
  if (idx === -1) return [];
  const items: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (trimmed.startsWith('- ')) items.push(trimmed.slice(2).trim().replace(/^"|"$/g, ''));
    else if (trimmed === '') continue;
    else break;
  }
  return items;
}

// ─── skill resolution (REQ-F12) ──────────────────────────────────────────

// A skill the profile names, resolved to its source and manifest entry. Nothing is verified
// here: verification stays in the install loop, after the project's own files are written.
interface SkillRef {
  skill: string;
  kind: 'skipped' | 'unlisted' | 'candidate';
  relPath: string;
  entry?: ManifestEntry;
  skillMdPath: string;
  srcSkillDir: string;
}

function resolveSkills(skills: string[], manifestByName: Map<string, ManifestEntry>,
                       manifestByPath: Map<string, ManifestEntry>): SkillRef[] {
  return skills.map((s): SkillRef => {
    // specs/phase-2/D-stack-specific-skills.md REQ-D8: every recommended skill
    // is installed or printed as skipped with a reason, and counted.
    // Names come from the project's profile.yml: only lowercase path segments,
    // never '..', so a lookup stays under skills/.
    const stackSpecific = s.startsWith('stack-specific/');
    const srcSkillDir = path.join(DEVOPS_ROOT, 'skills', stackSpecific ? '' : 'universal', s);
    const skillMdPath = path.join(srcSkillDir, 'SKILL.md');
    const skipped: SkillRef = { skill: s, kind: 'skipped', relPath: '', skillMdPath, srcSkillDir };
    if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/.test(s)) {
      console.log(`⚠ skipped: ${JSON.stringify(s)} (not a valid skill name)`);
      return skipped;
    }
    if (!fs.existsSync(skillMdPath)) {
      console.log(`⚠ skipped: ${s} (this DevOPs release has no SKILL.md for it)`);
      return skipped;
    }

    // Look up by manifest path; fall back to name for universal skills only,
    // so a stack-specific skill never borrows another skill's entry.
    const relPath = path.relative(DEVOPS_ROOT, skillMdPath).replace(/\\/g, '/');
    const entry = manifestByPath.get(relPath) ?? (stackSpecific ? null : manifestByName.get(path.basename(s))) ?? null;

    if (!entry && stackSpecific) {
      // Not yet signed into governance/skill-manifest.yml (#347): not installed.
      console.log(`⚠ skipped: ${s} (not in governance/skill-manifest.yml, so it cannot be verified)`);
      return skipped;
    }
    if (!entry) {
      // REQ-F2 covers no-sig; here the skill is not in the manifest at all.
      // Defense-in-depth: no manifest entry → cannot verify hash → reject.
      console.error(`unsigned: ${relPath} (not in manifest)`);
      return { skill: s, kind: 'unlisted', relPath, skillMdPath, srcSkillDir };
    }
    return { skill: s, kind: 'candidate', relPath, entry, skillMdPath, srcSkillDir };
  });
}

interface Tally {
  installed: number;
  verified: number;
  overridden: number;
  skipped: number;
  failed: number;
  notVerified: number;
}

function summaryLine(t: Tally): string {
  return `installed=${t.installed} verified=${t.verified} overridden=${t.overridden} skipped=${t.skipped} failed=${t.failed} not verified (cosign missing)=${t.notVerified}`;
}

// REQ-F12: skills that could not be checked because there is no verifier. Exits 2.
function exitWithoutVerifier(t: Tally, lead: string): never {
  console.error('');
  console.error(summaryLine(t));
  console.error(lead);
  console.error('Install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) or set COSIGN_BIN, then rerun.');
  console.error('Or install them unverified with --allow-unsigned --rationale="<why>", which logs each one as overridden.');
  process.exit(2);
}

// ─── Claude Code hook wiring (#418, REQ-15) ──────────────────────────────

// Claude Code runs a hook only when .claude/settings.json names it (docs/HOOKS.md). Every hook
// init copies is either wired here, with its event, matcher (omitted for an event without one)
// and command, or listed as not wired with its reason. A pre or post hook runs through
// .claude/hooks/run-hook.mjs, which reads the tool call from stdin and gives the hook the input
// it takes (<input>: stdin, command or file). Changing a row changes what runs on every call.
type WiredRow = { event: string; matcher?: string; command: string };
type HookWiring = WiredRow | { unwired: string };
const isWired = (wiring: HookWiring | undefined): wiring is WiredRow => wiring !== undefined && 'command' in wiring;
const RUN_HOOK_FILE = 'run-hook.mjs';
// A pre command ends in `|| exit 2`: a node missing from Claude Code's PATH (127) or a runner that
// cannot start would otherwise exit with a code Claude Code does not treat as a block.
const runHook = (phase: 'pre' | 'post', name: string, input: 'stdin' | 'command' | 'file') =>
  `node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/${RUN_HOOK_FILE}" ${phase} ${name} ${input}${phase === 'pre' ? ' || exit 2' : ''}`;
const plainHook = (name: string) => `cd "\${CLAUDE_PROJECT_DIR:-.}" && bash .claude/hooks/${name} || true`;
const CLAUDE_HOOK_WIRING: Record<string, HookWiring> = {
  'deploy-gate.sh': { event: 'PreToolUse', matcher: 'Bash', command: runHook('pre', 'deploy-gate.sh', 'stdin') },
  'block-sealed-refs.sh': { event: 'PreToolUse', matcher: 'Bash', command: runHook('pre', 'block-sealed-refs.sh', 'stdin') },
  'block-prod-write.sh': { event: 'PreToolUse', matcher: 'Bash', command: runHook('pre', 'block-prod-write.sh', 'command') },
  'block-rm-rf.sh': { event: 'PreToolUse', matcher: 'Bash', command: runHook('pre', 'block-rm-rf.sh', 'command') },
  'block-new-dependency.sh': { event: 'PreToolUse', matcher: 'Bash', command: runHook('pre', 'block-new-dependency.sh', 'command') },
  'block-secrets.sh': { event: 'PreToolUse', matcher: 'Read|Write|Edit|MultiEdit|NotebookEdit', command: runHook('pre', 'block-secrets.sh', 'file') },
  'gitleaks-scan.sh': { event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit', command: runHook('post', 'gitleaks-scan.sh', 'file') },
  'load-baton.sh': { event: 'SessionStart', command: plainHook('load-baton.sh') },
  'write-baton.sh': { unwired: 'overwrites a hand-written baton; write it with /checkpoint instead' },
  'budget-brake.sh': { unwired: 'needs a per-call cost estimate that Claude Code does not give' },
  'loop-detection.sh': { unwired: 'needs a tool name and arguments; not wired until it is tested with real payloads' },
  'auto-format.sh': { unwired: 'opt-in: it rewrites files' },
  'sync-lr-refined-date.sh': { unwired: 'edits docs/LAUNCH_READINESS.md, which only this repository has' },
  'client-boundary.sh': { unwired: 'not registered by default (docs/HOOKS.md)' },
  'external-content-boundary.sh': { unwired: 'its HMAC check needs the session key from rotate-session-key.sh, which is not wired' },
  'rotate-session-key.sh': { unwired: 'rotates the session key that external-content-boundary.sh checks; not wired while that hook is not' },
  'graph-preflight.sh': { unwired: 'part of the Agile Graph pipeline, which the npm package excludes' },
};
// A hook whose wired command runs through run-hook.mjs, so init must copy that runner too.
const runsThroughRunHook = (name: string) => {
  const wiring = CLAUDE_HOOK_WIRING[name];
  return isWired(wiring) && wiring.command.includes(`/${RUN_HOOK_FILE}" `);
};

const SETTINGS = '.claude/settings.json';
const SETTINGS_TEMP = '.claude/settings.json.tmp';
const plural = (n: number) => (n === 1 ? 'hook' : 'hooks');

/**
 * Merges the entries for the copied hooks `names` into .claude/settings.json. Keeps every other
 * key and hook; adds nothing already wired under the same event and matcher (and says so for each),
 * and records only what it adds. A settings.json that is a link, not a regular file, or not a JSON
 * object is left unchanged, with a line saying why. A dry run writes nothing.
 */
function wireClaudeHooks(root: string, names: string[], dryRun: boolean) {
  const wanted: string[] = [];
  for (const name of names) {
    const wiring = CLAUDE_HOOK_WIRING[name];
    if (isWired(wiring)) wanted.push(name);
    else console.log(`  not wired: ${name} (${wiring ? wiring.unwired : 'no mapping in analyzer/install.ts'})`);
  }
  if (wanted.length === 0) return;

  const file = path.join(root, SETTINGS);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) {
    console.log(`⚠ ${SETTINGS} is a symlink; left unchanged, and no hook was wired into it.`);
    return;
  }
  if (stat && !stat.isFile()) {
    console.log(`⚠ ${SETTINGS} is not a regular file; left unchanged, and no hook was wired into it.`);
    return;
  }
  const bytes = stat ? readRegular(file) : null;
  const created = bytes === null;
  let config: Record<string, unknown> = {};
  if (bytes !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      /* not JSON: refused below */
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.log(`⚠ ${SETTINGS} is not a JSON object; left unchanged, and no hook was wired into it.`);
      return;
    }
    config = parsed as Record<string, unknown>;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (config.hooks !== undefined && !isObject(config.hooks)) {
    console.log(`⚠ ${SETTINGS} has a "hooks" value that is not an object; left unchanged, and no hook was wired into it.`);
    return;
  }
  const byEvent: Record<string, unknown> = isObject(config.hooks) ? config.hooks : {};
  for (const name of wanted) {
    const { event } = CLAUDE_HOOK_WIRING[name] as WiredRow;
    if (byEvent[event] !== undefined && !Array.isArray(byEvent[event])) {
      console.log(`⚠ ${SETTINGS}: "${event}" is not a list; left unchanged, and no hook was wired into it.`);
      return;
    }
  }

  // A wanted hook is already wired only when its command sits in a group with the same matcher
  // under the same event. The same command under another event or matcher is not wired, so it is
  // added. Each hook already wired is named, and nothing is added or recorded for it.
  const added: { name: string; event: string; matcher?: string; command: string; inner: { type: string; command: string } }[] = [];
  for (const name of wanted) {
    const { event, matcher, command } = CLAUDE_HOOK_WIRING[name] as WiredRow;
    const groups = (byEvent[event] ?? []) as unknown[];
    // An event without a matcher has groups without one: `matcher` undefined matches only those.
    const sameMatcher = groups.filter((g): g is { matcher?: unknown; hooks: unknown[] } =>
      isObject(g) && g.matcher === matcher && Array.isArray(g.hooks));
    if (sameMatcher.some(g => g.hooks.some(h => isObject(h) && h.command === command))) {
      console.log(`  already wired: ${name} (${event})`);
      continue;
    }
    const inner = { type: 'command', command };
    if (sameMatcher.length > 0) sameMatcher[0].hooks.push(inner);
    else groups.push(matcher === undefined ? { hooks: [inner] } : { matcher, hooks: [inner] });
    byEvent[event] = groups;
    added.push({ name, event, matcher, command, inner });
  }
  if (added.length === 0) return;
  if (config.hooks === undefined) config.hooks = byEvent;

  const list = added.map(a => `${a.event} ${a.name}`).join(', ');
  if (dryRun) {
    if (created) console.log(`would create ${SETTINGS}`);
    console.log(`would wire ${added.length} ${plural(added.length)} in ${SETTINGS}:`);
    for (const a of added) console.log(`  would add ${a.event}: ${a.name}${a.matcher === undefined ? '' : ` (matcher ${a.matcher})`}`);
    return;
  }
  // Recorded before the write (REQ-15): a run stopped here leaves uninstall a record it can check.
  const entries = added.map(a => ({
    event: a.event,
    ...(a.matcher === undefined ? {} : { matcher: a.matcher }),
    command: a.command,
    sha256: sha256(JSON.stringify(a.inner)),
  }));
  record?.claudeHooks(entries, created);
  try {
    replaceWhole(root, SETTINGS, `${JSON.stringify(config, null, 2)}\n`, { temp: SETTINGS_TEMP });
  } catch (error) {
    record?.forgetClaudeHooks(entries.map(e => e.command));
    console.log(`⚠ ${SETTINGS} could not be written (${(error as Error).message}); no hook was wired into it.`);
    return;
  }
  console.log(`✓ Claude Code hooks: wired ${added.length} ${plural(added.length)} in ${SETTINGS} (${list}).`);
}

// ─── main ────────────────────────────────────────────────────────────────

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const PROJECT_ROOT = flags.target;
  const manifest = loadManifest(flags.manifestPath);
  const manifestByName = new Map(manifest.map(e => [e.name, e]));
  const manifestByPath = new Map(manifest.map(e => [e.path, e]));

  const profile = loadProfileText(PROJECT_ROOT);
  const skills = extractList(profile, 'skills');
  const hooks = extractList(profile, 'hooks');
  const subagents = extractList(profile, 'subagents');

  console.log(`Installing into ${PROJECT_ROOT}`);
  console.log(`DevOPs root:   ${DEVOPS_ROOT}`);
  console.log(`Manifest:      ${flags.manifestPath}`);
  if (flags.dryRun) console.log('Mode:          --dry-run (no target mutation)');
  if (flags.allowUnsigned) console.log(`Override:      --allow-unsigned rationale="${flags.rationale}"`);
  console.log('');

  // REQ-F12: the verifier's availability is decided before the first write. Without cosign a
  // real run stops here, with nothing written and no manifest. A dry run goes on, reports the
  // plan, and counts the skills it could not check.
  const resolved = resolveSkills(skills, manifestByName, manifestByPath);
  const count = (kind: SkillRef['kind']) => resolved.filter(r => r.kind === kind).length;
  const gated = !flags.allowUnsigned && count('candidate') > 0 && !cosignInstalled();
  if (gated && !flags.dryRun) {
    exitWithoutVerifier({
      installed: 0, verified: 0, overridden: 0, skipped: count('skipped'), failed: count('unlisted'), notVerified: count('candidate'),
    }, `cosign is not installed or cannot be run, so ${count('candidate')} skill(s) could not be verified. Nothing was written to the project.`);
  }
  if (!flags.dryRun) startRecord(PROJECT_ROOT);

  // specs/release/npm-package.md REQ-10: keep the constitution a live dependency.
  // Compare path components, not string prefixes (a sibling is not inside target).
  const packageRelative = path.relative(fs.realpathSync(PROJECT_ROOT), fs.realpathSync(DEVOPS_ROOT));
  const packageInProject = packageRelative !== '..' && !packageRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(packageRelative);
  // A file in this DevOPs package, named so the reader can open it from the project.
  const packageRef = (inPackage: string) => packageInProject
    ? `\`${path.join(packageRelative, inPackage).replace(/\\/g, '/')}\``
    : `\`${inPackage}\` in the \`@miltonadina/devops\` package`;
  // package.json `files`: what npm ships of this package (an entry is a file, or a
  // folder ending in /; a leading ! excludes).
  // A DevOPs root without a package.json (a partial layout) ships nothing to name.
  const packageJson = path.join(DEVOPS_ROOT, 'package.json');
  const packageMeta = fs.existsSync(packageJson) ? JSON.parse(fs.readFileSync(packageJson, 'utf-8')) : {};
  const packageFiles: string[] = packageMeta.files ?? [];
  // #420: every URL the closing text names is built here, pinned to this package's release
  // tag, so a reader outside the project can open the file. `main` is only the fallback for a
  // DevOPs root without a package.json (a partial layout; npm always ships one).
  const docUrl = (p: string) => `https://github.com/MILTONADINA/DevOPs/blob/v${packageMeta.version ?? 'main'}/${p}`;
  const shipped = (p: string) => {
    const hit = (entry: string) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry);
    return packageFiles.some(e => !e.startsWith('!') && hit(e)) && !packageFiles.some(e => e.startsWith('!') && hit(e.slice(1)));
  };
  // A package path such as `docs/MEMORY.md`, or a pattern such as
  // `lifecycle/<phase>/PHASE.md` whose fixed part ships. Project state (`.workflow/`),
  // slash commands and bare names are not package paths.
  const shipsInPackage = (token: string) => {
    if (token.startsWith('.workflow/') || token.startsWith('/') || token.includes('..') || !token.includes('/')) return false;
    const parts = token.split('/');
    const open = parts.findIndex(part => /[<*]/.test(part));
    const fixed = open === -1 ? token : `${parts.slice(0, open).join('/')}/`;
    return fixed !== '/' && shipped(fixed) && fs.existsSync(path.join(DEVOPS_ROOT, fixed));
  };
  const constitutionRefs = new Map(['PRINCIPLES.md', 'ANTIPATTERNS.md', 'LOOP.md'].map(file => {
    const inPackage = `constitution/${file}`;
    return [inPackage, packageRef(inPackage)];
  }));

  // AGENTS.md + CLAUDE.md install (not skills, no verification).
  // Gracefully skip when DEVOPS_ROOT source is missing (test harnesses or
  // non-canonical layouts) — these are operator-convenience copies, not
  // verification-gated artifacts.
  const srcAgents = path.join(DEVOPS_ROOT, 'AGENTS.md');
  const targetAgents = path.join(PROJECT_ROOT, 'AGENTS.md');
  if (!present(targetAgents) && fs.existsSync(srcAgents)) {
    if (!flags.dryRun) {
      // specs/release/npm-package.md REQ-17 (#380): every backticked path that names
      // a file this package ships is rewritten the way the constitution is, so the
      // reader can open it from the project.
      const agents = fs.readFileSync(srcAgents, 'utf-8').replace(
        /`([^`\s]+)`/g,
        (match, token: string) => (shipsInPackage(token) ? packageRef(token) : match),
      );
      recorded(PROJECT_ROOT, targetAgents, () => writeInside(PROJECT_ROOT, targetAgents, agents));
    }
    console.log(flags.dryRun ? 'would install: AGENTS.md' : '✓ Installed AGENTS.md');
  } else if (present(targetAgents)) {
    console.log('⚠ AGENTS.md already exists; not overwriting');
  }
  // specs/release/npm-package.md REQ-11: consumers get a short adapter template, not
  // this repository's own development CLAUDE.md.
  const srcClaude = path.join(DEVOPS_ROOT, 'templates/claude-md/CLAUDE_TEMPLATE.md');
  const targetClaude = path.join(PROJECT_ROOT, 'CLAUDE.md');
  if (!present(targetClaude) && fs.existsSync(srcClaude)) {
    if (!flags.dryRun) {
      const claude = fs.readFileSync(srcClaude, 'utf-8').replace(
        /\{\{(constitution\/(?:PRINCIPLES|ANTIPATTERNS|LOOP)\.md)\}\}/g,
        (_match, file) => constitutionRefs.get(file)!,
      );
      recorded(PROJECT_ROOT, targetClaude, () => writeInside(PROJECT_ROOT, targetClaude, claude));
    }
    console.log(flags.dryRun ? 'would install: CLAUDE.md' : '✓ Installed CLAUDE.md');
  } else if (present(targetClaude)) {
    console.log('⚠ CLAUDE.md already exists; not overwriting');
  }

  // Append only: retain existing bytes, including CRLF and a missing final newline.
  // This local override is useful even before the project becomes a git repository.
  // The install manifest and its originals are this machine's record, which
  // uninstall refuses once Git tracks them (REQ-10, REQ-16; #390).
  const added = ignoreLines(PROJECT_ROOT, ['AGENTS.override.md', ...LOCAL_STATE_IGNORES], { record, dryRun: flags.dryRun });
  if (added.length) console.log(flags.dryRun ? `dry-run: would add ${added.join(', ')} to .gitignore` : `✓ Added ${added.join(', ')} to .gitignore`);

  // Skills with verification (F.01..F.07). Each candidate is verified here, after the
  // project files above are written, as before; the gate above already ruled out a missing cosign.
  let verified = 0, overridden = 0, failed = count('unlisted'), notVerified = 0;
  const skipped = count('skipped');
  for (const r of resolved) {
    if (r.kind === 'unlisted') {
      logDecision(PROJECT_ROOT, 'fail', r.relPath, '', undefined, null, flags.dryRun);
      continue;
    }
    if (r.kind !== 'candidate') continue;
    const entry = r.entry!;

    // A dry run past the gate has no verifier to ask; the skill is counted, not verified.
    if (gated) {
      console.error(`not verified (cosign missing): ${entry.path}`);
      notVerified++;
      continue;
    }
    const verdict = verifySkill(r.skillMdPath, entry, flags.allowUnsigned);
    if (!verdict.ok && verdict.verifierMissing) {
      console.error(`not verified (cosign missing): ${entry.path} (${verdict.reason})`);
      notVerified++;
      continue;
    }
    if (!verdict.ok) {
      // F.03: reject-unsigned exits 2 distinct from generic-error 1
      console.error(`unsigned: ${entry.path} (${verdict.reason})`);
      logDecision(PROJECT_ROOT, 'fail', entry.path, verdict.sha256, undefined, null, flags.dryRun);
      failed++;
      continue;
    }
    // Verified or override-accepted
    const decision: 'pass' | 'overridden' = verdict.reason.includes('override') ? 'overridden' : 'pass';
    logDecision(PROJECT_ROOT, decision, entry.path, verdict.sha256, verdict.signedBy, flags.rationale, flags.dryRun);
    if (decision === 'overridden') overridden++; else verified++;

    if (flags.dryRun) {
      console.log(`would copy: ${entry.path} (${verdict.reason})`);
      continue;
    }
    const dst = path.join(PROJECT_ROOT, '.claude/skills', path.basename(r.skill));
    copyDir(PROJECT_ROOT, r.srcSkillDir, dst);
  }
  const t: Tally = { installed: verified + overridden, verified, overridden, skipped, failed, notVerified };

  // REQ-F12: no verifier for some skills, so the install stops. A real run gets here only if
  // cosign stopped running mid-install; a dry run gets here with the plan printed.
  if (notVerified > 0 && !flags.allowUnsigned) {
    exitWithoutVerifier(t, flags.dryRun
      ? `cosign is not installed or cannot be run, so ${notVerified} skill(s) could not be verified. dry-run: nothing was written.`
      : `cosign could not run for ${notVerified} skill(s); the skills before them were installed.`);
  }

  // F.03: if any skill failed and no override, exit 2.
  if (failed > 0 && !flags.allowUnsigned) {
    console.error('');
    console.error(summaryLine(t));
    console.error('Skills install only once cosign verifies their signature from the DevOPs release workflow.');
    console.error('Install cosign (https://docs.sigstore.dev/cosign/system_config/installation/) and rerun, or install');
    console.error('them unverified with --allow-unsigned --rationale="<why>", which logs each one as overridden.');
    process.exit(2);
  }

  // Hooks + subagents (no verification at v0.2.0; surgical scope per NFR-F5).
  // REQ-M16: these two hooks invoke a fixed sibling companion. Validate it
  // before copying either dependent hook; it is not another registered hook.
  const needsGraphClassifier = hooks.some(h =>
    h === 'universal/pre-tool/deploy-gate.sh' || h === 'universal/pre-tool/block-sealed-refs.sh');
  if (needsGraphClassifier) {
    const companion = 'graph-command-classifier.mjs';
    const src = path.join(DEVOPS_ROOT, 'hooks/universal/pre-tool', companion);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      console.error(`required graph hook companion missing: ${companion}`);
      process.exit(1);
    }
    if (!flags.dryRun) copy(PROJECT_ROOT, src, path.join(PROJECT_ROOT, '.claude/hooks', companion));
  }
  // REQ-M30: the new-dependency hook also invokes a fixed sibling companion.
  if (hooks.includes('universal/pre-tool/block-new-dependency.sh')) {
    const companion = 'new-dependency-classifier.mjs';
    const src = path.join(DEVOPS_ROOT, 'hooks/universal/pre-tool', companion);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      console.error(`required hook companion missing: ${companion}`);
      process.exit(1);
    }
    if (!flags.dryRun) copy(PROJECT_ROOT, src, path.join(PROJECT_ROOT, '.claude/hooks', companion));
  }
  // #418: a hook wired through run-hook.mjs needs that runner beside it. Without it the
  // wired command would fail on every call, so a missing runner stops the install.
  if (hooks.some(h => fs.existsSync(path.join(DEVOPS_ROOT, 'hooks', h)) && runsThroughRunHook(path.basename(h)))) {
    const src = path.join(DEVOPS_ROOT, 'hooks/claude-code', RUN_HOOK_FILE);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      console.error(`required hook companion missing: ${RUN_HOOK_FILE}`);
      process.exit(1);
    }
    if (!flags.dryRun) copy(PROJECT_ROOT, src, path.join(PROJECT_ROOT, '.claude/hooks', RUN_HOOK_FILE), 0o755);
  }
  let hooksInstalled = 0;
  const copiedHooks: string[] = [];
  for (const h of hooks) {
    const src = path.join(DEVOPS_ROOT, 'hooks', h);
    if (!fs.existsSync(src)) continue;
    if (!flags.dryRun) {
      const dst = path.join(PROJECT_ROOT, '.claude/hooks', path.basename(h));
      copy(PROJECT_ROOT, src, dst, 0o755);
    }
    copiedHooks.push(path.basename(h));
    hooksInstalled++;
  }
  // #418: Claude Code runs a copied hook only once .claude/settings.json names it.
  wireClaudeHooks(PROJECT_ROOT, copiedHooks, flags.dryRun);
  let subagentsInstalled = 0;
  for (const a of subagents) {
    const src = path.join(DEVOPS_ROOT, `subagents/universal/${a}.md`);
    if (!fs.existsSync(src)) continue;
    if (!flags.dryRun) {
      const dst = path.join(PROJECT_ROOT, '.claude/agents', `${a}.md`);
      copy(PROJECT_ROOT, src, dst);
    }
    subagentsInstalled++;
  }

  if (!flags.dryRun) {
    for (const dir of ['.workflow/state', '.workflow/proofs', '.workflow/memory', '.workflow/client']) {
      record?.dir(dir);
      mkdirInside(PROJECT_ROOT, path.join(PROJECT_ROOT, dir));
    }
    const srcBudget = path.join(DEVOPS_ROOT, 'cost-controls/budget.yml');
    const dstBudget = path.join(PROJECT_ROOT, '.workflow/state/budget.yml');
    if (!present(dstBudget) && fs.existsSync(srcBudget)) {
      copy(PROJECT_ROOT, srcBudget, dstBudget);
    }
  }

  // specs/graph/agile-graph-link.md REQ-3: optional; without the engine this prints
  // one line and changes nothing, and nothing in it can fail the install.
  let agileGraphLines: string[];
  try {
    agileGraphLines = linkAgileGraph({
      projectRoot: PROJECT_ROOT, devopsRoot: DEVOPS_ROOT, dryRun: flags.dryRun, skip: flags.noAgileGraph, record,
    }).lines;
  } catch (error) {
    agileGraphLines = [`Agile Graph: not linked (${error instanceof Error ? error.message : String(error)}).`];
  }
  console.log('');
  for (const line of agileGraphLines) console.log(line);

  console.log('');
  if (flags.dryRun) {
    console.log(`dry-run: would copy ${t.installed} skills`);
  } else {
    console.log(summaryLine(t));
    console.log(backedUp.length
      ? `replaced=${backedUp.length} (skills, hooks and agents that differed from this release; the previous copies are in .workflow/state/backups/${runBackupStamp(PROJECT_ROOT)}/)`
      : 'replaced=0 (no installed skill, hook or agent differed from this release)');
    console.log('Installation complete.');
  }
  // specs/release/npm-package.md REQ-14 (#352, #420): every file named here is a URL pinned to
  // this release's tag, and the path exists in the repository. Init installs no slash
  // commands, so the command files are named where they ship, with the plugin that provides
  // them. A dry run prints the same text.
  console.log('Next steps:');
  console.log('  1. Adjust `.workflow/state/budget.yml` for the project budget');
  console.log(`  2. For client work, create \`.workflow/client/profile.yml\`; ${docUrl('docs/CLIENT_ONBOARDING.md')} lists its fields`);
  console.log(`  3. At session end, write the baton as ${docUrl('slash-commands/universal/checkpoint.md')} describes (with the DevOPs Claude Code plugin installed, its /checkpoint command does this)`);
  console.log(`  4. Commit AGENTS.md, CLAUDE.md, .claude/, .workflow/profile.yml and .workflow/state/budget.yml. Keep ${LOCAL_STATE_IGNORES.join(' and ')} local: init adds them to .gitignore.`);
  console.log('');
  console.log('First steps in the agent:');
  console.log(`  1. Read ${['PRINCIPLES.md', 'ANTIPATTERNS.md', 'LOOP.md'].map(file => docUrl(`constitution/${file}`)).join(', ')}`);
  console.log('  2. Create specs/ and write your first spec there');
  console.log(`  3. Convert prose to EARS as ${docUrl('slash-commands/universal/ears-spec.md')} describes (with the plugin installed, its /ears-spec command does this)`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof UnsafeWriteError)) throw error;
  console.error(`devops: ${error.message}`);
  process.exit(1);
}
