// Tests for the published npm package (specs/release/npm-package.md). They run the
// package's own entry points with node and bash only; nothing here calls npm or git
// (tests/hermeticity.test.mjs). CI's package-smoke job installs the real tarball.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, devopsRoot, tsxCli } from '../scripts/devops-paths.js';

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';

// An environment with no DEVOPS_ROOT and a HOME that holds nothing, so a command that
// still looked for ~/DevOPs would fail.
function cleanEnv(home) {
  const env = { ...process.env, HOME: home };
  delete env.DEVOPS_ROOT;
  return env;
}

function withTempDir(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'devops-npm-package-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(`devops version and help read the package they ship in, not ~/DevOPs (${SPEC}#ac-1)`, () => {
  withTempDir((home) => {
    const version = spawnSync(process.execPath, [CLI, 'version'], { env: cleanEnv(home), encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), pkg.version);

    const help = spawnSync(process.execPath, [CLI, 'help'], { env: cleanEnv(home), encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`DevOPs root: ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  });
});

test(`run through a node_modules/.bin-style symlink, devops still finds its own package (${SPEC}#ac-1)`, () => {
  withTempDir((dir) => {
    const bin = path.join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const link = path.join(bin, 'devops');
    symlinkSync(CLI, link);
    const result = spawnSync(process.execPath, [link, 'version'], { cwd: dir, env: cleanEnv(dir), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
  });
});

test(`DEVOPS_ROOT still overrides the root, and a blank value means the package (${SPEC}#ac-1)`, () => {
  assert.equal(PACKAGE_ROOT, ROOT);
  assert.equal(devopsRoot({}), ROOT);
  assert.equal(devopsRoot({ DEVOPS_ROOT: '  ' }), ROOT);
  assert.equal(devopsRoot({ DEVOPS_ROOT: '/opt/devops' }), path.resolve('/opt/devops'));
});

test(`the TypeScript tools run with the package's own tsx, never one found on PATH (${SPEC}#ac-2)`, () => {
  const cli = tsxCli();
  assert.ok(existsSync(cli), cli);
  assert.match(cli, /node_modules[\\/]tsx[\\/]/);
  assert.ok(pkg.dependencies.tsx, 'tsx is a runtime dependency');
  assert.equal(pkg.devDependencies?.tsx, undefined, 'tsx is not also a dev dependency');
  const source = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(source, /execFileSync\(\s*['"]tsx['"]/, 'no tsx looked up on PATH');
});

test(`devops-analyze writes .workflow/profile.yml for the current directory (${SPEC}#ac-2)`, () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', dependencies: { next: '15.0.0' } }));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/devops-analyze.js')], { cwd: dir, env: cleanEnv(dir), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(path.join(dir, '.workflow', 'profile.yml')));
  });
});

test(`an unknown command, including an inherited object key, is refused (${SPEC}#ac-1)`, () => {
  withTempDir((home) => {
    for (const cmd of ['toString', 'constructor', 'no-such-command']) {
      const result = spawnSync(process.execPath, [CLI, cmd], { env: cleanEnv(home), encoding: 'utf8' });
      assert.equal(result.status, 1, `${cmd}: ${result.stdout}`);
      assert.match(result.stderr, new RegExp(`Unknown command: ${cmd}`));
    }
  });
});

// init-project.sh with a stub in place of the installer, so only its hook logic runs.
function runInit(dir, args = []) {
  const stub = path.join(dir, 'installer-stub.mjs');
  writeFileSync(stub, 'process.exit(0);\n');
  const env = { ...cleanEnv(dir), DEVOPS_ROOT: ROOT, DEVOPS_NODE: process.execPath, DEVOPS_TSX: stub };
  return spawnSync('bash', [path.join(ROOT, 'scripts/init-project.sh'), ...args], { cwd: dir, env, encoding: 'utf8' });
}

test(`devops init --target puts the git hook in the target project, not the current directory (${SPEC}#ac-3)`, () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'other project');
    mkdirSync(path.join(target, '.workflow'), { recursive: true });
    writeFileSync(path.join(target, '.workflow', 'profile.yml'), 'state: greenfield\n');
    mkdirSync(path.join(target, '.git'));
    mkdirSync(path.join(dir, '.git'));
    for (const args of [['--target', target], [`--target=${target}`]]) {
      rmSync(path.join(target, '.git', 'hooks'), { recursive: true, force: true });
      const result = runInit(dir, args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(path.join(target, '.git', 'hooks', 'pre-commit')), `hook in the target for ${args.join(' ')}`);
      assert.ok(!existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), 'no hook in the current directory');
    }
  });
});

