// specs/ops/analyzer-detection.md REQ-3 and REQ-4 (issue #271): the extension fallback
// for language detection, and an honest `init --dry-run` ending. Runs the real CLI in
// temporary projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/ops/analyzer-detection.md';

function withProject(files, fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'analyzer-271-')));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const devops = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const listing = dir => readdirSync(dir, { recursive: true }).sort();
const COUNTER = path.join(ROOT, 'tests/fixtures/count-dir-reads.mjs');
// Runs `analyze` with fs.Dir opens, reads and closes under the project counted.
function analyzeCounted(dir, env = {}) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'dir-count-')), 'counts');
  try {
    const r = spawnSync(process.execPath, [CLI, 'analyze'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env, NODE_OPTIONS: `--import=${COUNTER}`, DIR_COUNT_ROOT: dir, DIR_COUNT_OUT: out },
    });
    const counts = { opened: 0, reads: 0, closed: 0 };
    for (const name of readdirSync(path.dirname(out))) {
      const c = JSON.parse(readFileSync(path.join(path.dirname(out), name), 'utf8'));
      for (const k of Object.keys(counts)) counts[k] += c[k];
    }
    return { r, counts };
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
}
const languagesLine = out => out.split('\n').find(l => l.startsWith('Languages:'));

test(`sources without a manifest are detected from their extensions (${SPEC}#ac-3)`, () => {
  withProject({ 'src/a.ts': '', 'src/deep/b.py': '', 'lib/c.rs': '', 'cmd/d.go': '' }, dir => {
    const r = devops(dir, 'analyze');
    assert.equal(r.status, 0, r.stderr);
    const line = languagesLine(r.stdout);
    for (const lang of ['javascript/typescript', 'python', 'rust', 'go']) assert.ok(line.includes(lang), line);
    assert.ok(line.includes('from file extensions; no manifest found'), line);
  });
});

test(`node_modules and hidden folders are not scanned (${SPEC}#ac-3)`, () => {
  withProject({ 'node_modules/x/a.py': '', '.cache/b.go': '', 'main.js': '' }, dir => {
    const line = languagesLine(devops(dir, 'analyze').stdout);
    assert.ok(line.includes('javascript/typescript') && !line.includes('python') && !/\bgo\b(?!\.mod)/.test(line), line);
  });
});

test(`symlinks to outside directories and files are not followed (${SPEC}#ac-3)`, () => {
  withProject({ 'main.js': '' }, dir => {
    withProject({ 'only.rs': '', 'o.go': '' }, outside => {
      symlinkSync(outside, path.join(dir, 'link'));
      symlinkSync(path.join(outside, 'only.rs'), path.join(dir, 'linked.rs'));
      const r = devops(dir, 'analyze');
      assert.equal(r.status, 0, r.stderr);
      const line = languagesLine(r.stdout);
      assert.ok(line.includes('javascript/typescript') && !line.includes('rust') && !/\bgo\b(?!\.mod)/.test(line), line);
    });
  });
});

test(`the walk stops at depth 4 (${SPEC}#ac-3)`, () => {
  withProject({ 'a/b/c/d/ok.py': '', 'a/b/c/d/e/deep.rs': '' }, dir => {
    const line = languagesLine(devops(dir, 'analyze').stdout);
    assert.ok(line.includes('python') && !line.includes('rust'), line);
  });
});

test(`the walk stops at the entry budget and still returns a result (${SPEC}#ac-3)`, () => {
  withProject({ 'sub/late.rs': '', 'first.py': '' }, dir => {
    for (let i = 0; i < 2500; i++) writeFileSync(path.join(dir, `f${i}.txt`), '');
    const { r, counts } = analyzeCounted(dir);
    assert.equal(r.status, 0, r.stderr);
    const line = languagesLine(r.stdout);
    assert.ok(!line.includes('rust'), line);
    assert.ok(line.startsWith('Languages:'), line);
    // Read one entry at a time and stop at the 2000-entry budget, not after listing all
    // 2502; every directory opened is closed.
    assert.equal(counts.reads, 2000, JSON.stringify(counts));
    assert.equal(counts.closed, counts.opened, JSON.stringify(counts));
  });
});

test(`a walk that reaches the end of each folder closes every one (${SPEC}#ac-3)`, () => {
  withProject({ 'src/a.ts': '', 'src/deep/b.py': '', 'lib/c.rs': '' }, dir => {
    const { r, counts } = analyzeCounted(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(counts.opened >= 4, JSON.stringify(counts));
    assert.equal(counts.closed, counts.opened, JSON.stringify(counts));
  });
});

test(`a folder that fails to read is closed and the walk goes on (${SPEC}#ac-3)`, () => {
  withProject({ 'src/a.ts': '', 'lib/c.rs': '' }, dir => {
    const { r, counts } = analyzeCounted(dir, { DIR_COUNT_THROW: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(languagesLine(r.stdout).startsWith('Languages:'), r.stdout);
    assert.ok(counts.opened >= 1, JSON.stringify(counts));
    assert.equal(counts.closed, counts.opened, JSON.stringify(counts));
  });
});

test(`a manifest wins over the extension fallback (${SPEC}#ac-3)`, () => {
  withProject({ 'go.mod': 'module x\n', 'a.py': '' }, dir => {
    const line = languagesLine(devops(dir, 'analyze').stdout);
    assert.equal(line, 'Languages: go');
  });
});

test(`nothing to detect says why and what to do next (${SPEC}#ac-3)`, () => {
  withProject({ 'notes.txt': 'hi' }, dir => {
    const line = languagesLine(devops(dir, 'analyze').stdout);
    assert.ok(line.includes('none detected (no manifest and no source files with known extensions)'), line);
    assert.ok(line.includes('add package.json, pyproject.toml, Cargo.toml or go.mod'), line);
  });
});

test(`init --dry-run says nothing was written and never says initialized (${SPEC}#ac-4)`, () => {
  withProject({ 'package.json': '{"name":"x"}' }, dir => {
    assert.equal(devops(dir, 'analyze').status, 0);
    const before = listing(dir);
    const r = devops(dir, 'init', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/initialized/i.test(r.stdout), r.stdout);
    assert.ok(r.stdout.includes('Dry run complete: nothing was written'), r.stdout);
    assert.ok(!r.stdout.includes('First steps in the agent'), r.stdout);
    assert.deepEqual(listing(dir), before);
  });
});

test(`a real init still says initialized (${SPEC}#ac-4)`, () => {
  withProject({ 'package.json': '{"name":"x"}' }, dir => {
    assert.equal(devops(dir, 'analyze').status, 0);
    const r = devops(dir, 'init', '--no-agile-graph');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes('DevOPs initialized.'), r.stdout);
  });
});
