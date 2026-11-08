// specs/phase-2/D-stack-specific-skills.md REQ-D8 (issue #350): init installs
// every recommended skill or prints it as skipped with a reason, and counts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/phase-2/D-stack-specific-skills.md';
// These tests are about which skills init reports, not signatures, so they opt
// out of cosign and log why, as package-smoke.sh does.
const UNSIGNED = ['--allow-unsigned', '--rationale=stack skill report test without cosign'];
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

function recommendedSkills(profile) {
  const block = profile.split(/\n\s*skills:\s*\n/)[1].split(/\n\s*hooks:/)[0];
  return [...block.matchAll(/^\s*-\s*"([^"]+)"/gm)].map(m => m[1]);
}

// The Stripe fixture recommends both security/webhook-idempotency and
// stack-specific/stripe/webhook-idempotency, which share a basename, so a skill
// counts as installed only when its own SKILL.md is the file under .claude/skills.
function installedFrom(dir, skill) {
  const dst = path.join(dir, '.claude/skills', path.basename(skill), 'SKILL.md');
  const tree = skill.startsWith('stack-specific/') ? '' : 'universal';
  const src = path.join(ROOT, 'skills', tree, skill, 'SKILL.md');
  return existsSync(dst) && existsSync(src) && readFileSync(dst, 'utf8') === readFileSync(src, 'utf8');
}

// Analyzes a copy of the fixture, lets the caller edit profile.yml, runs init,
// and returns what init printed and which recommended skills it installed.
function initReport(fixture, editProfile = profile => profile) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'stack-skills-350-')));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer', fixture), dir, { recursive: true });
    const analyzed = devops(dir, 'analyze');
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const profilePath = path.join(dir, '.workflow/profile.yml');
    const profile = editProfile(readFileSync(profilePath, 'utf8'));
    writeFileSync(profilePath, profile);
    const skills = recommendedSkills(profile);
    const r = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(r.status, 0, r.stderr);
    const out = `${r.stdout}\n${r.stderr}`;
    return {
      skills,
      out,
      skippedLines: out.split('\n').filter(l => l.startsWith('⚠ skipped: ')),
      total: Number(out.match(/\bskipped=(\d+)/)?.[1]),
      installed: new Set(skills.filter(s => installedFrom(dir, s))),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertEveryReported({ skills, out, skippedLines, total, installed }) {
  for (const s of skills) {
    const reported = skippedLines.some(l => l.startsWith(`⚠ skipped: ${s} (`));
    assert.ok(installed.has(s) !== reported, `${s}: installed=${installed.has(s)} reported=${reported}`);
  }
  assert.equal(total, skippedLines.length, out);
}

for (const [fixture, stack] of [
  ['nextjs-project', 'nextjs'],
  ['stripe-project', 'stripe'],
  ['fastapi-project', 'fastapi'],
  ['supabase-project', 'supabase'],
  ['rust-project', 'rust'],
]) {
  test(`init installs or reports every recommended skill: ${fixture} (${SPEC}#req-d8)`, () => {
    const report = initReport(fixture);
    assert.ok(report.skills.some(s => s.startsWith(`stack-specific/${stack}/`)), report.skills.join(','));
    assertEveryReported(report);
  });
}

test(`a profile skill name with '..' is reported as skipped, never looked up (${SPEC}#req-d8)`, () => {
  const report = initReport('nextjs-project', profile =>
    profile.replace(/(\n(\s*)-\s*"process\/goal-loop")/, '$1\n$2- "../universal/process/goal-loop"'));
  assert.ok(report.skippedLines.includes('⚠ skipped: "../universal/process/goal-loop" (not a valid skill name)'), report.out);
  assert.equal(report.total, report.skippedLines.length, report.out);
});
