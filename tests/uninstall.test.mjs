// specs/release/npm-package.md REQ-16, AC-21 (issue #353): `devops uninstall`
// removes what init and analyze recorded and restores what was there before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubGit } from './fixtures/stub-git.mjs';
import { HOOK_KEY, MANIFEST } from '../analyzer/install-manifest.js';
import { ENGINE, ENGINE_VERSIONS, PIN_TARGET, SERVER_KEY, supportedNode } from '../analyzer/agile-graph.js';
import { shellWord } from '../analyzer/uninstall.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/devops-cli.js');
const SPEC = 'specs/release/npm-package.md';
const UNSIGNED = ['--allow-unsigned', '--rationale=uninstall test without cosign'];
// Tests never run the real git (tests/hermeticity.test.mjs).
const STUB_BIN = mkdtempSync(path.join(tmpdir(), 'uninstall-git-'));
writeStubGit(STUB_BIN);
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));
const devopsWith = (env, cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH}` },
});
const devops = (cwd, ...args) => devopsWith({}, cwd, ...args);
const USER_CLAUDE = '# Our own notes\n\nKeep this.\n';
const GITIGNORE = 'node_modules/\n';

function withProject(fn, { claude = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-353-')));
  try {
    cpSync(path.join(ROOT, 'tests/fixtures/analyzer/nextjs-project'), dir, { recursive: true });
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
    if (claude) writeFileSync(path.join(dir, 'CLAUDE.md'), USER_CLAUDE);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function install(dir) {
  const a = devops(dir, 'analyze');
  assert.equal(a.status, 0, a.stderr);
  const r = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
/** Every file below `dir` with its bytes; folders are listed with a trailing slash. */
function snapshot(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (e.isFile()) out[rel] = readFileSync(path.join(dir, rel), 'utf8');
    else if (e.isDirectory() && !rel.startsWith('.git')) out[`${rel}/`] = '';
  }
  return out;
}
const uninstall = (dir, ...args) => devops(dir, 'uninstall', ...args);

test(`uninstall after analyze and init leaves the project as it was (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    install(dir);
    assert.ok(existsSync(path.join(dir, '.git/hooks/pre-commit')), 'init installed the hook');
    assert.equal(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), USER_CLAUDE, 'init keeps a CLAUDE.md the project has');
    assert.notEqual(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE, 'init changed .gitignore');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restore {3}\.gitignore/);
    assert.match(r.stdout, /DevOPs removed\./);
    assert.deepEqual(snapshot(dir), before);
  });
});

test(`a dry run reports the plan and changes nothing (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const installed = snapshot(dir);
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would remove {4}\.claude\//);
    assert.match(r.stdout, /would restore {3}\.gitignore/);
    assert.match(r.stdout, /nothing changed/);
    assert.deepEqual(snapshot(dir), installed);
  });
});

test(`an edited file is kept, reported and left in the manifest (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const agent = Object.keys(m.files).find(k => k.startsWith('.claude/agents/'));
    assert.ok(agent, 'init installed an agent');
    appendFileSync(path.join(dir, agent), '\nOur own change.\n');
    appendFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    const edited = readFileSync(path.join(dir, agent), 'utf8');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`kept {6}${agent.replace(/[.]/g, '\\.')}: edited since DevOPs wrote it`));
    assert.match(r.stdout, /kept {6}\.gitignore: edited/);
    assert.equal(readFileSync(path.join(dir, agent), 'utf8'), edited);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /dist\/\n$/);
    const left = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    assert.deepEqual(Object.keys(left.files).sort(), ['.gitignore', agent].sort());
    assert.ok(existsSync(path.join(dir, left.files['.gitignore'].original.copy)), 'the original copy is kept');
    assert.ok(!existsSync(path.join(dir, '.claude/hooks')), 'unedited files and their empty folders went');
  });
});

