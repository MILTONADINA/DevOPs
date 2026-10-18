// Issue #282: real CLI bootstrap regressions, specs/release/npm-package.md REQ-10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
const FILES = ['PRINCIPLES.md', 'ANTIPATTERNS.md', 'LOOP.md'];

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-282-')));
  try {
    mkdirSync(path.join(dir, '.workflow'));
    writeFileSync(path.join(dir, '.workflow/profile.yml'), 'state: greenfield\nskills: []\nhooks: []\nsubagents: []\n');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function init(cwd, args = [], root) {
  const env = { ...process.env };
  delete env.DEVOPS_ROOT;
  if (root) env.DEVOPS_ROOT = root;
  const r = spawnSync(process.execPath, [root ? CLI : path.join(cwd, 'node_modules/@miltonadina/devops/scripts/devops-cli.js'), 'init', '--no-agile-graph', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}
// A local-install layout, with the package's own dependencies supplied by the
// checkout, like npm-package.test.mjs's local bin harness; no npm/network needed.
function installPackage(dir, relative) {
  const root = path.join(dir, relative);
  mkdirSync(root, { recursive: true });
  for (const name of ['package.json', 'AGENTS.md', 'CLAUDE.md', 'templates/claude-md', 'scripts', 'analyzer', 'constitution', 'cost-controls', 'governance/skill-manifest.yml']) {
    cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}
function snapshot(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map(e => {
    const name = path.relative(dir, path.join(e.parentPath, e.name));
    return [name, e.isFile() ? readFileSync(path.join(dir, name)).toString('hex') : null];
  }).sort(([a], [b]) => a.localeCompare(b));
}

for (const relative of ['node_modules/@miltonadina/devops', 'vendor/live devops']) {
  test(`local constitution reads resolve from the actual install at ${relative} (${SPEC}#ac-10)`, () => {
    withProject(dir => {
      const root = installPackage(dir, relative);
      const stdout = init(dir, [], relative.startsWith('vendor') ? root : undefined);
      const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      const reads = [...agents.matchAll(/^\d+\. Read `([^`]+)`/gm)].map(m => m[1]);
      assert.equal(reads.length, 3);
      for (const file of FILES) {
        const expected = `${relative}/constitution/${file}`;
        assert.ok(reads.includes(expected), agents);
        assert.ok(existsSync(path.join(dir, expected)), expected);
        assert.ok(stdout.includes(expected), stdout);
      }
      assert.ok(!existsSync(path.join(dir, 'constitution')));
    });
  });
}

for (const targetForm of ['--target', '--target=']) {
  test(`external package instructions are portable and target-aware with ${targetForm} (${SPEC}#ac-10)`, () => {
    withProject(dir => {
      const stdout = init(ROOT, targetForm === '--target' ? [targetForm, dir] : [`${targetForm}${dir}`], ROOT);
      const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      const steps = stdout.slice(stdout.indexOf('First steps in the agent:'));
      for (const text of [agents, steps]) {
        assert.ok(text.includes('@miltonadina/devops'), text);
        for (const file of FILES) {
          assert.ok(text.includes(`constitution/${file}`), text);
          assert.ok(!text.includes(`${ROOT}/constitution/${file}`), text);
        }
      }
      assert.ok(!existsSync(path.join(dir, 'constitution')));
    });
  });
}

test(`first spec instructions say to create specs/ (${SPEC}#ac-11)`, () => {
  withProject(dir => {
    const stdout = init(dir, [], ROOT);
    assert.match(stdout, /Create specs\/ and write your first spec there/);
    assert.doesNotMatch(stdout, /auto-loaded on session start/);
  });
});

for (const before of [undefined, '', '# keep\nnode_modules/\n', '# keep\nnode_modules/', '# keep\r\nnode_modules/\r\n', '# keep\r\nnode_modules/', 'AGENTS.override.md\n# keep\n', '# keep\r\nAGENTS.override.md']) {
  test(`gitignore preserves bytes and adds no duplicate for ${JSON.stringify(before)} (${SPEC}#ac-12)`, () => {
    withProject(dir => {
      const file = path.join(dir, '.gitignore');
      if (before !== undefined) writeFileSync(file, before);
      const eol = before?.includes('\r\n') ? '\r\n' : '\n';
      const expected = before?.split(/\r?\n/).includes('AGENTS.override.md') ? before
        : (before || '') + (before && !before.endsWith('\n') ? eol : '') + 'AGENTS.override.md' + eol;
      for (let i = 0; i < 2; i++) {
        init(dir, [], ROOT);
        const after = readFileSync(file, 'utf8');
        assert.equal(after, expected);
        assert.equal(after.split(/\r?\n/).filter(l => l === 'AGENTS.override.md').length, 1);
      }
    });
  });
}

for (const before of [undefined, '# keep\r\nnode_modules/']) {
  test(`dry-run reports gitignore addition and changes no bytes for ${JSON.stringify(before)} (${SPEC}#ac-12)`, () => {
    withProject(dir => {
      if (before !== undefined) writeFileSync(path.join(dir, '.gitignore'), before);
      const original = snapshot(dir);
      const stdout = init(dir, ['--dry-run'], ROOT);
      assert.deepEqual(snapshot(dir), original);
      assert.match(stdout, /dry-run: would add AGENTS\.override\.md to \.gitignore/);
    });
  });
}

// Backticked repository paths: contain a slash or end in a file extension.
function claudePaths(text) {
  return [...text.matchAll(/`([^`\s]+)`/g)].map(m => m[1])
    .filter(p => (p.includes('/') || /\.(md|sh|ts|js|yml)$/.test(p)) && p !== 'AGENTS.override.md');
}

test(`installed CLAUDE.md names only files that exist and no DevOPs-internal records (${SPEC}#ac-13)`, () => {
  withProject(dir => {
    const relative = 'node_modules/@miltonadina/devops';
    installPackage(dir, relative);
    init(dir);
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const paths = claudePaths(claude);
    for (const needed of ['AGENTS.md', `${relative}/constitution/LOOP.md`, '.workflow/state/budget.yml']) {
      assert.ok(paths.includes(needed), `${needed} in ${paths}`);
    }
    for (const p of paths) assert.ok(existsSync(path.join(dir, p)), `${p} exists from the project`);
    for (const banned of ['runtime/', 'blueprint.md', 'LAUNCH_READINESS', 'Stratum', 'graph-preflight', 'governance/graph', 'plan.md']) {
      assert.ok(!claude.includes(banned), `${banned} absent`);
    }
    assert.ok(!claude.includes(dir) && !claude.includes('{{'), 'no absolute path or unfilled placeholder');
  });
});

test(`external package CLAUDE.md is package-relative with no machine path (${SPEC}#ac-13)`, () => {
  withProject(dir => {
    const root = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'init-284-pkg-'))), 'pkg');
    try {
      installPackage(root, '.');
      init(dir, [], root);
      const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
      assert.ok(claude.includes('`constitution/PRINCIPLES.md` in the `@miltonadina/devops` package'), claude);
      assert.ok(!claude.includes(root) && !claude.includes('{{'));
    } finally {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
  });
});

test(`init keeps an existing CLAUDE.md and a dry run writes nothing (${SPEC}#ac-14)`, () => {
  withProject(dir => {
    installPackage(dir, 'node_modules/@miltonadina/devops');
    const before = snapshot(dir);
    const out = init(dir, ['--dry-run']);
    assert.ok(out.includes('would install: CLAUDE.md'), out);
    assert.deepEqual(snapshot(dir), before);
    assert.ok(!existsSync(path.join(dir, 'CLAUDE.md')));
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine\n');
    init(dir);
    assert.equal(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'mine\n');
  });
});
