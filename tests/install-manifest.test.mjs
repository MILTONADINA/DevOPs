// specs/release/npm-package.md REQ-15, AC-20 (issue #353): init and analyze
// record every file they write in .workflow/state/install-manifest.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { HOOK_KEY, MANIFEST, ORIGINALS, openManifest, ownFile, validKey } from '../analyzer/install-manifest.js';

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
    assert.equal(m.adopted, false);
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
    const originalsDir = path.join(dir, ORIGINALS);
    const copies = () => listFiles(originalsDir).map(f => [f, sha(path.join(originalsDir, f))]);
    const originals = copies();
    const r = devops(dir, 'init', '--no-agile-graph', '--dry-run', ...UNSIGNED);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(manifestOf(dir), analyzed, 'only analyze recorded anything');
    assert.deepEqual(copies(), originals, 'the dry run copied or changed no original');
  });
});

// REQ-10 (#391): analyze alone keeps the manifest out of Git, and uninstall
// puts the project's own .gitignore back.
test(`analyze alone adds the manifest lines to .gitignore once and uninstall restores it (${SPEC}#ac-12)`, () => {
  withProject(dir => {
    for (let i = 0; i < 2; i++) {
      const r = devops(dir, 'analyze');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'),
        `${GITIGNORE}.workflow/state/install-manifest.json\n.workflow/state/originals/\n`);
      assert.equal(/Added .* to \.gitignore/.test(r.stdout), i === 0, r.stdout);
    }
    assert.ok(manifestOf(dir).files['.gitignore'], '.gitignore is recorded');
    const u = devops(dir, 'uninstall');
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
  });
});

test(`analyze creates a .gitignore when there is none and uninstall removes it (${SPEC}#ac-12)`, () => {
  withProject(dir => {
    rmSync(path.join(dir, '.gitignore'));
    assert.equal(devops(dir, 'analyze').status, 0);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'),
      '.workflow/state/install-manifest.json\n.workflow/state/originals/\n');
    assert.equal(manifestOf(dir).files['.gitignore'].original, null, 'DevOPs created it');
    const u = devops(dir, 'uninstall');
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.ok(!existsSync(path.join(dir, '.gitignore')));
  });
});

test(`analyze leaves an already-ignoring .gitignore byte for byte (${SPEC}#ac-12)`, () => {
  withProject(dir => {
    const before = '# keep\r\n.workflow/state/originals/\r\n.workflow/state/install-manifest.json';
    writeFileSync(path.join(dir, '.gitignore'), before);
    assert.equal(devops(dir, 'analyze').status, 0);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), before);
    assert.equal(manifestOf(dir).files['.gitignore'], undefined, 'nothing written, nothing recorded');
  });
});

for (const [label, manifest] of [
  ['a path with ..', { schema_version: 1, files: { '../outside': { original: null, written: 'a'.repeat(64) } }, dirs: [] }],
  ['an absolute path', { schema_version: 1, adopted: false, files: {}, dirs: ['/tmp'] }],
  ['an original copy outside the project', { schema_version: 1, adopted: false, files: { 'AGENTS.md': { original: { sha256: 'a'.repeat(64), copy: '../../x' }, written: 'a'.repeat(64) } }, dirs: [] }],
  ['an original copy that is not its own', { schema_version: 1, adopted: false, files: { 'AGENTS.md': { original: { sha256: 'a'.repeat(64), copy: '.workflow/state/originals/CLAUDE.md' }, written: 'a'.repeat(64) } }, dirs: [] }],
  ['a project source', { schema_version: 1, adopted: false, files: { 'src/index.js': { original: null, written: 'a'.repeat(64) } }, dirs: [] }],
  ["Git's config", { schema_version: 1, adopted: false, files: { '.git/config': { original: null, written: 'a'.repeat(64) } }, dirs: [] }],
  ['a folder DevOPs does not create', { schema_version: 1, adopted: false, files: {}, dirs: ['src'] }],
  ['another schema', { schema_version: 2, adopted: false, files: {}, dirs: [] }],
  ['an extra key', { schema_version: 1, adopted: false, files: {}, dirs: [], run: 'x' }],
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

  test(`init, too, refuses a committed manifest with ${label} and changes nothing (${SPEC}#ac-20)`, () => {
    withProject(dir => {
      assert.equal(devops(dir, 'analyze').status, 0);
      const analyzedIgnore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
      const text = JSON.stringify(manifest);
      writeFileSync(path.join(dir, MANIFEST), text);
      const r = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /install-manifest\.json has an unknown schema or a path outside the project/);
      assert.equal(readFileSync(path.join(dir, MANIFEST), 'utf8'), text);
      assert.ok(!existsSync(path.join(dir, '.claude')), 'init wrote nothing');
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), analyzedIgnore);
    });
  });
}