test(`devops init --dry-run writes no git hook (${SPEC}#ac-3)`, () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, '.workflow'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow', 'profile.yml'), 'state: greenfield\n');
    mkdirSync(path.join(dir, '.git'));
    const result = runInit(dir, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), 'no hook written');
    assert.match(result.stdout, /dry-run: would install \.git\/hooks\/pre-commit/);
  });
});

test(`devops init writes a pre-commit hook that redacts secrets and calls devops verify (${SPEC}#ac-3)`, () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, '.workflow'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow', 'profile.yml'), 'state: greenfield\n');
    mkdirSync(path.join(dir, '.git'));
    const result = runInit(dir);
    assert.equal(result.status, 0, result.stderr);
    const hook = readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.match(hook, /^# DevOPs pre-commit hook$/m);
    assert.match(hook, /gitleaks git --pre-commit --staged --redact/);
    assert.match(hook, /devops verify "\$\{claim_files\[@\]\}" --no-rerun/);
    assert.doesNotMatch(hook, /\$HOME\/DevOPs/);
    assert.ok(statSync(path.join(dir, '.git', 'hooks', 'pre-commit')).mode & 0o100, 'hook is executable');
  });
});

test(`devops init never replaces a pre-commit hook it did not write (${SPEC}#ac-3)`, () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, '.workflow'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow', 'profile.yml'), 'state: greenfield\n');
    mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    const theirs = '#!/bin/sh\necho "the project\'s own hook"\n';
    writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), theirs);
    const result = runInit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), theirs);
    assert.match(result.stdout, /Left the existing \.git\/hooks\/pre-commit unchanged/);
  });
});

test(`every bin exists, starts with a shebang and is in the package (${SPEC}#ac-4)`, () => {
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['devops', 'devops-analyze']);
  for (const target of Object.values(pkg.bin)) {
    const file = path.join(ROOT, target);
    assert.ok(existsSync(file), target);
    assert.equal(readFileSync(file, 'utf8').slice(0, 2), '#!', `${target} has a shebang`);
    assert.ok(pkg.files.includes(target.replace(/^\.\//, '')), `${target} is listed in files`);
  }
});

test(`the package ships the product and none of this repository's own records (${SPEC}#ac-4)`, () => {
  const files = pkg.files;
  for (const needed of ['AGENTS.md', 'CLAUDE.md', 'analyzer/', 'skills/', 'hooks/', 'subagents/', 'verification/',
    'governance/skill-manifest.yml', 'scripts/devops-paths.js', 'scripts/init-project.sh', 'LICENSE']) {
    assert.ok(files.includes(needed), `ships ${needed}`);
  }
  for (const internal of ['docs/', 'governance/', 'scripts/', 'specs/', 'tests/', 'runtime/', '.workflow/',
    'docs/handoff/', 'docs/LAUNCH_READINESS.md', 'governance/graph/', 'governance/test-floors.json']) {
    assert.ok(!files.includes(internal), `does not ship ${internal}`);
  }
  // The graph pipeline still assumes this repository, so its pieces stay out.
  for (const graphPiece of ['!hooks/universal/session-start/graph-preflight.sh', '!slash-commands/universal/sprint.md']) {
    assert.ok(files.includes(graphPiece), `excludes ${graphPiece.slice(1)}`);
  }
});

test(`publishing is public, with provenance, and the metadata npm shows is filled in (${SPEC}#ac-5)`, () => {
  assert.equal(pkg.name, '@miltonadina/devops');
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.homepage, /^https:\/\/github\.com\/MILTONADINA\/DevOPs/);
  assert.match(pkg.bugs.url, /^https:\/\/github\.com\/MILTONADINA\/DevOPs\/issues$/);
  assert.match(pkg.repository.url, /github\.com\/MILTONADINA\/DevOPs\.git$/);
});