test(`a changed original copy is not restored (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
    const installed = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    writeFileSync(path.join(dir, m.files['.gitignore'].original.copy), 'not what was there\n');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}\.gitignore: its original copy .* is missing or changed/);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), installed);
  });
});

test(`a recorded file replaced by a symlink is not followed (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-outside-')));
    try {
      const target = path.join(outside, 'keep.txt');
      writeFileSync(target, 'outside\n');
      unlinkSync(path.join(dir, 'AGENTS.md'));
      symlinkSync(target, path.join(dir, 'AGENTS.md'));
      const r = uninstall(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kept {6}AGENTS\.md: refusing to .*symlink/);
      assert.equal(readFileSync(target, 'utf8'), 'outside\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`a pre-commit hook that is no longer DevOPs's is kept (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const hook = path.join(dir, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho ours\n');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}\.git\/hooks\/pre-commit: edited since DevOPs wrote it/);
    assert.doesNotMatch(r.stdout, /git-hooks/, 'the manifest key is not shown');
    assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho ours\n');
  });
});

test(`uninstall names the pre-commit hook by its real path, not the manifest key (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /remove {4}\.git\/hooks\/pre-commit\n/);
    assert.doesNotMatch(r.stdout, /git-hooks/, 'the manifest key is not shown');
    assert.ok(!existsSync(path.join(dir, '.git/hooks/pre-commit')));
  });
});

test(`a removed file that Git tracks gets one closing line saying so (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const r = devopsWith({ STUB_GIT_TRACKED: '.gitignore' }, dir, 'uninstall');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restore {3}\.gitignore/);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.at(-1), 'Some files uninstall removed or restored are committed: commit the change, or run `git checkout -- .gitignore` to keep the DevOPs versions.');
  });
});

test(`no closing line when the removed files are not tracked, or nothing was removed (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const untracked = uninstall(dir);
    assert.equal(untracked.status, 0, untracked.stdout + untracked.stderr);
    assert.doesNotMatch(untracked.stdout, /committed/);
  });
  withProject(dir => {
    install(dir);
    const tracked = devopsWith({ STUB_GIT_TRACKED: '.gitignore' }, dir, 'uninstall', '--dry-run');
    assert.equal(tracked.status, 0, tracked.stdout + tracked.stderr);
    assert.doesNotMatch(tracked.stdout, /committed/, 'a dry run changes nothing, so it names nothing');
  });
});

test(`the closing line lists at most five tracked paths and counts the rest (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    // The hook lives in .git, which Git does not track, so it is never asked about.
    const tracked = Object.keys(manifestNow(dir).files).filter(key => key !== HOOK_KEY).sort();
    assert.ok(tracked.length > 6, 'the install recorded more than six files');
    const r = devopsWith({ STUB_GIT_TRACKED: tracked.join(',') }, dir, 'uninstall');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const last = r.stdout.trimEnd().split('\n').at(-1);
    const shown = tracked.slice(0, 5);
    assert.equal(last, `Some files uninstall removed or restored are committed: commit the change, or run \`git checkout -- ${shown.join(' ')}\` (and ${tracked.length - 5} more) to keep the DevOPs versions.`);
  });
});

test(`the closing line quotes a path the shell would split (${SPEC}#ac-21)`, () => {
  assert.equal(shellWord('.claude/hooks/a-b.mjs'), '.claude/hooks/a-b.mjs');
  assert.equal(shellWord('docs/my notes.md'), "'docs/my notes.md'");
  assert.equal(shellWord("it's.md"), "'it'\\''s.md'");
});

test(`in an adopted install, files with a recorded original are kept for the user to check (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.workflow/state'), { recursive: true });
    writeFileSync(path.join(dir, '.workflow/state/install.log'), '{}\n');
    install(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept {6}\.gitignore: recorded where an earlier DevOPs had installed/);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /AGENTS\.override\.md/);
    assert.ok(!existsSync(path.join(dir, '.claude/hooks')), 'files DevOPs created are still removed');
    assert.match(r.stdout, /1 file\(s\) kept|file\(s\) kept/);
  });
});

test(`without a manifest uninstall changes nothing and says so (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing DevOPs recorded to remove/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(uninstall(dir, '--force').status, 1, 'an unknown option is refused');
  });
});