test(`a symlinked originals folder is refused and nothing is copied through it (${SPEC}#req-15)`, () => {
  withProject(dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-outside-')));
    try {
      mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
      symlinkSync(outside, path.join(dir, '.workflow/state/originals'));
      // analyze copies .gitignore's original first (#391), so it refuses.
      const r = devops(dir, 'analyze');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /refusing to write through a symlink in the project: \.workflow\/state\/originals/);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE, 'nothing appended after the refusal');
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`an original copy read through a symlinked originals folder is refused and its hash is not recorded (${SPEC}#ac-24)`, () => {
  withProject(dir => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-outside-')));
    try {
      // The outside file is what a read through the link would hash as the original.
      const outsideBytes = 'outside rule\n';
      writeFileSync(path.join(outside, '.gitignore'), outsideBytes);
      mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
      symlinkSync(outside, path.join(dir, '.workflow/state/originals'));
      const r = devops(dir, 'analyze');
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stderr, /refusing to write through a symlink in the project: \.workflow\/state\/originals/);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE, 'nothing appended after the refusal');
      assert.equal(readFileSync(path.join(outside, '.gitignore'), 'utf8'), outsideBytes);
      const recorded = existsSync(path.join(dir, MANIFEST)) ? readFileSync(path.join(dir, MANIFEST), 'utf8') : '';
      assert.equal(recorded.includes(sha(path.join(outside, '.gitignore'))), false, 'the outside hash is not recorded');
      assert.equal(JSON.parse(recorded || '{"files":{}}').files['.gitignore'], undefined, '.gitignore is not recorded');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

for (const edited of ['yes', false, 1, null]) {
  test(`a manifest entry with edited ${JSON.stringify(edited)} is an unknown schema (${SPEC}#ac-23)`, () => {
    withProject(dir => {
      mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
      const text = JSON.stringify({ schema_version: 1, adopted: false, dirs: [], files: { '.gitignore': { original: null, written: 'a'.repeat(64), edited } } });
      writeFileSync(path.join(dir, MANIFEST), text);
      const a = devops(dir, 'analyze');
      assert.equal(a.status, 1, a.stdout + a.stderr);
      assert.match(a.stderr, /install-manifest\.json has an unknown schema or a path outside the project/);
      assert.equal(readFileSync(path.join(dir, MANIFEST), 'utf8'), text);
    });
  });
}

test('validKey accepts only project-relative paths', () => {
  for (const key of ['a', '.claude/hooks/x.sh', 'git-hooks/pre-commit']) assert.ok(validKey(key), key);
  for (const key of ['', '/a', '../a', 'a/../b', 'a//b', './a', 'a/.', 'C:/a', 'a\\b', 'a\0b', 1, null])
    assert.ok(!validKey(key), String(key));
});

test(`a manifest started where an earlier DevOPs installed is marked adopted (${SPEC}#req-15)`, () => {
  withProject(dir => {
    // What an install by 0.6.2 or earlier leaves: files, install.log, no manifest.
    mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
    mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow/state/install.log'), '{}\n');
    writeFileSync(path.join(dir, '.claude/agents/coder.md'), 'older DevOPs copy\n');
    const a = devops(dir, 'analyze');
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /started in a project an earlier DevOPs installed into/);
    const r = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /started in a project/, 'the notice is printed once, when the manifest starts');
    const m = manifestOf(dir);
    assert.equal(m.adopted, true);
    const coder = m.files['.claude/agents/coder.md'].original;
    assert.equal(readFileSync(path.join(dir, coder.copy), 'utf8'), 'older DevOPs copy\n');
  });
});

test(`a recorded creation stays recorded when its write fails part-way, and a stale copy wins (${SPEC}#req-15)`, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-unit-')));
  try {
    const record = openManifest(dir);
    record.before('.claude/hooks/x.sh');
    mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/hooks/x.sh'), 'half');
    record.save(); // no after(): the write "failed" once the file existed
    const m = manifestOf(dir);
    assert.deepEqual(m.files['.claude/hooks/x.sh'], { original: null, written: createHash('sha256').update('half').digest('hex') });
    assert.ok(m.dirs.includes('.claude/hooks'));
    // An originals copy left behind by a lost manifest is taken as the original.
    rmSync(path.join(dir, MANIFEST));
    mkdirSync(path.join(dir, '.workflow/state/originals'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow/state/originals/AGENTS.md'), 'first');
    writeFileSync(path.join(dir, 'AGENTS.md'), 'later');
    const again = openManifest(dir);
    again.before('AGENTS.md');
    assert.equal(again.data.files['AGENTS.md'].original.sha256, createHash('sha256').update('first').digest('hex'));
    assert.throws(() => again.before('src/index.js'), /not a path DevOPs writes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`each record is on disk before the write it records, and no temp manifest is left (${SPEC}#ac-25)`, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-unit-')));
  try {
    const record = openManifest(dir);
    record.before('.claude/hooks/x.sh');
    // Killed here, before the write: the pending entry is already saved.
    assert.deepEqual(manifestOf(dir).files['.claude/hooks/x.sh'], { original: null, written: null });
    writeFileSync(path.join(dir, 'AGENTS.md'), 'theirs');
    record.before('AGENTS.md');
    assert.equal(manifestOf(dir).files['AGENTS.md'].original.sha256, createHash('sha256').update('theirs').digest('hex'));
    assert.deepEqual(readdirSync(path.join(dir, '.workflow/state')).filter(n => n.endsWith('.tmp')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ownFile allows only the paths DevOPs writes', () => {
  for (const key of ['AGENTS.md', 'CLAUDE.md', '.gitignore', HOOK_KEY, '.claude/hooks/x.sh', '.claude/skills/a/SKILL.md', '.workflow/profile.yml'])
    assert.ok(ownFile(key), key);
  for (const key of ['src/a.js', '.env', '.git/config', '.claude/settings.json', '.mcp.json', 'README.md', '.claude/hooks'])
    assert.ok(!ownFile(key), key);
});

// specs/release/npm-package.md REQ-15, AC-25 (issue #353): each recorded write is saved as
// it completes. Node runs no exit listener on SIGTERM, so the manifest must already be on
// disk when cosign blocks. The real `devops init` runs here, with a cosign that never returns.
test(`a SIGTERM during signature verification keeps the records of the files already written (${SPEC}#ac-25)`, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'install-manifest-signal-')));
  const bin = mkdtempSync(path.join(tmpdir(), 'install-manifest-cosign-'));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer/nextjs-project'), dir, { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    const a = devops(dir, 'analyze');
    assert.equal(a.status, 0, a.stderr);
    const marker = path.join(bin, 'verifying');
    writeFileSync(path.join(bin, 'cosign'), `#!/bin/sh\ntouch '${marker}'\nsleep 60\n`);
    chmodSync(path.join(bin, 'cosign'), 0o755);
    // Own process group, so the signal reaches the shell, the installer and the stalled cosign.
    const child = spawn(process.execPath, [CLI, 'init', '--no-agile-graph'], {
      cwd: dir, detached: true, stdio: 'ignore',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${STUB_BIN}${path.delimiter}${process.env.PATH}` },
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const deadline = Date.now() + 60_000;
    while (!existsSync(marker)) {
      assert.ok(Date.now() < deadline, 'init never reached signature verification');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(path.join(dir, 'AGENTS.md')), 'AGENTS.md was written before verification');
    process.kill(-child.pid, 'SIGTERM');
    await exited;
    const m = manifestOf(dir);
    assert.equal(m.files['AGENTS.md'].original, null);
    assert.equal(m.files['AGENTS.md'].written, sha(path.join(dir, 'AGENTS.md')), 'AGENTS.md is recorded with its hash');
    assert.equal(m.files['.gitignore'].written, sha(path.join(dir, '.gitignore')), '.gitignore is recorded with its hash');
    // What the interrupted run recorded is enough for uninstall to remove it.
    const u = devops(dir, 'uninstall');
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.equal(existsSync(path.join(dir, 'AGENTS.md')), false, 'uninstall removes AGENTS.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

