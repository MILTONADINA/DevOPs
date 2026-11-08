// specs/phase-2/F-skill-provenance.md REQ-F8 and REQ-F9: the installer accepts a skill's
// signature only from the DevOPs release-sign workflow, and refuses the skill whenever
// that signature cannot be verified. The manifest hash ships in the same package as the
// skill, so it cannot stand in for the signature. Each case runs analyzer/install.ts
// against a toy package whose cosign is a stub script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/phase-2/F-skill-provenance.md';
const SKILL = 'skills/universal/process/toy-skill/SKILL.md';
const RELEASE_SIGNER = 'https://github.com/MILTONADINA/DevOPs/.github/workflows/release-sign.yml@refs/heads/release/toy';
const ANCHORED = '^https://github\\.com/MILTONADINA/DevOPs/\\.github/workflows/release-sign\\.yml@refs/heads/.+$';

// A toy DevOPs package with one signed skill, a target project that asks for it, and a
// cosign stub. `cosign` is the stub's shell body (null leaves no cosign at all). `format` is
// the bundle the skill carries: the legacy cosign bundle, or a new-format Sigstore bundle
// (#345). `sig` adds the legacy .sig; `trustRoot` writes the committed trust root.
const NEW_BUNDLE = `${JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', verificationMaterial: {}, messageSignature: {} })}\n`;
const TRUST_ROOT = '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1"}\n';
function install({ cosign = 'exit 0', bundle = true, signedBy = RELEASE_SIGNER, extra = [], format = 'legacy', sig = true, trustRoot = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-signature-'));
  try {
    const devopsRoot = path.join(dir, 'devops');
    const projectRoot = path.join(dir, 'project');
    const skillPath = path.join(devopsRoot, SKILL);
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '# Toy skill\n\nA synthetic skill for the installer tests.\n');
    if (sig) writeFileSync(`${skillPath}.sig`, 'toy-signature\n');
    if (bundle) writeFileSync(`${skillPath}.bundle`, format === 'new' ? NEW_BUNDLE : '{"toy":"bundle"}\n');
    const trustRootPath = path.join(devopsRoot, '.workflow/sigstore/trust-bundle.json');
    if (trustRoot) {
      mkdirSync(path.dirname(trustRootPath), { recursive: true });
      writeFileSync(trustRootPath, TRUST_ROOT);
    }
    const sha256 = createHash('sha256').update(readFileSync(skillPath)).digest('hex');
    const manifest = path.join(devopsRoot, 'manifest.yml');
    writeFileSync(manifest, `skills:\n- name: toy-skill\n  path: ${SKILL}\n  sha256: ${sha256}\n  signed_by: ${signedBy}\n`);
    mkdirSync(path.join(projectRoot, '.workflow'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.workflow/profile.yml'), 'skills:\n  - process/toy-skill\nhooks:\nsubagents:\n');
    const argsFile = path.join(dir, 'cosign-args.txt');
    const cosignBin = path.join(dir, 'cosign');
    if (cosign !== null) {
      writeFileSync(cosignBin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n${cosign}\n`);
      chmodSync(cosignBin, 0o755);
    }
    const run = spawnSync(process.execPath, [
      path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/install.ts'),
      '--target', projectRoot, '--manifest', manifest, '--no-agile-graph', ...extra,
    ], {
      cwd: projectRoot,
      env: { ...process.env, DEVOPS_ROOT: devopsRoot, COSIGN_BIN: cosignBin },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const log = path.join(projectRoot, '.workflow/state/install.log');
    return {
      trustRootPath,
      status: run.status,
      output: `${run.stdout}\n${run.stderr}`,
      copied: existsSync(path.join(projectRoot, '.claude/skills/toy-skill/SKILL.md')),
      cosignArgs: existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n') : null,
      decisions: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).decision) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(`a skill cosign verifies is copied, checked against the anchored release-sign identity (${SPEC}#req-f8)`, () => {
  const result = install();
  assert.equal(result.status, 0, result.output);
  assert.ok(result.copied, 'the verified skill is copied');
  const at = result.cosignArgs.indexOf('--certificate-identity-regexp');
  assert.equal(result.cosignArgs[at + 1], ANCHORED);
  assert.equal(result.cosignArgs[result.cosignArgs.indexOf('--certificate-oidc-issuer') + 1], 'https://token.actions.githubusercontent.com');
  assert.deepEqual(result.decisions, ['pass']);
});

test(`without cosign a skill is not verified: exit 2, nothing written, nothing logged (${SPEC}#req-f12)`, () => {
  const result = install({ cosign: null });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.match(result.output, /not verified \(cosign missing\)=1/);
  assert.deepEqual(result.decisions, [], 'no install.log decision is written before the refusal');
});

test(`a skill is refused with exit 2 when cosign is killed before it answers (${SPEC}#req-f9)`, () => {
  // The same outcome as a stall past the timeout: spawnSync reports no exit status.
  const result = install({ cosign: 'kill -9 $$' });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.deepEqual(result.decisions, ['fail']);
});

test(`a skill with a .sig but no .bundle is refused with exit 2 (${SPEC}#req-f9)`, () => {
  const result = install({ bundle: false });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.equal(result.cosignArgs, null, 'cosign is not asked to verify without a bundle');
});

test(`a skill whose manifest names another workflow as signer is refused with exit 2 (${SPEC}#req-f8)`, () => {
  const result = install({ signedBy: 'https://github.com/someone-else/fork/.github/workflows/release-sign.yml@refs/heads/main' });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.match(result.output, /not the DevOPs release-sign workflow/);
});

test(`a skill cosign rejects is refused with exit 2 (${SPEC}#req-f2)`, () => {
  const result = install({ cosign: "echo 'none of the expected identities matched' >&2; exit 1" });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
});

test(`--allow-unsigned with a rationale installs an unverifiable skill and logs it as overridden (${SPEC}#req-f9)`, () => {
  const result = install({ cosign: null, extra: ['--allow-unsigned', '--rationale=toy machine without cosign'] });
  assert.equal(result.status, 0, result.output);
  assert.ok(result.copied);
  assert.deepEqual(result.decisions, ['overridden']);
});

test(`a new-format bundle is verified offline against the committed trust root, with no .sig (${SPEC}#req-f8, #345)`, () => {
  const result = install({ format: 'new', sig: false, trustRoot: true });
  assert.equal(result.status, 0, result.output);
  assert.ok(result.copied, 'the verified skill is copied');
  const args = result.cosignArgs;
  assert.equal(args[args.indexOf('--trusted-root') + 1], result.trustRootPath);
  assert.ok(args.includes('--new-bundle-format'), 'cosign is told the bundle is new-format');
  assert.equal(args[args.indexOf('--certificate-identity-regexp') + 1], ANCHORED);
  assert.deepEqual(result.decisions, ['pass']);
});

test(`a new-format bundle is refused with exit 2 when the committed trust root is missing (${SPEC}#req-f9)`, () => {
  const result = install({ format: 'new', sig: false, trustRoot: false });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.match(result.output, /trust root missing/);
  assert.equal(result.cosignArgs, null, 'cosign is not asked to verify without a trust root');
});

test(`a new-format bundle that cosign rejects is refused with exit 2 and not retried as legacy (${SPEC}#req-f2)`, () => {
  const result = install({ format: 'new', sig: false, trustRoot: true, cosign: "echo 'bundle does not verify' >&2; exit 1" });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.deepEqual(result.decisions, ['fail']);
});

test(`a new-format bundle whose manifest names another workflow is refused before cosign runs (${SPEC}#req-f8)`, () => {
  const result = install({ format: 'new', sig: false, trustRoot: true, signedBy: 'https://github.com/someone-else/fork/.github/workflows/release-sign.yml@refs/heads/main' });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.match(result.output, /not the DevOPs release-sign workflow/);
  assert.equal(result.cosignArgs, null);
});

test(`a legacy .sig + .bundle pair still verifies the old way during the transition (${SPEC}#req-f2)`, () => {
  const result = install({ format: 'legacy', sig: true, trustRoot: true });
  assert.equal(result.status, 0, result.output);
  assert.ok(result.copied);
  assert.equal(result.cosignArgs.includes('--trusted-root'), false, 'legacy bundles are not checked against the trust root');
  assert.equal(result.cosignArgs.includes('--new-bundle-format'), false);
  assert.deepEqual(result.decisions, ['pass']);
});

test(`a skill with neither .sig nor bundle is refused with exit 2 (${SPEC}#req-f2)`, () => {
  const result = install({ sig: false, bundle: false, trustRoot: true });
  assert.equal(result.status, 2, result.output);
  assert.equal(result.copied, false);
  assert.match(result.output, /unsigned \(no \.sig present\)/);
  assert.equal(result.cosignArgs, null);
});