test(`a manifest Git tracks is refused and nothing changes (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const installed = snapshot(dir);
    const r = devopsWith({ STUB_GIT_LS_FILES: MANIFEST }, dir, 'uninstall');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /is tracked by Git, so it is not this machine's install record/);
    assert.deepEqual(snapshot(dir), installed);
  });
});

test(`an uninstall that stops part-way is finished by running it again (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    const before = snapshot(dir);
    install(dir);
    const agents = path.join(dir, '.claude/agents');
    chmodSync(agents, 0o555); // its files cannot be removed
    try {
      const r = uninstall(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kept {6}\.claude\/agents\/[^:]+: .*(EACCES|permission denied)/i);
      assert.match(r.stdout, /restore {3}\.gitignore/);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
    } finally {
      chmodSync(agents, 0o755);
    }
    const again = uninstall(dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /DevOPs removed\./);
    assert.deepEqual(snapshot(dir), before);
  });
});

test(`a core.hooksPath set after init does not move where uninstall looks for the hook (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    mkdirSync(path.join(dir, '.husky'));
    writeFileSync(path.join(dir, '.husky/pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
    const r = devopsWith({ STUB_GIT_PATH_HOOKS: '.husky', STUB_HOOKS_PATH: '.husky' }, dir, 'uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /remove {4}\.git\/hooks\/pre-commit/);
    assert.ok(!existsSync(path.join(dir, '.git/hooks/pre-commit')));
    assert.equal(readFileSync(path.join(dir, '.husky/pre-commit'), 'utf8'), '#!/bin/sh\nnpx lint-staged\n');
  });
});

test(`a recorded file already gone is dropped, and a dry run names the folders (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    unlinkSync(path.join(dir, 'AGENTS.md'));
    const dry = uninstall(dir, '--dry-run');
    assert.match(dry.stdout, /would remove \.claude\/ once empty/);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /AGENTS\.md/);
    assert.match(r.stdout, /DevOPs removed\./);
    assert.ok(!existsSync(path.join(dir, MANIFEST)));
  });
});

const manifestNow = dir => JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));

test(`an edit made between two DevOPs runs keeps .gitignore and its user line (${SPEC}#ac-23)`, () => {
  withProject(dir => {
    const a = devops(dir, 'analyze');
    assert.equal(a.status, 0, a.stderr);
    appendFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    const i = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(i.status, 0, i.stdout + i.stderr);
    const u = uninstall(dir);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /kept {6}\.gitignore: edited since DevOPs wrote it/);
    assert.doesNotMatch(u.stdout, /restore {3}\.gitignore/);
    assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^dist\/$/m, 'the user rule survives');
    assert.equal(manifestNow(dir).files['.gitignore'].edited, true);
  });
});

test(`a file not edited between two DevOPs runs is still restored (${SPEC}#ac-23)`, () => {
  withProject(dir => {
    install(dir);
    const again = devops(dir, 'init', '--no-agile-graph', ...UNSIGNED);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(manifestNow(dir).files['.gitignore'].edited, undefined, 'no edit, no mark');
    const u = uninstall(dir);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /restore {3}\.gitignore/);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE);
  });
});

