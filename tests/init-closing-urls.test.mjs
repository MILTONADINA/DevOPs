// Issue #420: init's closing text names files by GitHub URL pinned to the installed
// version's tag. Every URL it prints must point at a path that exists in this repository.
// specs/release/npm-package.md REQ-14, AC-19.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_STATE_IGNORES } from '../analyzer/install-manifest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const BLOB = `https://github.com/MILTONADINA/DevOPs/blob/v${VERSION}/`;
const PACKAGE_DIR = 'node_modules/@miltonadina/devops';

function withProject(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'init-420-')));
  try {
    mkdirSync(path.join(dir, '.workflow'));
    writeFileSync(path.join(dir, '.workflow/profile.yml'), 'state: greenfield\nskills: []\nhooks: []\nsubagents: []\n');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs init from `dir`. With `root`, that package is the DevOPs source (DEVOPS_ROOT); without it,
// init runs from the package installed inside the project.
function init(dir, args = [], root) {
  const env = { ...process.env };
  delete env.DEVOPS_ROOT;
  if (root) env.DEVOPS_ROOT = root;
  const script = root ? CLI : path.join(dir, PACKAGE_DIR, 'scripts/devops-cli.js');
  const r = spawnSync(process.execPath, [script, 'init', '--no-agile-graph', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}

// A package layout inside the project: what npm ships (package.json `files`) plus package.json
// and the constitution, with the checkout's node_modules linked in.
function installPackage(dir) {
  const root = path.join(dir, PACKAGE_DIR);
  mkdirSync(root, { recursive: true });
  const shippedEntries = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files.filter(e => !e.startsWith('!'));
  for (const name of ['package.json', 'CLAUDE.md', ...shippedEntries]) {
    if (existsSync(path.join(ROOT, name))) cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
}

// Every GitHub URL in init's output, with trailing punctuation removed.
function urlsIn(text) {
  return [...text.matchAll(/https:\/\/github\.com\/[^\s`'"<>]+/g)].map(m => m[0].replace(/[.,;:)]+$/, ''));
}

const RUNS = [
  ['real run, package outside the project', false, false],
  ['real run, package inside the project', true, false],
  ['dry run, package outside the project', false, true],
];

for (const [label, inside, dryRun] of RUNS) {
  test(`every URL in init's closing text is pinned to v${VERSION} and its path exists in the repository (${label}) (${SPEC}#ac-19)`, () => {
    withProject(dir => {
      if (inside) installPackage(dir);
      const stdout = init(dir, dryRun ? ['--dry-run'] : [], inside ? undefined : ROOT);
      const closing = stdout.slice(stdout.indexOf('Next steps:'));
      assert.ok(closing.includes('First steps in the agent:'), stdout);
      const urls = urlsIn(closing);
      assert.ok(urls.length >= 6, `expected the command, client and constitution URLs:\n${closing}`);
      for (const url of urls) {
        assert.ok(url.startsWith(BLOB), `${url} is not pinned to v${VERSION}`);
        const p = url.slice(BLOB.length);
        assert.ok(existsSync(path.join(ROOT, p)), `${p} does not exist in the repository (${url})`);
      }
      for (const needed of ['docs/CLIENT_ONBOARDING.md', 'slash-commands/universal/checkpoint.md', 'slash-commands/universal/ears-spec.md',
        'constitution/PRINCIPLES.md', 'constitution/ANTIPATTERNS.md', 'constitution/LOOP.md']) {
        assert.ok(urls.includes(`${BLOB}${needed}`), `${needed} is named by URL:\n${closing}`);
      }
      assert.ok(!closing.includes('in the `@miltonadina/devops` package'), closing);
    });
  });
}

test(`init's closing text says what to commit and what stays local (${SPEC}#ac-19)`, () => {
  withProject(dir => {
    const commit = init(dir, [], ROOT).split('\n').find(line => line.includes('Commit AGENTS.md'));
    assert.ok(commit, 'a Commit line is printed');
    assert.ok(commit.includes('Commit AGENTS.md, CLAUDE.md, .claude/ and .workflow/profile.yml'), commit);
    assert.ok(commit.includes('Keep .workflow/state/ local'), commit);
    // The entries init adds to .gitignore are named exactly as written there.
    for (const entry of LOCAL_STATE_IGNORES) assert.ok(commit.includes(entry), `${entry} in ${commit}`);
  });
});
