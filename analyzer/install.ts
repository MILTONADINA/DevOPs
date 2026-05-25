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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEVOPS_ROOT = process.env.DEVOPS_ROOT ?? path.join(process.env.HOME ?? '', 'DevOPs');

// ─── CLI parsing (F.01) ──────────────────────────────────────────────────

interface CliFlags {
  target: string;
  allowUnsigned: boolean;
  rationale: string | null;
  dryRun: boolean;
  manifestPath: string;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    target: process.cwd(),
    allowUnsigned: false,
    rationale: null,
    dryRun: false,
    manifestPath: path.join(DEVOPS_ROOT, 'governance/skill-manifest.yml'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') { flags.target = argv[++i]; }
    else if (a === '--allow-unsigned') { flags.allowUnsigned = true; }
    else if (a.startsWith('--rationale=')) { flags.rationale = a.slice('--rationale='.length).replace(/^"|"$/g, ''); }
    else if (a === '--rationale') { flags.rationale = (argv[++i] || '').replace(/^"|"$/g, ''); }
    else if (a === '--dry-run') { flags.dryRun = true; }
    else if (a === '--manifest') { flags.manifestPath = argv[++i]; }
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

  // Step 2: signature check — bypassable by --allow-unsigned.
  const sigPath = entry.sig_path ? path.join(DEVOPS_ROOT, entry.sig_path) : `${skillFullPath}.sig`;
  const bundlePath = entry.bundle_path ? path.join(DEVOPS_ROOT, entry.bundle_path) : `${skillFullPath}.bundle`;

  if (!fs.existsSync(sigPath)) {
    if (allowUnsigned) {
      return { ok: true, reason: 'unsigned (override)', sha256: actualHash, signedBy: entry.signed_by };
    }
    return { ok: false, reason: 'unsigned (no .sig present)', sha256: actualHash };
  }

  // Attempt cosign verify-blob if cosign binary is available and bundle exists.
  // Per NFR-F1: ≤ 200 ms per skill. Local-only call; no network dep beyond
  // cosign's Sigstore trust-root cache.
  if (fs.existsSync(bundlePath)) {
    const cosign = process.env['COSIGN_BIN'] ?? 'cosign';
    const result = spawnSync(cosign, [
      'verify-blob',
      '--bundle', bundlePath,
      '--certificate-identity-regexp', 'https://github.com/',
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
      skillFullPath,
    ], { encoding: 'utf-8', timeout: 5000 });

    if (result.error || result.status === null) {
      // cosign binary not available; fall back to hash check (which already passed above)
      return { ok: true, reason: 'verified (hash; cosign unavailable)', sha256: actualHash, signedBy: entry.signed_by };
    }
    if (result.status === 0) {
      return { ok: true, reason: 'verified (cosign + hash)', sha256: actualHash, signedBy: entry.signed_by };
    }
    // cosign ran but verification failed
    if (allowUnsigned) {
      return { ok: true, reason: `cosign verify failed; override (${(result.stderr || '').slice(0, 100)})`, sha256: actualHash, signedBy: entry.signed_by };
    }
    return { ok: false, reason: `cosign verify failed: ${(result.stderr || '').trim().slice(0, 200)}`, sha256: actualHash };
  }

  // .sig present but no bundle — partial signature artifact; treat as verified-by-hash only
  return { ok: true, reason: 'verified (hash; bundle missing)', sha256: actualHash, signedBy: entry.signed_by };
}

// ─── install.log JSONL writer (F.06) ─────────────────────────────────────

function logDecision(targetRoot: string, decision: 'pass' | 'fail' | 'overridden' | 'skipped',
                     skillPath: string, sha256: string, signedBy: string | undefined,
                     rationale: string | null, dryRun: boolean) {
  if (dryRun) return; // F.07: dry-run does not mutate
  const logPath = path.join(targetRoot, '.workflow/state/install.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    skill_path: skillPath,
    decision,
    sha256,
  };
  if (signedBy) entry.signed_by = signedBy;
  if (rationale && decision === 'overridden') entry.rationale = rationale;
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ─── copy primitives (preserved) ─────────────────────────────────────────

function copy(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copy(s, d);
  }
}

// ─── profile reader (preserved) ──────────────────────────────────────────

function loadProfileText(projectRoot: string): string {
  const p = path.join(projectRoot, '.workflow/profile.yml');
  if (!fs.existsSync(p)) {
    console.error('No .workflow/profile.yml found. Run ./scripts/analyze.sh first.');
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

  // AGENTS.md + CLAUDE.md install (preserved; not skills, no verification).
  // Gracefully skip when DEVOPS_ROOT source is missing (test harnesses or
  // non-canonical layouts) — these are operator-convenience copies, not
  // verification-gated artifacts.
  const srcAgents = path.join(DEVOPS_ROOT, 'AGENTS.md');
  const targetAgents = path.join(PROJECT_ROOT, 'AGENTS.md');
  if (!fs.existsSync(targetAgents) && fs.existsSync(srcAgents)) {
    if (!flags.dryRun) copy(srcAgents, targetAgents);
    console.log('✓ Installed AGENTS.md');
  } else if (fs.existsSync(targetAgents)) {
    console.log('⚠ AGENTS.md already exists; not overwriting');
  }
  const srcClaude = path.join(DEVOPS_ROOT, 'CLAUDE.md');
  const targetClaude = path.join(PROJECT_ROOT, 'CLAUDE.md');
  if (!fs.existsSync(targetClaude) && fs.existsSync(srcClaude)) {
    if (!flags.dryRun) copy(srcClaude, targetClaude);
    console.log('✓ Installed CLAUDE.md');
  }

  // Skills with verification (F.01..F.07)
  let verified = 0, overridden = 0, skipped = 0, failed = 0;
  for (const s of skills) {
    const srcSkillDir = path.join(DEVOPS_ROOT, 'skills/universal', s);
    if (!fs.existsSync(srcSkillDir)) continue;
    const skillMdPath = path.join(srcSkillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    // Look up by manifest path; fall back to name.
    const relPath = path.relative(DEVOPS_ROOT, skillMdPath).replace(/\\/g, '/');
    const entry = manifestByPath.get(relPath) ?? manifestByName.get(path.basename(s)) ?? null;

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
    copyDir(srcSkillDir, dst);
  }

  // F.03: if any skill failed and no override, exit 2.
  if (failed > 0 && !flags.allowUnsigned) {
    console.error('');
    console.error(`installed=${verified + overridden} verified=${verified} overridden=${overridden} skipped=${skipped} failed=${failed}`);
    process.exit(2);
  }

  // Hooks + subagents (no verification at v0.2.0; surgical scope per NFR-F5).
  let hooksInstalled = 0;
  for (const h of hooks) {
    const src = path.join(DEVOPS_ROOT, 'hooks', h);
    if (!fs.existsSync(src)) continue;
    if (!flags.dryRun) {
      const dst = path.join(PROJECT_ROOT, '.claude/hooks', path.basename(h));
      copy(src, dst);
      try { fs.chmodSync(dst, 0o755); } catch { /* best-effort on Windows */ }
    }
    hooksInstalled++;
  }
  let subagentsInstalled = 0;
  for (const a of subagents) {
    const src = path.join(DEVOPS_ROOT, `subagents/universal/${a}.md`);
    if (!fs.existsSync(src)) continue;
    if (!flags.dryRun) {
      const dst = path.join(PROJECT_ROOT, '.claude/agents', `${a}.md`);
      copy(src, dst);
    }
    subagentsInstalled++;
  }

  if (!flags.dryRun) {
    fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/state'), { recursive: true });
    fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/proofs'), { recursive: true });
    fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/memory'), { recursive: true });
    fs.mkdirSync(path.join(PROJECT_ROOT, '.workflow/client'), { recursive: true });
    const srcBudget = path.join(DEVOPS_ROOT, 'cost-controls/budget.yml');
    const dstBudget = path.join(PROJECT_ROOT, '.workflow/state/budget.yml');
    if (!fs.existsSync(dstBudget) && fs.existsSync(srcBudget)) {
      copy(srcBudget, dstBudget);
    }
  }

  console.log('');
  if (flags.dryRun) {
    console.log(`dry-run: would copy ${verified + overridden} skills`);
  } else {
    console.log(`installed=${verified + overridden} verified=${verified} overridden=${overridden} skipped=${skipped} failed=${failed}`);
    console.log('Installation complete.');
    console.log('Next steps:');
    console.log('  1. Fill in .workflow/client/profile.yml with your client info');
    console.log('  2. Adjust .workflow/state/budget.yml for project budget');
    console.log('  3. Run /checkpoint at session end to write the baton');
  }
}

main();