test(`an original copy read through a symlinked originals folder is kept and named, not followed (${SPEC}#ac-24)`, () => {
  withProject(dir => {
    install(dir);
    // The copy .gitignore's original lives in is moved outside and linked back in: its bytes are still right.
    const originals = path.join(dir, '.workflow/state/originals');
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-outside-')));
    try {
      cpSync(originals, outside, { recursive: true });
      rmSync(originals, { recursive: true, force: true });
      symlinkSync(outside, originals);
      const before = readFileSync(path.join(dir, '.gitignore'), 'utf8');
      const u = uninstall(dir);
      assert.equal(u.status, 0, u.stdout + u.stderr);
      assert.match(u.stdout, /kept {6}\.gitignore: its original copy is unreadable: refusing to write through a symlink in the project: \.workflow\/state\/originals/);
      assert.doesNotMatch(u.stdout, /restore {3}\.gitignore/);
      assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), before, 'the file is left as it is');
      assert.ok(manifestNow(dir).files['.gitignore'], '.gitignore stays in the manifest');
      assert.equal(readFileSync(path.join(outside, '.gitignore'), 'utf8'), GITIGNORE, 'the outside copy is untouched');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// specs/release/npm-package.md REQ-15, REQ-16, AC-26 (issue #413): the pin file and the
// .mcp.json server entry that init adds when it links Agile Graph.
const LINK_SKIP = supportedNode(process.versions.node) ? false : `the engine needs Node 24 to 26; this is ${process.versions.node}`;
const mcpPath = dir => path.join(dir, '.mcp.json');
const mcpNow = dir => JSON.parse(readFileSync(mcpPath(dir), 'utf8'));
const outsideModules = snap => Object.fromEntries(Object.entries(snap).filter(([key]) => !key.startsWith('node_modules')));
/** A stub engine in the project's node_modules: init links it and never runs it. */
function installEngine(dir) {
  const engineDir = path.join(dir, 'node_modules', ...ENGINE.split('/'));
  mkdirSync(path.join(engineDir, 'dist'), { recursive: true });
  writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ name: ENGINE, version: ENGINE_VERSIONS.at(-1) }));
  writeFileSync(path.join(engineDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
}
function installLinked(dir) {
  installEngine(dir);
  const a = devops(dir, 'analyze');
  assert.equal(a.status, 0, a.stderr);
  const r = devops(dir, 'init', ...UNSIGNED);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /registered the MCP server "agile-graph" in \.mcp\.json/);
}

test(`init links Agile Graph and uninstall removes the pin and the server, and the .mcp.json init created (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    const before = outsideModules(snapshot(dir));
    installLinked(dir);
    assert.ok(existsSync(path.join(dir, PIN_TARGET)), 'init copied the pins');
    assert.equal(mcpNow(dir).mcpServers[SERVER_KEY].command, 'npx');
    const recorded = manifestNow(dir);
    assert.equal(recorded.mcp_servers[SERVER_KEY].created_file, true);
    assert.ok(recorded.files[PIN_TARGET], 'the pin file is recorded');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /remove {4}the "agile-graph" server from \.mcp\.json/);
    assert.ok(!existsSync(path.join(dir, PIN_TARGET)), 'the pin file is gone');
    assert.ok(!existsSync(mcpPath(dir)), '.mcp.json init created is gone');
    assert.deepEqual(outsideModules(snapshot(dir)), before);
  });
});

test(`a .mcp.json that was there before keeps its other server and key after uninstall (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    const original = { mcpServers: { other: { type: 'stdio', command: 'other-tool', args: ['--flag'] } }, extraKey: { keep: true } };
    writeFileSync(mcpPath(dir), `${JSON.stringify(original, null, 2)}\n`);
    // A private .mcp.json (it can hold tokens) stays private when uninstall rewrites it.
    chmodSync(mcpPath(dir), 0o600);
    installLinked(dir);
    assert.equal(manifestNow(dir).mcp_servers[SERVER_KEY].created_file, false, 'the file was there before init');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(mcpNow(dir), original, 'the other server and the extra key are unchanged');
    assert.equal(statSync(mcpPath(dir)).mode & 0o777, 0o600, 'the rewritten .mcp.json keeps its permissions');
    assert.ok(!existsSync(path.join(dir, PIN_TARGET)), 'the pin file is gone');
  });
});

