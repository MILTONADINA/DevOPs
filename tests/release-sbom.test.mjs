import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// .github/workflows/release-npm.yml generates the SBOM with exactly this command.
const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const skip = existsSync(join(ROOT, 'node_modules')) ? false : 'run npm ci first: npm sbom reads node_modules';

test('npm sbom prints a CycloneDX document for this package', { skip }, () => {
  const r = spawnSync(NPM, ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const bom = JSON.parse(r.stdout);
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.ok(bom.specVersion);
  const root = bom.metadata.component;
  // npm names the root component after the checkout directory, so the package name is
  // checked on bom-ref and purl, which npm builds from package.json.
  assert.equal(root['bom-ref'], `${pkg.name}@${pkg.version}`);
  assert.equal(root.version, pkg.version);
  assert.equal(root.purl, `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`);
  assert.ok(Array.isArray(bom.components) && bom.components.length > 0, 'runtime dependencies are listed');
});

test('the release workflow attaches the SBOM without widening the publish job', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/release-npm.yml'), 'utf8');
  assert.match(wf, /npm sbom --sbom-format cyclonedx --omit dev/);
  const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  sbom:'));
  assert.match(publish, /environment: npm-release/);
  assert.match(publish, /id-token: write/);
  assert.doesNotMatch(publish, /contents: write/);
  assert.match(wf.slice(wf.indexOf('\n  sbom:')), /needs: publish/);
});
