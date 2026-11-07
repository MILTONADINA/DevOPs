// specs/release/npm-package.md REQ-15, AC-20 (issue #353): init and analyze
// record every file they write in .workflow/state/install-manifest.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { HOOK_KEY, MANIFEST, validKey } from '../analyzer/install-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
// These tests are about the manifest, not signatures, so they opt out of cosign
// and log why, as package-smoke.sh does.
const UNSIGNED = ['--allow-unsigned', '--rationale=install manifest test without cosign'];
// Tests never run the real git (tests/hermeticity.test.mjs).
const STUB_BIN = mkdtempSync(path.join(tmpdir(), 'install-manifest-git-'));
writeStubGit(STUB_BIN);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const GITIGNORE = 'node_modules/\n';

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-353-')));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer/nextjs-project'), dir, { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function analyzeAndInit(dir, ...extra) {
  const a = devops(dir, 'analyze');
  assert.equal(a.status, 0, a.stderr);
  return devops(dir, 'init', '--no-agile-graph', ...UNSIGNED, ...extra);
}
const manifestOf = dir => JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
const listFiles = dir => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));

test(`every file analyze and init write is recorded with its hash (${SPEC}#ac-20)`, () => {
  withProject(dir => {
    const before = new Set(listFiles(dir));
    const r = analyzeAndInit(dir);
    assert.equal(r.status, 0, r.stderr);
    const m = manifestOf(dir);
    assert.equal(m.schema_version, 1);
    const own = new Set([MANIFEST]);
    for (const file of listFiles(dir)) {
      if (file.startsWith('.git/') || own.has(file) || file.startsWith('.workflow/state/originals/')) continue;
      if (before.has(file) && file !== '.gitignore') continue; // a fixture file init did not touch
      assert.ok(Object.hasOwn(m.files, file), `${file} is recorded`);
      assert.equal(m.files[file].written, sha(path.join(dir, file)), `${file} hash`);
    }
    // Created files have no original; the user's .gitignore keeps a copy of its bytes.
    assert.equal(m.files['.claude/agents/coder.md'].original, null);
    const ignore = m.files['.gitignore'].original;
    assert.equal(readFileSync(path.join(dir, ignore.copy), 'utf8'), GITIGNORE);
    assert.equal(ignore.sha256, createHash('sha256').update(GITIGNORE).digest('hex'));
    // The pre-commit hook lives in Git's hooks folder and is recorded under its own name.
    assert.equal(m.files[HOOK_KEY].written, sha(path.join(dir, '.git/hooks/pre-commit')));
    for (const folder of ['.workflow', '.workflow/state', '.claude', '.claude/hooks', '.claude/skills/goal-loop'])
      assert.ok(m.dirs.includes(folder), `${folder} recorded as created`);
    assert.ok(!m.dirs.includes('.git'), '.git existed before');
  });
});

test(`a later init keeps the first original and updates what was written (${SPEC}#ac-20)`, () => {
  withProject(dir => {
    assert.equal(analyzeAndInit(dir).status, 0);
    const first = manifestOf(dir);
    appendFileSync(path.join(dir, '.claude/agents/coder.md'), '# local edit\n');
    appendFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    assert.equal(analyzeAndInit(dir).status, 0);
    const second = manifestOf(dir);
    assert.deepEqual(second.files['.gitignore'].original, first.files['.gitignore'].original, 'the original is set once');
    assert.equal(readFileSync(path.join(dir, first.files['.gitignore'].original.copy), 'utf8'), GITIGNORE);
    assert.equal(second.files['.claude/agents/coder.md'].original, null, 'still a file DevOPs created');
    assert.equal(second.files['.claude/agents/coder.md'].written, sha(path.join(dir, '.claude/agents/coder.md')));
    assert.deepEqual(second.dirs, first.dirs);
  });
});

test(`a dry run writes no manifest (${SPEC}#ac-20)`, () => {
  withProject(dir => {
    assert.equal(devops(dir, 'analyze').status, 0);
    const analyzed = manifestOf(dir);
    const r = devops(dir, 'init', '--no-agile-graph', '--dry-run', ...UNSIGNED);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(manifestOf(dir), analyzed, 'only analyze recorded anything');
    assert.ok(!existsSync(path.join(dir, '.workflow/state/originals')));
  });
});

for (const [label, manifest] of [
  ['a path with ..', { schema_version: 1, files: { '../outside': { original: null, written: 'a'.repeat(64) } }, dirs: [] }],
  ['an absolute path', { schema_version: 1, files: {}, dirs: ['/tmp'] }],
  ['an original copy outside the project', { schema_version: 1, files: { 'x': { original: { sha256: 'a'.repeat(64), copy: '../../x' }, written: 'a'.repeat(64) } }, dirs: [] }],
  ['another schema', { schema_version: 2, files: {}, dirs: [] }],
  ['an extra key', { schema_version: 1, files: {}, dirs: [], run: 'x' }],
]) {
  test(`init refuses a committed manifest with ${label} and changes nothing (${SPEC}#ac-20)`, () => {
    withProject(dir => {
      mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
      const text = JSON.stringify(manifest);
      writeFileSync(path.join(dir, MANIFEST), text);
      const a = devops(dir, 'analyze');
      assert.equal(a.status, 1, a.stdout + a.stderr);
      assert.match(a.stderr, /install-manifest\.json has an unknown schema or a path outside the project/);
      assert.equal(readFileSync(path.join(dir, MANIFEST), 'utf8'), text);
      assert.ok(!existsSync(path.join(dir, '.workflow/profile.yml')), 'analyze wrote nothing');
    });
  });
}

test(`a symlinked originals folder is refused and nothing is copied through it (${SPEC}#req-15)`, () => {
  withProject(dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-outside-')));
    try {
      mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
      symlinkSync(outside, path.join(dir, '.workflow/state/originals'));
      const r = analyzeAndInit(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /refusing to write through a symlink in the project: \.workflow\/state\/originals/);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('validKey accepts only project-relative paths', () => {
  for (const key of ['a', '.claude/hooks/x.sh', 'git-hooks/pre-commit']) assert.ok(validKey(key), key);
  for (const key of ['', '/a', '../a', 'a/../b', 'a//b', './a', 'a/.', 'C:/a', 'a\\b', 'a\0b', 1, null])
    assert.ok(!validKey(key), String(key));
});
