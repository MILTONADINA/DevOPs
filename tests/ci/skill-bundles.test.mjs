// specs/phase-2/E-sigstore-signing.md AC-E1.1 (issue #347): every SKILL.md under skills/ has one
// Sigstore bundle beside it. The skills still without one are listed in unsigned-skills.txt,
// which must shrink to empty as release-sign.yml signs them. The workflow checks below pin the
// signing commands that produce the bundles (#345).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SKILLS = path.join(ROOT, 'skills');
const ALLOWLIST = path.join(import.meta.dirname, 'unsigned-skills.txt');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/release-sign.yml'), 'utf8');

// Every SKILL.md under skills/ (read from disk: tests do not run git, tests/hermeticity.test.mjs).
function skillFiles(dir = SKILLS) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(full);
    return entry.name === 'SKILL.md' ? [path.relative(ROOT, full).split(path.sep).join('/')] : [];
  }).sort();
}

const allowlist = readFileSync(ALLOWLIST, 'utf8').split('\n').map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const hasBundle = (skill) => existsSync(path.join(ROOT, `${skill}.bundle`));
const skills = skillFiles();

test('AC-E1.1: every SKILL.md has a bundle, or is listed as unsigned', () => {
  assert.ok(skills.length > 0, 'the skills tree has SKILL.md files');
  const unlisted = skills.filter((skill) => !hasBundle(skill) && !allowlist.includes(skill));
  assert.deepEqual(unlisted, [], 'SKILL.md files without a SKILL.md.bundle and not in tests/ci/unsigned-skills.txt');
});

test('AC-E1.1: the unsigned list names only skills that exist and still lack a bundle', () => {
  const stale = allowlist.filter((skill) => !skills.includes(skill) || hasBundle(skill));
  assert.deepEqual(stale, [], 'entries to delete from tests/ci/unsigned-skills.txt (signed, or no such skill)');
  assert.equal(new Set(allowlist).size, allowlist.length, 'no duplicate entries');
});

test('AC-E1.1: release-sign.yml signs every SKILL.md as one new-format bundle', () => {
  assert.match(WORKFLOW, /find skills -name 'SKILL\.md'/, 'the signing loop covers all of skills/');
  assert.match(WORKFLOW, /cosign sign-blob --yes "\$\{skill\}" \\\n\s+--new-bundle-format \\\n\s+--bundle "\$\{bundle\}"/, 'sign-blob writes the new-format bundle');
  assert.doesNotMatch(WORKFLOW, /--output-signature/, 'no legacy .sig output');
  assert.match(WORKFLOW, /COSIGN_VERSION: 'v2\.4\.3'/, 'the cosign pin is unchanged');
});

test('AC-E1.1: release-sign.yml verifies new-format bundles against the committed trust root (#345)', () => {
  assert.match(WORKFLOW, /'--new-bundle-format', '--trusted-root', str\(trust_root\)/);
  assert.match(WORKFLOW, /Path\('\.workflow\/sigstore\/trust-bundle\.json'\)/);
});
