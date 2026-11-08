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
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const REPO_BLOB = `https://github.com/MILTONADINA/DevOPs/blob/v${VERSION}`;

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
  // What npm ships (package.json `files`), plus package.json and this repository's CLAUDE.md.
  const shippedEntries = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files.filter(e => !e.startsWith('!'));
  for (const name of ['package.json', 'CLAUDE.md', ...shippedEntries]) {
    if (existsSync(path.join(ROOT, name))) cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
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
        assert.ok(stdout.includes(`${REPO_BLOB}/constitution/${file}`), stdout); // #420: named by URL in the closing text
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
      assert.ok(agents.includes('@miltonadina/devops'), agents);
      for (const file of FILES) {
        assert.ok(agents.includes(`constitution/${file}`), agents);
        assert.ok(!agents.includes(`${ROOT}/constitution/${file}`), agents);
        // #420: the printed steps name the constitution by its GitHub URL at the release tag.
        assert.ok(steps.includes(`${REPO_BLOB}/constitution/${file}`), steps);
        assert.ok(!steps.includes(`${ROOT}/constitution/${file}`), steps);
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

// Every line init keeps out of Git: the local override, plus the install
// manifest and its originals, which uninstall refuses once tracked (#390).
const IGNORED = ['AGENTS.override.md', '.workflow/state/install-manifest.json', '.workflow/state/originals/'];

for (const before of [undefined, '', '# keep\nnode_modules/\n', '.workflow/state/originals/\n', '# keep\r\n.workflow/state/install-manifest.json', '# keep\nnode_modules/', '# keep\r\nnode_modules/\r\n', '# keep\r\nnode_modules/', 'AGENTS.override.md\n# keep\n', '# keep\r\nAGENTS.override.md']) {
  test(`gitignore preserves bytes and adds no duplicate for ${JSON.stringify(before)} (${SPEC}#ac-12)`, () => {
    withProject(dir => {
      const file = path.join(dir, '.gitignore');
      if (before !== undefined) writeFileSync(file, before);
      const eol = before?.includes('\r\n') ? '\r\n' : '\n';
      const lines = new Set((before ?? '').split(/\r?\n/));
      const missing = IGNORED.filter(line => !lines.has(line));
      const expected = (before || '') + (before && !before.endsWith('\n') ? eol : '') + missing.map(line => line + eol).join('');
      for (let i = 0; i < 2; i++) {
        init(dir, [], ROOT);
        const after = readFileSync(file, 'utf8');
        assert.equal(after, expected);
        for (const line of IGNORED) assert.equal(after.split(/\r?\n/).filter(l => l === line).length, 1, line);
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
      assert.match(stdout, /dry-run: would add AGENTS\.override\.md, \.workflow\/state\/install-manifest\.json, \.workflow\/state\/originals\/ to \.gitignore/);
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

// specs/release/npm-package.md REQ-14, AC-19 (#352): the printed steps name only
// files that exist, in the project or in the package as npm ships it.
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// True when package.json `files` ships `p` (an entry is a file, or a folder ending in /).
function shipped(p) {
  const hit = entry => entry.endsWith('/') ? p.startsWith(entry) : p === entry;
  return PKG.files.some(e => !e.startsWith('!') && hit(e)) && !PKG.files.some(e => e.startsWith('!') && hit(e.slice(1)));
}
function printedSteps(stdout) {
  const start = stdout.indexOf('Next steps:');
  assert.ok(start >= 0, stdout);
  return stdout.slice(start);
}
const PACKAGE_DIR = 'node_modules/@miltonadina/devops';
for (const inside of [true, false]) {
  test(`init's printed steps name only files that exist (${inside ? 'package in the project' : 'package outside the project'}) (${SPEC}#ac-19)`, () => {
    withProject(dir => {
      if (inside) installPackage(dir, PACKAGE_DIR);
      const steps = printedSteps(init(dir, [], inside ? undefined : ROOT));
      // #420: package files are named by GitHub URL at the release tag; each path must exist in this repository.
      const urls = [...steps.matchAll(/https:\/\/github\.com\/\S+/g)].map(m => m[0].replace(/[.,;:)]+$/, ''));
      assert.ok(urls.length >= 5, steps);
      for (const u of urls) {
        assert.ok(u.startsWith(`${REPO_BLOB}/`), u);
        const p = u.slice(REPO_BLOB.length + 1);
        assert.ok(existsSync(path.join(ROOT, p)) && shipped(p), `${p} ships in the package:\n${steps}`);
      }
      const files = [...steps.matchAll(/`([^`\s]+)`/g)].map(m => m[1])
        .filter(p => p.includes('/') || /\.(md|ya?ml|json|sh)$/.test(p));
      assert.ok(files.length >= 2, steps);
      for (const p of files) {
        if (p === '.workflow/client/profile.yml') continue; // the step says to create it
        assert.ok(existsSync(path.join(dir, p)), `${p} exists in the project:\n${steps}`);
      }
      // Init installs no slash commands: a command is named only with the plugin it needs.
      for (const line of steps.split('\n').filter(l => /(^|[\s(])\/[a-z][a-z-]+\b/.test(l)))
        assert.match(line, /with the (DevOPs Claude Code )?plugin installed/, line);
    });
  });
}

// specs/release/npm-package.md REQ-17, AC-22 (#380): the installed AGENTS.md names
// only paths a reader can open: in the project, or in the package as npm ships it.
// Paths under `.workflow/` are project state that AGENTS.md says is created when
// first needed; the rest of the exceptions are named here with why.
const NOT_FILES = new Set([
  'release/*',          // a branch pattern, next to `main` and `production`
  'specs/',             // the project's own specs folder, which it creates
  'AGENTS.override.md', // the local override the user may create
  'package.json',       // "if `package.json` (or equivalent) changed": the project's own, when it has one
  '@miltonadina/devops', // the package name, in "in the `@miltonadina/devops` package"
]);
for (const inside of [true, false]) {
  test(`installed AGENTS.md names only paths that exist (${inside ? 'package in the project' : 'package outside the project'}) (${SPEC}#ac-22)`, () => {
    withProject(dir => {
      if (inside) installPackage(dir, PACKAGE_DIR);
      init(dir, [], inside ? undefined : ROOT);
      const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      const tokens = [...new Set([...agents.matchAll(/`([^`\s]+)`/g)].map(m => m[1]))]
        .filter(p => (p.includes('/') || /\.(md|ya?ml|json|sh|txt|jsonl)$/.test(p)) && !/^\/[a-z-]+$/.test(p));
      assert.ok(tokens.length >= 25, tokens.join(' '));
      let fromPackage = 0;
      for (const p of tokens) {
        if (NOT_FILES.has(p) || p.startsWith('.workflow/')) continue;
        const inPackage = inside && p.startsWith(`${PACKAGE_DIR}/`) ? p.slice(PACKAGE_DIR.length + 1)
          : !inside && agents.includes(`\`${p}\` in the \`@miltonadina/devops\` package`) ? p : null;
        if (inPackage === null) {
          assert.ok(existsSync(path.join(dir, p)), `${p} exists in the project`);
          continue;
        }
        fromPackage++;
        const fixed = inPackage.split('/').findIndex(part => /[<*]/.test(part));
        const real = fixed === -1 ? inPackage : `${inPackage.split('/').slice(0, fixed).join('/')}/`;
        assert.ok(existsSync(path.join(ROOT, real)) && shipped(real), `${real} ships in the package`);
      }
      assert.ok(fromPackage >= 15, `package files are named from the project (${fromPackage})`);
      assert.ok(agents.includes('Paths under `.workflow/` are this project\'s state'), 'the .workflow/ note is present');
      assert.ok(!agents.includes(dir), 'no absolute machine path');
      for (const line of agents.split('\n').filter(l => /`\/[a-z][a-z-]+`/.test(l)))
        assert.match(line, /with the DevOPs Claude Code plugin installed/, line);
    });
  });
}
