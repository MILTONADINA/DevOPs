// specs/graph/M-masterpiece-standard.md#AC-M30.1: an agent-run install of a package the
// project has not declared is blocked for owner approval. Synthetic package names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks/universal/pre-tool/block-new-dependency.sh');
const ENV = { ...process.env, LC_ALL: 'C' };
for (const key of Object.keys(ENV)) if (key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV'].includes(key)) delete ENV[key];

function withProject(files, fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'new-dep-test-')));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(dir, command) {
  assert.ok(existsSync(HOOK), `hook missing: ${HOOK}`);
  const r = spawnSync('bash', [HOOK, command], { cwd: dir, env: ENV, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  return r;
}
function blocked(dir, command, name) {
  const r = run(dir, command);
  assert.equal(r.status, 2, `${command}\n${r.stderr}`);
  assert.match(r.stderr, /NEW-DEPENDENCY BLOCK/);
  assert.match(r.stderr, /owner approval/i);
  assert.ok(r.stderr.includes(name), `stderr should name ${name}: ${r.stderr}`);
}
function allowed(dir, command) {
  const r = run(dir, command);
  assert.equal(r.status, 0, `${command}\n${r.stderr}`);
  assert.equal(r.stderr, '');
}

const PKG = JSON.stringify({
  dependencies: { 'left-pad-toy': '^1.0.0', '@toy/scoped': '1.0.0' },
  devDependencies: { 'toy-lint': '^2.0.0' },
});

test('npm, pnpm, yarn and bun block an undeclared package and name it', () => {
  withProject({ 'package.json': PKG }, (dir) => {
    blocked(dir, 'npm install toy-new', 'toy-new');
    blocked(dir, 'npm i --save-dev toy-new@1.2.3', 'toy-new');
    blocked(dir, 'pnpm add toy-new', 'toy-new');
    blocked(dir, 'pnpm install toy-new', 'toy-new');
    blocked(dir, 'yarn add toy-new', 'toy-new');
    blocked(dir, 'bun add toy-new', 'toy-new');
    blocked(dir, 'bun install toy-new', 'toy-new');
    blocked(dir, 'cd . && npm install left-pad-toy toy-new', 'toy-new');
    blocked(dir, 'sudo npm install -g toy-new', 'toy-new');
    blocked(dir, 'bash -c "npm install toy-new"', 'toy-new');
  });
});

test('npm and the others allow declared packages, in deps and devDeps', () => {
  withProject({ 'package.json': PKG }, (dir) => {
    allowed(dir, 'npm install left-pad-toy');
    allowed(dir, 'npm install left-pad-toy@^1.0.0 toy-lint');
    allowed(dir, 'pnpm add -D toy-lint');
    allowed(dir, 'yarn add left-pad-toy');
    allowed(dir, 'bun add toy-lint');
  });
});

test('plain installs, other npm subcommands and other commands stay allowed', () => {
  withProject({}, (dir) => {
    for (const c of ['npm install', 'npm i', 'npm ci', 'pnpm install', 'yarn install', 'yarn', 'bun install',
      'pip install -r requirements.txt', 'uv pip install -r requirements.txt', 'cargo build', 'cargo add',
      'npm run build', 'npm test', 'npm uninstall toy-new', 'ls -la', 'echo npm install toy-new', '',
      'npm install ./local-dir', 'pip install .', 'pip install -e .']) allowed(dir, c);
  });
});

test('scoped npm names are compared whole, with and without a version', () => {
  withProject({ 'package.json': PKG }, (dir) => {
    allowed(dir, 'npm install @toy/scoped');
    allowed(dir, 'npm install @toy/scoped@1.0.0');
    blocked(dir, 'npm install @toy/other', '@toy/other');
    blocked(dir, 'npm install @toy/other@2.0.0', '@toy/other');
    blocked(dir, 'npm install @other/scoped', '@other/scoped');
  });
});

test('npm blocks a missing or malformed package.json, a URL operand and an npm: alias target', () => {
  withProject({}, (dir) => blocked(dir, 'npm install toy-new', 'toy-new'));
  withProject({ 'package.json': '{ not json' }, (dir) => blocked(dir, 'npm install toy-new', 'toy-new'));
  withProject({ 'package.json': PKG }, (dir) => {
    blocked(dir, 'npm install git+https://example.invalid/toy.git', 'git+https://example.invalid/toy.git');
    blocked(dir, 'npm install alias@npm:toy-real@1', 'toy-real');
  });
});

test('pip, uv and poetry block undeclared names and read requirements and pyproject', () => {
  withProject({
    'requirements.txt': '# toy\ntoy_pip.pkg==1.0\nother-toy>=2 ; python_version>"3"\n',
    'requirements-dev.txt': '-r requirements.txt\nToy-Dev[extra]~=3.0\n',
    'pyproject.toml': [
      '[project]', 'name = "demo"', 'dependencies = [', '  "toy-proj>=1",', ']',
      '[project.optional-dependencies]', 'x = ["toy-opt"]',
      '[tool.poetry.dependencies]', 'python = "^3.11"', 'toy-poetry = "^1.0"',
      '[tool.poetry.group.dev.dependencies]', 'toy-poetry-dev = { version = "1" }', '',
    ].join('\n'),
  }, (dir) => {
    blocked(dir, 'pip install toy-new', 'toy-new');
    blocked(dir, 'pip3 install --upgrade toy-new==1.0', 'toy-new');
    blocked(dir, 'python3 -m pip install "toy-new>=1.0"', 'toy-new');
    blocked(dir, 'uv pip install toy-new', 'toy-new');
    blocked(dir, 'uv add toy-new', 'toy-new');
    blocked(dir, 'poetry add toy-new@^1.0', 'toy-new');
    blocked(dir, 'pip install -r requirements.txt toy-new[extra]', 'toy-new');
    for (const name of ['toy-pip-pkg', 'Toy_Pip.Pkg', 'other-toy', 'toy-dev', 'toy-proj', 'toy-opt', 'toy-poetry', 'toy-poetry-dev']) {
      allowed(dir, `pip install ${name}`);
    }
    allowed(dir, 'uv add toy-proj>=1');
    allowed(dir, 'poetry add toy-poetry');
    allowed(dir, 'pip install toy-dev[extra]==3.0.1');
  });
  withProject({}, (dir) => blocked(dir, 'pip install toy-new', 'toy-new'));
});

test('cargo add blocks undeclared crates and reads every dependency table', () => {
  withProject({
    'Cargo.toml': [
      '[package]', 'name = "demo"', '[dependencies]', 'toy-crate = "1"', 'toy_other = { version = "2" }',
      '[dev-dependencies]', 'toy-dev = "1"', '[build-dependencies.toy-build]', 'version = "1"',
      '[target.\'cfg(unix)\'.dependencies]', 'toy-unix = "1"', '',
    ].join('\n'),
  }, (dir) => {
    blocked(dir, 'cargo add toy-new', 'toy-new');
    blocked(dir, 'cargo add toy-new@1.0 --features serde', 'toy-new');
    blocked(dir, 'cargo add -F serde toy-new', 'toy-new');
    for (const n of ['toy-crate', 'toy_other', 'toy-dev', 'toy-build', 'toy-unix@1.2']) allowed(dir, `cargo add ${n}`);
  });
  withProject({}, (dir) => blocked(dir, 'cargo add toy-new', 'toy-new'));
});
