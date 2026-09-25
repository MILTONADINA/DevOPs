import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync, copyFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'graph-preflight.sh');

function fakeSecurityTools(directory, includeCosign = true) {
  const bin = path.join(directory, 'fake-security-tools');
  mkdirSync(bin);
  for (const name of includeCosign ? ['gitleaks', 'semgrep', 'cosign'] : ['gitleaks', 'semgrep']) {
    const file = path.join(bin, name);
    writeFileSync(file, name === 'cosign' ? '#!/bin/sh\necho "GitVersion: fixture-version"\n' : '#!/bin/sh\necho fixture-version\n');
    chmodSync(file, 0o755);
  }
  return bin;
}

// Stand-ins for gitignored directories a fresh checkout lacks (both node_modules, .workflow/proofs), so
// these tests do not depend on the state of the checkout they run in (polish backlog PB-59). A test that
// exercises one of these checks passes its own override after this spread.
function checkoutFixture(directory) {
  for (const deps of ['root-node_modules', 'stratum-node_modules']) mkdirSync(path.join(directory, deps, '.bin'), { recursive: true });
  mkdirSync(path.join(directory, 'proofs'), { recursive: true });
  return {
    GRAPH_PREFLIGHT_DEPS_ROOT_DIR: path.join(directory, 'root-node_modules'),
    GRAPH_PREFLIGHT_DEPS_STRATUM_DIR: path.join(directory, 'stratum-node_modules'),
    GRAPH_PREFLIGHT_PROOFS_DIR: path.join(directory, 'proofs'),
  };
}

test('declared Node engine supports import.meta.dirname used by graph scripts', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json')));
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json')));
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines.node);
  assert.ok(minimum, 'engines.node must declare a minimum version');
  const [major, minor] = minimum.slice(1).map(Number);
  assert.ok(major > 20 || (major === 20 && minor >= 11), 'import.meta.dirname needs Node 20.11 or newer');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
});

