// specs/phase-2/F-skill-provenance.md REQ-F12 (issue #415): without cosign, `devops init`
// writes nothing to the project (no manifest either), prints what to install, and exits 2.
// Each case runs analyzer/install.ts in a toy project whose PATH holds no cosign. The tree is
// compared by content hash before and after, so a created, edited or removed file fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/phase-2/F-skill-provenance.md';
const SKILL = 'skills/universal/process/toy-skill/SKILL.md';
const RELEASE_SIGNER = 'https://github.com/MILTONADINA/DevOPs/.github/workflows/release-sign.yml@refs/heads/main';

// A toy DevOPs package with one signed skill, AGENTS.md and the CLAUDE.md template, and a
// project whose profile asks for the skill. PATH is an empty directory, so no cosign is found.
function withToy(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-no-cosign-')));
  try {
    const devopsRoot = path.join(dir, 'devops');
    const projectRoot = path.join(dir, 'project');
    const skillPath = path.join(devopsRoot, SKILL);
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '# Toy skill\n\nA synthetic skill for the installer tests.\n');
    writeFileSync(`${skillPath}.sig`, 'toy-signature\n');
    writeFileSync(`${skillPath}.bundle`, '{"toy":"bundle"}\n');
    const sha256 = createHash('sha256').update(readFileSync(skillPath)).digest('hex');
    const manifest = path.join(devopsRoot, 'manifest.yml');
    writeFileSync(manifest, `skills:\n- name: toy-skill\n  path: ${SKILL}\n  sha256: ${sha256}\n  signed_by: ${RELEASE_SIGNER}\n`);
    writeFileSync(path.join(devopsRoot, 'AGENTS.md'), '# Toy agents contract\n');
    mkdirSync(path.join(devopsRoot, 'templates/claude-md'), { recursive: true });
    writeFileSync(path.join(devopsRoot, 'templates/claude-md/CLAUDE_TEMPLATE.md'), '# Toy adapter\n');
    mkdirSync(path.join(projectRoot, '.workflow'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.workflow/profile.yml'), 'skills:\n  - process/toy-skill\nhooks:\nsubagents:\n');
    const emptyBin = path.join(dir, 'empty-bin');
    mkdirSync(emptyBin);
    fn({ devopsRoot, projectRoot, manifest, emptyBin });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every path under the project, each with its content hash (a folder is marked with a slash).
function snapshot(root) {
  return readdirSync(root, { recursive: true }).sort().map(rel => {
    const abs = path.join(root, rel);
    return statSync(abs).isDirectory()
      ? `${rel}/`
      : `${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
  });
}

function runInit({ devopsRoot, projectRoot, manifest, emptyBin }, extra = []) {
  const env = { ...process.env, PATH: emptyBin, DEVOPS_ROOT: devopsRoot };
  delete env.COSIGN_BIN;
  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/install.ts'),
    '--target', projectRoot, '--manifest', manifest, '--no-agile-graph', ...extra,
  ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

test(`init without cosign writes nothing, not even a manifest, and exits 2 (${SPEC}#req-f12)`, () => {
  withToy(toy => {
    const before = snapshot(toy.projectRoot);
    const run = runInit(toy);
    assert.equal(run.status, 2, run.output);
    assert.deepEqual(snapshot(toy.projectRoot), before, 'no file or folder was created or changed');
    assert.doesNotMatch(run.output, /Installed AGENTS\.md/);
  });
});

test(`init without cosign prints what to install and counts the skill as not verified (${SPEC}#req-f12)`, () => {
  withToy(toy => {
    const run = runInit(toy);
    assert.match(run.output, /installed=0 verified=0 overridden=0 skipped=0 failed=0 not verified \(cosign missing\)=1/, run.output);
    assert.match(run.output, /Install cosign \(https:\/\/docs\.sigstore\.dev\/cosign\/system_config\/installation\/\)/);
    assert.match(run.output, /--allow-unsigned --rationale=/);
    assert.doesNotMatch(run.output, /failed=[1-9]/);
  });
});

test(`init --dry-run without cosign reports what it would write and still writes nothing (${SPEC}#req-f12)`, () => {
  withToy(toy => {
    const before = snapshot(toy.projectRoot);
    const run = runInit(toy, ['--dry-run']);
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /would install: AGENTS\.md/);
    assert.match(run.output, /would install: CLAUDE\.md/);
    assert.match(run.output, /not verified \(cosign missing\)=1/);
    assert.deepEqual(snapshot(toy.projectRoot), before);
  });
});