test(`an agile-graph entry edited after init is kept and named, and the manifest stays (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    installLinked(dir);
    const config = mcpNow(dir);
    config.mcpServers[SERVER_KEY].args.push('--edited-by-hand');
    writeFileSync(mcpPath(dir), `${JSON.stringify(config, null, 2)}\n`);
    const edited = readFileSync(mcpPath(dir), 'utf8');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /kept {6}\.mcp\.json \(the "agile-graph" server\): edited since DevOPs wrote it/);
    assert.equal(readFileSync(mcpPath(dir), 'utf8'), edited, 'the edited entry is left as it is');
    assert.ok(manifestNow(dir).mcp_servers[SERVER_KEY], 'its record stays in the manifest');
    assert.match(r.stdout, /file\(s\) kept/);
    assert.ok(!existsSync(path.join(dir, PIN_TARGET)), 'the unedited pin file is still removed');
  });
});

test(`a .mcp.json that is a symlink is kept and named, and its target is not touched (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    installLinked(dir);
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'uninstall-outside-')));
    try {
      const target = path.join(outside, 'mcp.json');
      writeFileSync(target, '{"mcpServers":{"agile-graph":{}}}\n');
      rmSync(mcpPath(dir));
      symlinkSync(target, mcpPath(dir));
      const r = uninstall(dir);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /kept {6}\.mcp\.json \(the "agile-graph" server\): refusing to read through a symlink/);
      assert.equal(readFileSync(target, 'utf8'), '{"mcpServers":{"agile-graph":{}}}\n');
      assert.ok(manifestNow(dir).mcp_servers[SERVER_KEY]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test(`a malformed mcp_servers value makes the manifest an unknown schema, and uninstall changes nothing (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    installLinked(dir);
    const good = manifestNow(dir);
    const hash = 'a'.repeat(64);
    const bad = [
      { [SERVER_KEY]: { sha256: 'NOT-HEX', created_file: true } },
      { [SERVER_KEY]: { sha256: hash, created_file: 'yes' } },
      { [SERVER_KEY]: { sha256: hash, created_file: true, extra: 1 } },
      { [SERVER_KEY]: { sha256: hash } },
      { '': { sha256: hash, created_file: true } },
      { [`${'x'.repeat(129)}`]: { sha256: hash, created_file: true } },
      ['not', 'an', 'object'],
    ];
    for (const value of bad) {
      writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify({ ...good, mcp_servers: value }, null, 2)}\n`);
      const installed = snapshot(dir);
      const r = uninstall(dir);
      assert.equal(r.status, 1, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /unknown schema/, JSON.stringify(value));
      assert.deepEqual(snapshot(dir), installed, 'nothing changed');
    }
  });
});

test(`a dry run names the server and the .mcp.json it would delete, and changes nothing (${SPEC}#ac-26)`, { skip: LINK_SKIP }, () => {
  withProject(dir => {
    installLinked(dir);
    const installed = snapshot(dir);
    const r = uninstall(dir, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would remove the "agile-graph" server from \.mcp\.json/);
    assert.match(r.stdout, /would remove \.mcp\.json/);
    assert.match(r.stdout, /nothing changed/);
    assert.deepEqual(snapshot(dir), installed);
  });
});

// #426: settings.json is rewritten without side effects, and only what init created is removed.
const settingsFile = dir => path.join(dir, '.claude/settings.json');
const settingsText = dir => readFileSync(settingsFile(dir), 'utf8');

test(`uninstall writes settings.json back with the tab indentation it had (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    const text = `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [] } }, null, '\t')}\n`;
    writeFileSync(settingsFile(dir), text);
    install(dir);
    assert.notEqual(settingsText(dir), text, 'init wired hooks into the file');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(settingsText(dir), text);
  });
});

test(`uninstall keeps an empty event array or hooks object that was there before init (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsFile(dir), `${JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }, null, 2)}\n`);
    install(dir);
    assert.notDeepEqual(JSON.parse(settingsText(dir)).hooks.PreToolUse, [], 'init wrote into the user array');
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(settingsText(dir)), { hooks: { PreToolUse: [], Stop: [] } });
  });
  withProject(dir => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(settingsFile(dir), '{\n  "hooks": {}\n}\n');
    install(dir);
    const r = uninstall(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(settingsText(dir)), { hooks: {} });
  });
});

test(`uninstall leaves settings.json unchanged, with its entries still recorded, when it holds an integer above 2^53 (${SPEC}#ac-21)`, () => {
  withProject(dir => {
    install(dir);
    const text = settingsText(dir).replace('{\n', '{\n  "maxTokens": 9007199254740993,\n');
    writeFileSync(settingsFile(dir), text);
    const r = uninstall(dir);
    assert.match(r.stdout, /^kept {6}\.claude\/settings\.json \(.*\): \.claude\/settings\.json has an integer above 2\^53/m);
    assert.equal(settingsText(dir), text);
    assert.ok(JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')).claude_hooks.length > 0, 'the entries stay recorded');
  });
});

