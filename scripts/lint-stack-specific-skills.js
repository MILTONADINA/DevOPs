#!/usr/bin/env node
// scripts/lint-stack-specific-skills.js
//
// Phase 2 area D CI lint gate (D.11). Walks skills/stack-specific/**/SKILL.md
// and asserts the structural set from specs/phase-2/D-stack-specific-skills.md
// against each file:
//
//   REQ-D2 (AC-D2.1): YAML frontmatter with non-empty name + description
//   REQ-D3 (AC-D3.1): >=3 distinct pattern / anti-pattern entries (H3 or numbered-bold)
//   REQ-D5 (AC-D5.1): Tradeoff: OR Why this matters: present
//   REQ-D6 (AC-D6.1): >=1 fenced code block with a language tag
//   REQ-D7 (AC-D7.1): either-or branch -- canonical ASI/AST identifier(s) match,
//                     OR explicit "No canonical ASI/AST applies" opt-out line
//
// Additional path-specific NFR-D4 compliance citation assertions:
//   stripe/pci-scope-minimization: PCI DSS + Requirement 3 + Requirement 10
//   supabase/rls-policies: GDPR Article 32 + SOC 2 CC6.1
//
// Tracked sibling of the gitignored .workflow/proofs/_checks/req-D-skill-content.js
// from session 4 (which serves claims 055-063's local proof path). This lint is
// the CI gate -- wired into .github/workflows/ci.yml via `npm run
// lint:stack-specific-skills`. Exit 0 PASS / non-zero FAIL with a named defect.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

const ROOT_DIR = path.resolve(process.cwd(), 'skills', 'stack-specific');

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name === 'SKILL.md') out.push(p);
  }
  return out;
}

const CANONICAL_IDS = new Set([
  'ASI01','ASI02','ASI03','ASI04','ASI05','ASI06','ASI07','ASI08','ASI09','ASI10',
  'AST01','AST02','AST03','AST04','AST05','AST06','AST07','AST08','AST09','AST10',
]);

function lintOne(file) {
  const failures = [];
  let text;
  try { text = readFileSync(file, 'utf-8'); }
  catch (e) { return ['cannot read: ' + e.message]; }

  // REQ-D2: frontmatter
  const fm = text.match(/^---\s*\n([\s\S]+?)\n---\s*\n/);
  if (!fm) {
    failures.push('REQ-D2: missing YAML frontmatter');
  } else {
    if (!/\bname:\s*\S/.test(fm[1])) failures.push('REQ-D2: frontmatter missing non-empty `name`');
    if (!/\bdescription:\s*\S/.test(fm[1])) failures.push('REQ-D2: frontmatter missing non-empty `description`');
  }

  // REQ-D3: >=3 patterns/anti-patterns (H3 sections OR numbered-bold list entries)
  const h3Count = (text.match(/^###\s+(Pattern|Anti-pattern|Rule)/gim) || []).length;
  const numberedBoldCount = (text.match(/^\d+\.\s+\*\*/gm) || []).length;
  if (h3Count + numberedBoldCount < 3) {
    failures.push('REQ-D3: only ' + (h3Count + numberedBoldCount) + ' pattern/anti-pattern entries (H3=' + h3Count + ' + numbered-bold=' + numberedBoldCount + '); need >=3');
  }

  // REQ-D5: Tradeoff or Why-this-matters
  const hasTradeoff = /\*\*Tradeoff:\*\*|^Tradeoff:|^##\s+Tradeoff|^##\s+Why this matters|Why this matters[\s\S]{0,4}\n/im.test(text);
  if (!hasTradeoff) {
    failures.push('REQ-D5: neither "Tradeoff:" nor "Why this matters:" appears in the body');
  }

  // REQ-D6: >=1 fenced code block with a language tag
  if ((text.match(/^```[a-zA-Z]+/gm) || []).length < 1) {
    failures.push('REQ-D6: no fenced code block with a language tag');
  }

  // REQ-D7: either-or branch
  const asiMatches = text.match(/\bASI\d{2}\b|\bAST\d{2}\b/g) || [];
  const optOutLine = /No canonical ASI\/AST applies\s*[-—]/.test(text);
  if (asiMatches.length === 0) {
    if (!optOutLine) {
      failures.push('REQ-D7: no ASI/AST identifier AND no "No canonical ASI/AST applies -- <reason>" opt-out line');
    }
  } else {
    const nonCanonical = asiMatches.filter(id => !CANONICAL_IDS.has(id));
    if (nonCanonical.length > 0) {
      failures.push('REQ-D7: non-canonical ASI/AST identifiers: ' + [...new Set(nonCanonical)].join(', '));
    }
  }

  // NFR-D4 path-specific compliance citations
  const rel = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  if (/^stripe\/pci-scope-minimization\//.test(rel)) {
    if (!/PCI DSS/i.test(text)) failures.push('NFR-D4: missing "PCI DSS" reference (stripe/pci-scope-minimization)');
    if (!/Requirement 3\b/.test(text)) failures.push('NFR-D4: missing PCI DSS "Requirement 3" reference');
    if (!/Requirement 10\b/.test(text)) failures.push('NFR-D4: missing PCI DSS "Requirement 10" reference');
  }
  if (/^supabase\/rls-policies\//.test(rel)) {
    if (!/GDPR Article 32\b/i.test(text) && !/GDPR Art\.?\s*32\b/i.test(text)) {
      failures.push('NFR-D4: missing "GDPR Article 32" reference (supabase/rls-policies)');
    }
    if (!/CC6\.1\b/.test(text)) {
      failures.push('NFR-D4: missing "SOC 2 CC6.1" reference (supabase/rls-policies)');
    }
  }

  return failures;
}

function main() {
  const files = walk(ROOT_DIR);
  if (files.length === 0) {
    console.error('FAIL: no SKILL.md files found under ' + ROOT_DIR);
    process.exit(1);
  }

  let totalFailures = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    const fails = lintOne(file);
    if (fails.length === 0) {
      console.log('PASS: ' + rel);
    } else {
      console.error('FAIL: ' + rel);
      for (const f of fails) console.error('       - ' + f);
      totalFailures += fails.length;
    }
  }
  console.log('');
  if (totalFailures > 0) {
    console.error('Stack-specific skills lint: ' + totalFailures + ' check(s) failed across ' + files.length + ' file(s)');
    process.exit(1);
  }
  console.log('Stack-specific skills lint: ' + files.length + ' / ' + files.length + ' files PASS');
}

main();
