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
import { ADOPTED_NOTICE, openManifest } from './install-manifest.js';
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
}

// docs/SKILL_SIGNING.md "Signing identity": only release-sign.yml in MILTONADINA/DevOPs,
// dispatched on a branch, signs skills. Any other GitHub workflow's certificate is refused.
const SIGNER_IDENTITY_REGEXP = '^https://github\\.com/MILTONADINA/DevOPs/\\.github/workflows/release-sign\\.yml@refs/heads/.+$';
const SIGNER_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const COSIGN_TIMEOUT_MS = 5000;

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
  const unverified = (why: string): VerifyResult => allowUnsigned
    ? { ok: true, reason: `${why}; override`, sha256: actualHash, signedBy: entry.signed_by }
    : { ok: false, reason: why, sha256: actualHash };

  const sigPath = entry.sig_path ? path.join(DEVOPS_ROOT, entry.sig_path) : `${skillFullPath}.sig`;
  const bundlePath = entry.bundle_path ? path.join(DEVOPS_ROOT, entry.bundle_path) : `${skillFullPath}.bundle`;

  if (!fs.existsSync(sigPath)) return unverified('unsigned (no .sig present)');
  if (entry.signed_by && !new RegExp(SIGNER_IDENTITY_REGEXP).test(entry.signed_by)) {
    return unverified(`manifest signer is not the DevOPs release-sign workflow: ${entry.signed_by.slice(0, 120)}`);
  }
  if (!fs.existsSync(bundlePath)) return unverified('unverified (.sig present but no .bundle)');

  // Per NFR-F1: ≤ 200 ms per skill. Local-only call; no network dep beyond
  // cosign's Sigstore trust-root cache.
  const cosign = process.env['COSIGN_BIN'] ?? 'cosign';
  const result = spawnSync(cosign, [
    'verify-blob',
    '--bundle', bundlePath,
    '--certificate-identity-regexp', SIGNER_IDENTITY_REGEXP,
    '--certificate-oidc-issuer', SIGNER_OIDC_ISSUER,
    skillFullPath,
  ], { encoding: 'utf-8', timeout: COSIGN_TIMEOUT_MS });

  if (result.error || result.status === null) {
    // cosign is missing, could not start, timed out or was killed: nothing was verified.
    const why = result.error ? (result.error as NodeJS.ErrnoException).code ?? result.error.message : `signal ${result.signal}`;
    return unverified(`unverified (cosign did not complete: ${why})`);
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

// ─── main ────────────────────────────────────────────────────────────────

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const PROJECT_ROOT = flags.target;
  if (!flags.dryRun) startRecord(PROJECT_ROOT);
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
  const packageFiles: string[] = JSON.parse(fs.readFileSync(path.join(DEVOPS_ROOT, 'package.json'), 'utf-8')).files ?? [];
  const shipped = (p: string) => {
    const hit = (entry: string) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry);
    return packageFiles.some(e => !e.startsWith('!') && hit(e)) && !packageFiles.some(e => e.startsWith('!') && hit(e.slice(1)));
  };
  // A package path such as `docs/MEMORY.md`, or a pattern such as
  // `lifecycle/<phase>/PHASE.md` whose fixed part ships. Project paths (`.workflow/`),
  // slash commands and bare names are not package paths.
  const shipsInPackage = (token: string) => {
    if (token.startsWith('.') || token.startsWith('/') || !token.includes('/')) return false;
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
  const gitignore = path.join(PROJECT_ROOT, '.gitignore');
  const ignored = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf-8') : '';
  if (!ignored.split(/\r?\n/).includes('AGENTS.override.md')) {
    if (flags.dryRun) {
      console.log('dry-run: would add AGENTS.override.md to .gitignore');
    } else {
      const eol = ignored.match(/\r?\n/)?.[0] ?? '\n';
      recorded(PROJECT_ROOT, gitignore, () => writeInside(PROJECT_ROOT, gitignore, `${ignored && !ignored.endsWith('\n') ? eol : ''}AGENTS.override.md${eol}`, { append: true }));
      console.log('✓ Added AGENTS.override.md to .gitignore');
    }
  }

  // Skills with verification (F.01..F.07)
  let verified = 0, overridden = 0, skipped = 0, failed = 0;
  for (const s of skills) {
    // specs/phase-2/D-stack-specific-skills.md REQ-D8: every recommended skill
    // is installed or printed as skipped with a reason, and counted.
    // Names come from the project's profile.yml: only lowercase path segments,
    // never '..', so a lookup stays under skills/.
    if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/.test(s)) {
      console.log(`⚠ skipped: ${JSON.stringify(s)} (not a valid skill name)`);
      skipped++;
      continue;
    }
    const stackSpecific = s.startsWith('stack-specific/');
    const srcSkillDir = path.join(DEVOPS_ROOT, 'skills', stackSpecific ? '' : 'universal', s);
    const skillMdPath = path.join(srcSkillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      console.log(`⚠ skipped: ${s} (this DevOPs release has no SKILL.md for it)`);
      skipped++;
      continue;
    }

    // Look up by manifest path; fall back to name for universal skills only,
    // so a stack-specific skill never borrows another skill's entry.
    const relPath = path.relative(DEVOPS_ROOT, skillMdPath).replace(/\\/g, '/');
    const entry = manifestByPath.get(relPath) ?? (stackSpecific ? null : manifestByName.get(path.basename(s))) ?? null;

    if (!entry && stackSpecific) {
      // Not yet signed into governance/skill-manifest.yml (#347): not installed.
      console.log(`⚠ skipped: ${s} (not in governance/skill-manifest.yml, so it cannot be verified)`);
      skipped++;
      continue;
    }
    if (!entry) {
      // REQ-F2 covers no-sig; here the skill is not in the manifest at all.
      // Defense-in-depth: no manifest entry → cannot verify hash → reject.
      console.error(`unsigned: ${relPath} (not in manifest)`);
      logDecision(PROJECT_ROOT, 'fail', relPath, '', undefined, null, flags.dryRun);
      failed++;
      continue;
    }

    const verdict = verifySkill(skillMdPath, entry, flags.allowUnsigned);
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
    const dst = path.join(PROJECT_ROOT, '.claude/skills', path.basename(s));
    copyDir(PROJECT_ROOT, srcSkillDir, dst);
  }

  // F.03: if any skill failed and no override, exit 2.
  if (failed > 0 && !flags.allowUnsigned) {
    console.error('');
    console.error(`installed=${verified + overridden} verified=${verified} overridden=${overridden} skipped=${skipped} failed=${failed}`);
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
  let hooksInstalled = 0;
  for (const h of hooks) {
    const src = path.join(DEVOPS_ROOT, 'hooks', h);
    if (!fs.existsSync(src)) continue;
    if (!flags.dryRun) {
      const dst = path.join(PROJECT_ROOT, '.claude/hooks', path.basename(h));
      copy(PROJECT_ROOT, src, dst, 0o755);
    }
    hooksInstalled++;
  }
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
      projectRoot: PROJECT_ROOT, devopsRoot: DEVOPS_ROOT, dryRun: flags.dryRun, skip: flags.noAgileGraph,
    }).lines;
  } catch (error) {
    agileGraphLines = [`Agile Graph: not linked (${error instanceof Error ? error.message : String(error)}).`];
  }
  console.log('');
  for (const line of agileGraphLines) console.log(line);

  console.log('');
  if (flags.dryRun) {
    console.log(`dry-run: would copy ${verified + overridden} skills`);
  } else {
    console.log(`installed=${verified + overridden} verified=${verified} overridden=${overridden} skipped=${skipped} failed=${failed}`);
    console.log(backedUp.length
      ? `replaced=${backedUp.length} (skills, hooks and agents that differed from this release; the previous copies are in .workflow/state/backups/${runBackupStamp(PROJECT_ROOT)}/)`
      : 'replaced=0 (no installed skill, hook or agent differed from this release)');
    console.log('Installation complete.');
    // specs/release/npm-package.md REQ-14 (#352): every file named here exists in
    // the project or in this package; init installs no slash commands, so the
    // command files are named where they ship.
    console.log('Next steps:');
    console.log('  1. Adjust `.workflow/state/budget.yml` for the project budget');
    console.log(`  2. For client work, create \`.workflow/client/profile.yml\`; ${packageRef('docs/CLIENT_ONBOARDING.md')} lists its fields`);
    console.log(`  3. At session end, write the baton as ${packageRef('slash-commands/universal/checkpoint.md')} describes (with the DevOPs Claude Code plugin installed, its /checkpoint command does this)`);
    console.log('');
    console.log('First steps in the agent:');
    console.log(`  1. Read ${[...constitutionRefs.values()].join(', ')}`);
    console.log('  2. Create specs/ and write your first spec there');
    console.log(`  3. Convert prose to EARS as ${packageRef('slash-commands/universal/ears-spec.md')} describes (with the plugin installed, its /ears-spec command does this)`);
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof UnsafeWriteError)) throw error;
  console.error(`devops: ${error.message}`);
  process.exit(1);
}