test('check-only reports an Xcode git failure without trying a repair', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-preflight-test-'));
  try {
    const fakeGit = path.join(dir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho "You have not agreed to the Xcode license agreements" >&2\nexit 69\n');
    chmodSync(fakeGit, 0o755);
    const result = spawnSync('bash', [PREFLIGHT, '--check-only'], {
      cwd: ROOT, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GRAPH_PREFLIGHT_REPORT: path.join(dir, 'preflight.json') }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 20, result.stderr);
    const report = JSON.parse(readFileSync(path.join(dir, 'preflight.json'), 'utf8'));
    assert.equal(report.status, 'needs_human');
    assert.ok(report.checks.length >= 8);
    assert.deepEqual(report.checks.find((check) => check.id === 'git.runs')?.status, 'fail');
    assert.match(report.checks.find((check) => check.id === 'git.runs')?.evidence, /Xcode license agreements/);
    assert.match(result.stdout, /git\.runs/);
    assert.match(readFileSync(fakeGit, 'utf8'), /exit 69/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal preflight installs and can revert the Command Line Tools git shim', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-preflight-git-'));
  try {
    const fakeGit = path.join(dir, 'git');
    const original = '#!/bin/sh\necho "You have not agreed to the Xcode license agreements" >&2\nexit 69\n';
    writeFileSync(fakeGit, original);
    chmodSync(fakeGit, 0o755);
    const reportPath = path.join(dir, 'preflight.json');
    const env = { ...process.env, PATH: `${dir}:${fakeSecurityTools(dir)}:${process.env.PATH}`, ...checkoutFixture(dir), GRAPH_PREFLIGHT_REPORT: reportPath };
    const result = spawnSync('bash', [PREFLIGHT], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 10, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.checks.find((check) => check.id === 'git.runs').status, 'fixed');
    assert.match(readFileSync(fakeGit, 'utf8'), /CommandLineTools\/usr\/bin\/git/);
    const reverted = spawnSync('bash', [PREFLIGHT, '--revert', 'git.runs'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(readFileSync(fakeGit, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal preflight repairs non-executable .bin entries and records the fix', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-preflight-chmod-'));
  try {
    const bin = path.join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const tool = path.join(bin, 'fixture-tool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o644);
    const reportPath = path.join(dir, 'preflight.json');
    const result = spawnSync('bash', [PREFLIGHT], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${fakeSecurityTools(dir)}:${process.env.PATH}`, ...checkoutFixture(dir), GRAPH_PREFLIGHT_DEPS_STRATUM_DIR: path.join(dir, 'node_modules'), GRAPH_PREFLIGHT_REPORT: reportPath },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 10, result.stderr || result.stdout);
    assert.ok((statSync(tool).mode & 0o111) !== 0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.status, 'remediated');
    assert.equal(report.checks.find((check) => check.id === 'deps.stratum').status, 'fixed');
    const secondTool = path.join(bin, 'second-tool');
    writeFileSync(secondTool, '#!/bin/sh\nexit 0\n');
    chmodSync(secondTool, 0o644);
    const second = spawnSync('bash', [PREFLIGHT], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${path.join(dir, 'fake-security-tools')}:${process.env.PATH}`, ...checkoutFixture(dir), GRAPH_PREFLIGHT_DEPS_STRATUM_DIR: path.join(dir, 'node_modules'), GRAPH_PREFLIGHT_REPORT: reportPath },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(second.status, 10, second.stderr || second.stdout);
    const reverted = spawnSync('bash', [PREFLIGHT, '--revert', 'deps.stratum'], {
      cwd: ROOT, env: { ...process.env, GRAPH_PREFLIGHT_REPORT: reportPath }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(statSync(tool).mode & 0o777, 0o644);
    assert.equal(statSync(secondTool).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing Cosign installs only a pinned checksum-matching release and reverts it', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-preflight-cosign-'));
  try {
    const home = path.join(dir, 'home');
    const fakeBin = path.join(dir, 'fake-bin');
    mkdirSync(home);
    mkdirSync(fakeBin);
    const fixture = path.join(dir, 'fixture-cosign');
    writeFileSync(fixture, '#!/bin/sh\necho "GitVersion: v2.4.3"\n');
    chmodSync(fixture, 0o755);
    const registry = JSON.parse(readFileSync(path.join(ROOT, 'governance', 'graph', 'preflight-remediations.yml')));
    const platform = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
    registry.remediations.find((entry) => entry.check_id === 'tool.cosign').sha256[platform] = createHash('sha256').update(readFileSync(fixture)).digest('hex');
    const registryPath = path.join(dir, 'registry.yml');
    writeFileSync(registryPath, JSON.stringify(registry));
    const curl = path.join(fakeBin, 'curl');
    writeFileSync(curl, `#!/bin/sh\ncase "$*" in\n  *--head*) printf 'HTTP/2 302\\nLocation: https://release-assets.githubusercontent.com/fixture\\n' ;;\n  *--output*) while [ "$1" != "--output" ]; do shift; done; cp '${fixture}' "$2" ;;\nesac\n`);
    chmodSync(curl, 0o755);
    const reportPath = path.join(dir, 'preflight.json');
    const env = { ...process.env, HOME: home, PATH: `${fakeBin}:${fakeSecurityTools(dir, false)}:${process.env.PATH}`, GRAPH_PREFLIGHT_REGISTRY: registryPath, ...checkoutFixture(dir), GRAPH_PREFLIGHT_REPORT: reportPath };
    const result = spawnSync('bash', [PREFLIGHT], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 10, result.stderr || result.stdout);
    assert.equal(JSON.parse(readFileSync(reportPath)).checks.find((check) => check.id === 'tool.cosign').status, 'fixed');
    assert.equal(readFileSync(path.join(home, 'bin', 'cosign'), 'utf8'), readFileSync(fixture, 'utf8'));
    const reverted = spawnSync('bash', [PREFLIGHT, '--revert', 'tool.cosign'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(reverted.status, 0, reverted.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registry rejects a remediation that needs sudo', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-preflight-registry-'));
  try {
    const registry = path.join(dir, 'bad.yml');
    writeFileSync(registry, JSON.stringify({ remediations: [{ check_id: 'git.runs', detect: 'x', apply: 'x', revert: 'x', reversible: true, needs_sudo: true, why: 'x' }] }));
    const result = spawnSync('bash', [PREFLIGHT, '--check-only'], {
      cwd: ROOT, env: { ...process.env, GRAPH_PREFLIGHT_REGISTRY: registry, GRAPH_PREFLIGHT_REPORT: path.join(dir, 'preflight.json') }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs_sudo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graph-halt alone forces needs_human and survives preflight', () => {
  const dir = mkdtempSync(path.join(ROOT, '.workflow', 'state', 'graph-halt-test-'));
  try {
    const repo = path.join(dir, 'repo');
    for (const subdir of ['scripts', 'governance/graph', '.workflow/state', '.workflow/proofs', 'node_modules/.bin', 'stratum/node_modules/.bin', 'fake-bin']) {
      mkdirSync(path.join(repo, subdir), { recursive: true });
    }
    copyFileSync(path.join(ROOT, 'scripts', 'graph-preflight.mjs'), path.join(repo, 'scripts', 'graph-preflight.mjs'));
    copyFileSync(path.join(ROOT, 'governance', 'graph', 'preflight-remediations.yml'), path.join(repo, 'governance', 'graph', 'preflight-remediations.yml'));
    writeFileSync(path.join(repo, '.workflow', 'network-allowlist.txt'), 'github.com\nrelease-assets.githubusercontent.com\n');
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ engines: { node: '>=20.0.0' } }));
    const fakeGit = path.join(repo, 'fake-bin', 'git');
    writeFileSync(fakeGit, `#!/bin/sh\ncase "$*" in\n  'rev-parse --show-toplevel') printf '%s\\n' '${repo}' ;;\n  'remote get-url origin') echo 'https://github.com/example/repo.git' ;;\n  'ls-remote --exit-code origin HEAD') echo 'abc HEAD' ;;\n  'rev-parse HEAD') echo 'abcdef0' ;;\n  *) exit 2 ;;\nesac\n`);
    chmodSync(fakeGit, 0o755);
    for (const name of ['gitleaks', 'semgrep', 'cosign']) {
      const file = path.join(repo, 'fake-bin', name);
      writeFileSync(file, name === 'cosign' ? '#!/bin/sh\necho "GitVersion: fixture-version"\n' : '#!/bin/sh\necho fixture-version\n');
      chmodSync(file, 0o755);
    }
    const halt = path.join(repo, '.workflow', 'state', 'graph-halt');
    writeFileSync(halt, 'halted\n');
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts', 'graph-preflight.mjs'), '--check-only'], {
      cwd: repo, env: { ...process.env, PATH: `${path.join(repo, 'fake-bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 20, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(path.join(repo, '.workflow', 'state', 'preflight.json')));
    assert.equal(report.status, 'needs_human');
    assert.deepEqual(report.checks.filter((check) => check.status === 'fail').map((check) => check.id), ['halt.absent']);
    assert.match(result.stdout, /✗ halt\.absent/);
    assert.equal(existsSync(halt), true);
    rmSync(halt);
    const blocked = path.join(repo, '.workflow', 'state', 'blocked.md');
    writeFileSync(blocked, '## Class\nneeds_human\n');
    const marked = spawnSync(process.execPath, [path.join(repo, 'scripts', 'graph-preflight.mjs'), '--check-only'], {
      cwd: repo, env: { ...process.env, PATH: `${path.join(repo, 'fake-bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(marked.status, 20, marked.stderr || marked.stdout);
    assert.deepEqual(JSON.parse(readFileSync(path.join(repo, '.workflow', 'state', 'preflight.json'))).checks
      .filter((check) => check.status === 'fail').map((check) => check.id), ['blocked.human']);
    rmSync(blocked);
    const cleared = spawnSync(process.execPath, [path.join(repo, 'scripts', 'graph-preflight.mjs'), '--check-only'], {
      cwd: repo, env: { ...process.env, PATH: `${path.join(repo, 'fake-bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(cleared.status, 0, cleared.stderr || cleared.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A copy of the preflight in its own project directory, whose root node_modules is a symlink to a
// directory outside it: the usual layout of a worktree that shares an install.
function linkedDependenciesProject() {
  const outside = mkdtempSync(path.join(tmpdir(), 'preflight-shared-deps-'));
  // Real path: on macOS tmpdir() is under /var, a symlink to /private/var, and the preflight compares real paths.
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'preflight-linked-root-')));
  mkdirSync(path.join(outside, '.bin'));
  for (const file of ['scripts/graph-preflight.sh', 'scripts/graph-preflight.mjs', 'governance/graph/preflight-remediations.yml', 'package.json']) {
    mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(project, file));
  }
  mkdirSync(path.join(project, 'stratum', 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(project, '.workflow', 'state'), { recursive: true });
  symlinkSync(outside, path.join(project, 'node_modules'));
  const runPreflight = (extraEnv = {}) => spawnSync('bash', [path.join(project, 'scripts', 'graph-preflight.sh'), '--check-only'], {
    cwd: project,
    env: { ...process.env, PATH: `${fakeSecurityTools(mkdtempSync(path.join(project, 'tools-')))}:${process.env.PATH}`, GRAPH_PREFLIGHT_REPORT: path.join(project, '.workflow', 'state', 'preflight.json'), ...extraEnv },
    encoding: 'utf8', timeout: 30_000,
  });
  const cleanup = () => { rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); };
  return { project, outside, runPreflight, cleanup };
}

test('check-only reports a root node_modules symlinked outside the project instead of aborting', () => {
  const fixture = linkedDependenciesProject();
  try {
    const result = fixture.runPreflight();
    assert.notEqual(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /redirect outside the project root/);
    const report = JSON.parse(readFileSync(path.join(fixture.project, '.workflow', 'state', 'preflight.json'), 'utf8'));
    assert.equal(report.checks.find((check) => check.id === 'deps.root')?.status, 'pass');
  } finally { fixture.cleanup(); }
});

test('a dependency override that redirects outside the project still aborts', () => {
  const fixture = linkedDependenciesProject();
  try {
    const link = path.join(fixture.project, '.workflow', 'state', 'deps-link');
    symlinkSync(fixture.outside, link);
    const result = fixture.runPreflight({ GRAPH_PREFLIGHT_DEPS_ROOT_DIR: link });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /Root dependencies redirect outside the project root/);
  } finally { fixture.cleanup(); }
});
