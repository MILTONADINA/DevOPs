// specs/graph/agile-graph-link.md: the optional Agile Graph link. Temporary DevOps roots
// and projects with a fake engine package.json; the engine itself is never run here (CI's
// agile-graph-link job runs the real one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ENGINE, ENGINE_VERSIONS, PIN_SOURCE, PIN_TARGET, SERVER_KEY, linkAgileGraph, serverEntry, supportedNode,
} from '../analyzer/agile-graph.js';

const NEWEST = ENGINE_VERSIONS[ENGINE_VERSIONS.length - 1];

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/graph/agile-graph-link.md';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEFAULT_TOOLS = ['context_get', 'graph_neighbors', 'memory_propose', 'symbol_search'];
const NODE_OK = '26.3.0';
const NO_PATH = '';

// Separate trees, as on a real machine:
//   global/lib/node_modules/@miltonadina/devops   DevOps installed globally (devopsRoot)
//   work/project                                  the project, inside a workspace root (work)
//   elsewhere/node_modules/@agile-graph/engine    an engine reachable only through bin/
function withSetup(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agile-graph-link-')));
  try {
    const globalModules = path.join(dir, 'global', 'lib', 'node_modules');
    const devopsRoot = path.join(globalModules, '@miltonadina', 'devops');
    const workspace = path.join(dir, 'work');
    const projectRoot = path.join(workspace, 'project');
    mkdirSync(path.join(devopsRoot, path.dirname(PIN_SOURCE)), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    copyFileSync(path.join(ROOT, PIN_SOURCE), path.join(devopsRoot, PIN_SOURCE));
    const places = {
      project: path.join(projectRoot, 'node_modules'),
      workspace: path.join(workspace, 'node_modules'),
      global: globalModules,
      elsewhere: path.join(dir, 'elsewhere', 'node_modules'),
    };
    const installEngine = (where, version = NEWEST) => {
      const engineDir = path.join(places[where], ...ENGINE.split('/'));
      mkdirSync(path.join(engineDir, 'dist'), { recursive: true });
      writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ name: ENGINE, version }));
      writeFileSync(path.join(engineDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
      return engineDir;
    };
    // An `agile-graph` command on PATH, symlinked into the engine as npm links it.
    const binWith = engineDir => {
      const bin = path.join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      symlinkSync(path.join(engineDir, 'dist', 'cli.js'), path.join(bin, 'agile-graph'));
      return bin;
    };
    fn({ dir, devopsRoot, projectRoot, installEngine, binWith });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listing = dir => readdirSync(dir, { recursive: true }).map(String).sort();
const mcpJson = projectRoot => JSON.parse(readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
const link = (setup, extra = {}) => linkAgileGraph({
  projectRoot: setup.projectRoot, devopsRoot: setup.devopsRoot, nodeVersion: NODE_OK, pathEnv: NO_PATH, ...extra,
});

test(`the engine is an optional peer that includes every listed version, and the shipped pins cover only the four default tools (${SPEC}#ac-1)`, () => {
  const range = pkg.peerDependencies?.[ENGINE];
  assert.match(range ?? '', /^>=\d+\.\d+\.\d+$/, 'a lower bound only, so npm install never refuses');
  assert.deepEqual(pkg.peerDependenciesMeta?.[ENGINE], { optional: true });
  assert.ok(ENGINE_VERSIONS.length > 0 && ENGINE_VERSIONS.every(v => /^\d+\.\d+\.\d+$/.test(v)), 'exact versions');
  const parts = version => version.replace('>=', '').split('.').map(Number);
  const min = parts(range);
  for (const version of ENGINE_VERSIONS) {
    const pinned = parts(version);
    assert.ok(pinned[0] > min[0] || (pinned[0] === min[0] && (pinned[1] > min[1] || (pinned[1] === min[1] && pinned[2] >= min[2]))),
      `${version} is inside ${range}`);
  }
  const pins = JSON.parse(readFileSync(path.join(ROOT, PIN_SOURCE), 'utf8'));
  assert.deepEqual(Object.keys(pins).sort(), DEFAULT_TOOLS);
  for (const [tool, hash] of Object.entries(pins)) assert.match(hash, /^[0-9a-f]{64}$/, tool);
  for (const runTool of ['plan_create', 'plan_decompose', 'run_start', 'run_cancel', 'run_status', 'run_list', 'run_events']) {
    assert.ok(!Object.hasOwn(pins, runTool), `${runTool} must not be pinned`);
  }
  assert.ok(pkg.files.includes('analyzer/') && pkg.files.includes('mcp-configs/'), 'the link module and the pins ship');
});

test(`the manual MCP template uses cloud mode, the pins, no optional tools and no feedback (${SPEC}#ac-1)`, () => {
  const template = JSON.parse(readFileSync(path.join(ROOT, 'mcp-configs/universal/agile-graph.json'), 'utf8'));
  assert.deepEqual(template.args, serverEntry('command').args);
  assert.deepEqual(template.env, { GRAPH_ENGINE_NO_FEEDBACK: '1' });
  assert.ok(!template.args.some(arg => arg.startsWith('--allow')));
});

test(`only Node 24 to 26 is supported (${SPEC}#ac-2)`, () => {
  for (const ok of ['24.0.0', '25.1.0', '26.3.0', 'v24.11.1']) assert.equal(supportedNode(ok), true, ok);
  for (const no of ['22.12.0', '23.9.0', '27.0.0', 'nonsense']) assert.equal(supportedNode(no), false, no);
});

test(`without the engine, at another version, on Node 22 or 27, or with --no-agile-graph, nothing is written (${SPEC}#ac-2)`, () => {
  const cases = [
    { name: 'missing', setup: () => {}, extra: {}, reason: /not installed/ },
    { name: 'unlisted version', setup: s => s.installEngine('project', '0.2.0'), extra: {}, reason: /links only/ },
    { name: 'Node 22', setup: s => s.installEngine('project'), extra: { nodeVersion: '22.12.0' }, reason: /Node 24 to 26/ },
    { name: 'Node 27', setup: s => s.installEngine('project'), extra: { nodeVersion: '27.0.0' }, reason: /Node 24 to 26/ },
    { name: 'skip flag', setup: s => s.installEngine('project'), extra: { skip: true }, reason: /--no-agile-graph/ },
  ];
  for (const c of cases) {
    withSetup(setup => {
      c.setup(setup);
      const before = listing(setup.projectRoot);
      const result = link(setup, c.extra);
      assert.equal(result.status, 'skipped', c.name);
      assert.equal(result.lines.length, 1, c.name);
      assert.match(result.lines[0], c.reason, c.name);
      assert.deepEqual(listing(setup.projectRoot), before, `${c.name}: nothing written`);
    });
  }
});

test(`an unwritable .mcp.json leaves no pins behind and reports that nothing was linked (${SPEC}#ac-2)`, { skip: process.getuid?.() === 0 && 'root ignores file modes' }, () => {
  withSetup(setup => {
    setup.installEngine('project');
    const mcp = path.join(setup.projectRoot, '.mcp.json');
    writeFileSync(mcp, '{}\n');
    chmodSync(mcp, 0o444);
    try {
      const result = link(setup);
      assert.equal(result.status, 'kept');
      assert.match(result.lines.join('\n'), /not writable[\s\S]*not linked/);
      assert.ok(!existsSync(path.join(setup.projectRoot, PIN_TARGET)), 'no pins left behind');
      assert.equal(readFileSync(mcp, 'utf8'), '{}\n');
    } finally {
      chmodSync(mcp, 0o644);
    }
  });
});

test(`a failed .mcp.json write after the pins were copied takes the pins back (${SPEC}#ac-2)`, () => {
  withSetup(setup => {
    setup.installEngine('project');
    // A .mcp.json symlink into a missing folder: the folder above is writable, the write is not.
    symlinkSync(path.join(setup.projectRoot, 'missing', 'mcp.json'), path.join(setup.projectRoot, '.mcp.json'));
    const result = link(setup);
    assert.equal(result.status, 'kept');
    assert.match(result.lines.join('\n'), /could not write the link \(ENOENT\); not linked/);
    assert.ok(!existsSync(path.join(setup.projectRoot, PIN_TARGET)), 'the copied pins were taken back');
  });
});

test(`every listed engine version links (${SPEC}#ac-3)`, () => {
  for (const version of ENGINE_VERSIONS) {
    withSetup(setup => {
      setup.installEngine('project', version);
      assert.equal(link(setup).status, 'linked', version);
    });
  }
});

test(`with the engine in the project, .mcp.json gains the pinned cloud entry and the pins are copied (${SPEC}#ac-3)`, () => {
  withSetup(setup => {
    setup.installEngine('project');
    const result = link(setup);
    assert.equal(result.status, 'linked');
    const entry = mcpJson(setup.projectRoot).mcpServers[SERVER_KEY];
    assert.deepEqual(entry, {
      type: 'stdio', command: 'npx',
      args: ['--no-install', 'agile-graph', '-C', '.', 'mcp', '--client', 'cloud', '--tool-hashes', PIN_TARGET],
      env: { GRAPH_ENGINE_NO_FEEDBACK: '1' },
    });
    assert.deepEqual(readFileSync(path.join(setup.projectRoot, PIN_TARGET)), readFileSync(path.join(ROOT, PIN_SOURCE)));
    const next = result.lines.join('\n');
    assert.match(next, /GRAPH_ENGINE_NO_FEEDBACK=1 npx --no-install agile-graph -C \. init --cloud-mcp --export/);
    assert.match(next, /GRAPH_ENGINE_NO_FEEDBACK=1 npx --no-install agile-graph -C \. index --lexical/);
    assert.ok(!existsSync(path.join(setup.projectRoot, '.graph')), 'the installer never runs agile-graph init');
  });
});

test(`a workspace root's engine runs through npx; a global or PATH engine runs the agile-graph command (${SPEC}#ac-3)`, () => {
  const cases = [
    { name: 'workspace root', prepare: s => { s.installEngine('workspace'); return {}; }, command: 'npx' },
    { name: 'global, next to DevOps', prepare: s => { s.installEngine('global'); return {}; }, command: 'agile-graph' },
    { name: 'on PATH only', prepare: s => ({ pathEnv: s.binWith(s.installEngine('elsewhere')) }), command: 'agile-graph' },
  ];
  for (const c of cases) {
    withSetup(setup => {
      const extra = c.prepare(setup);
      const result = link(setup, extra);
      assert.equal(result.status, 'linked', c.name);
      const entry = mcpJson(setup.projectRoot).mcpServers[SERVER_KEY];
      assert.equal(entry.command, c.command, c.name);
      assert.deepEqual(entry.args.slice(-7), ['-C', '.', 'mcp', '--client', 'cloud', '--tool-hashes', PIN_TARGET], c.name);
    });
  }
  withSetup(setup => {
    const result = link(setup, { pathEnv: setup.binWith(setup.installEngine('elsewhere', '0.2.0')) });
    assert.equal(result.status, 'skipped', 'a PATH engine at another version is not linked');
  });
});

test(`--dry-run reports the link and writes nothing (${SPEC}#ac-3)`, () => {
  withSetup(setup => {
    setup.installEngine('project');
    const before = listing(setup.projectRoot);
    const result = link(setup, { dryRun: true });
    assert.equal(result.status, 'linked');
    assert.match(result.lines.join('\n'), /would copy[\s\S]*would register/);
    assert.deepEqual(listing(setup.projectRoot), before);
  });
});

test(`other servers and keys in .mcp.json are kept when the entry is added (${SPEC}#ac-4)`, () => {
  withSetup(setup => {
    setup.installEngine('project');
    const other = { command: 'other-server', args: ['--flag'] };
    writeFileSync(path.join(setup.projectRoot, '.mcp.json'), JSON.stringify({ $schema: 'x', mcpServers: { other } }));
    assert.equal(link(setup).status, 'linked');
    const config = mcpJson(setup.projectRoot);
    assert.equal(config.$schema, 'x');
    assert.deepEqual(config.mcpServers.other, other);
    assert.ok(config.mcpServers[SERVER_KEY]);
  });
});

test(`an existing agile-graph entry, an unreadable .mcp.json and existing pins are left alone (${SPEC}#ac-4)`, () => {
  const kept = [
    { name: 'existing entry', mcp: JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: 'mine' } } }) },
    { name: 'not JSON', mcp: '{ "mcpServers": ' },
    { name: 'array', mcp: '[]' },
    { name: 'mcpServers array', mcp: '{"mcpServers": []}' },
  ];
  for (const c of kept) {
    withSetup(setup => {
      setup.installEngine('project');
      writeFileSync(path.join(setup.projectRoot, '.mcp.json'), c.mcp);
      const result = link(setup);
      assert.equal(result.status, 'kept', c.name);
      assert.equal(readFileSync(path.join(setup.projectRoot, '.mcp.json'), 'utf8'), c.mcp, `${c.name}: unchanged`);
      assert.ok(!existsSync(path.join(setup.projectRoot, PIN_TARGET)), `${c.name}: no pins copied`);
    });
  }
  withSetup(setup => {
    setup.installEngine('project');
    mkdirSync(path.join(setup.projectRoot, '.claude'), { recursive: true });
    const reviewed = '{"context_get":"' + 'a'.repeat(64) + '"}\n';
    writeFileSync(path.join(setup.projectRoot, PIN_TARGET), reviewed);
    const result = link(setup);
    assert.equal(result.status, 'linked');
    assert.equal(readFileSync(path.join(setup.projectRoot, PIN_TARGET), 'utf8'), reviewed, 'existing pins kept');
    assert.match(result.lines.join('\n'), /kept your .*differs/);
  });
});

test(`devops init runs the link: one line without the engine, the skip flag honoured, exit 0 (${SPEC}#ac-2)`, () => {
  withSetup(setup => {
    const { devopsRoot, projectRoot } = setup;
    for (const file of ['AGENTS.md', 'CLAUDE.md']) copyFileSync(path.join(ROOT, file), path.join(devopsRoot, file));
    const manifest = path.join(devopsRoot, 'empty-manifest.yml');
    writeFileSync(manifest, 'skills:\n');
    mkdirSync(path.join(projectRoot, '.workflow'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.workflow/profile.yml'), 'skills:\nhooks:\nsubagents:\n');
    // PATH holds only a link to node. npm puts global commands next to node, so node's own
    // folder could hold a globally installed agile-graph.
    const nodeOnly = path.join(setup.dir, 'node-only');
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const env = { ...process.env, DEVOPS_ROOT: devopsRoot, PATH: nodeOnly };
    const run = (...extra) => spawnSync(process.execPath,
      [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/install.ts'), '--target', projectRoot, '--manifest', manifest, ...extra],
      { cwd: projectRoot, env, encoding: 'utf8', timeout: 30_000 });

    const absent = run('--dry-run');
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.stdout.split('\n').filter(line => line.startsWith('Agile Graph:')).length, 1);
    assert.match(absent.stdout, /Agile Graph: not installed \(optional\)/);

    setup.installEngine('project');
    const skipped = run('--no-agile-graph');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /Agile Graph: skipped \(--no-agile-graph\)/);
    assert.ok(!existsSync(path.join(projectRoot, '.mcp.json')));

    const linked = run();
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(linked.stdout, /Installation complete/);
    if (supportedNode(process.versions.node)) {
      assert.match(linked.stdout, /registered the MCP server "agile-graph" in \.mcp\.json/);
      assert.equal(mcpJson(projectRoot).mcpServers[SERVER_KEY].command, 'npx');
    } else {
      assert.match(linked.stdout, /needs Node 24 to 26/);
      assert.ok(!existsSync(path.join(projectRoot, '.mcp.json')));
    }
  });
});

test(`devops help lists --no-agile-graph (${SPEC}#ac-2)`, () => {
  const help = spawnSync(process.execPath, [path.join(ROOT, 'scripts/devops-cli.js'), 'help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--no-agile-graph/);
});

test(`/sprint describes the Agile Graph cycle, its prerequisites and the fallback (${SPEC}#ac-6)`, () => {
  const sprint = readFileSync(path.join(ROOT, 'slash-commands/universal/sprint.md'), 'utf8');
  const section = sprint.slice(sprint.indexOf('## With Agile Graph'));
  assert.ok(sprint.includes('## With Agile Graph'), 'the section exists');
  assert.ok(sprint.includes('Sprint runs use Agile Graph (MIT, https://github.com/MILTONADINA/agile-graph) when it is installed.'));
  for (const needed of ['.graph/project.json', ' plan ', ' run ', ' inspect ', ' accept ', ' reject ', 'check-add', 'provider-add', 'Docker',
    'graph-preflight.sh', 'graph-halt', 'deploy gate', '--allow-run', 'ENGINE_VERSIONS']) {
    assert.ok(section.includes(needed), `mentions ${needed.trim()}`);
  }
  assert.match(section, /`plan` refuses without a permitted worker/);
  assert.match(section, /Otherwise[\s\S]*Workflow/, 'falls back to the existing pipeline');
});

test(`every documented agile-graph command turns feedback off (${SPEC}#ac-6)`, () => {
  for (const file of ['README.md', 'slash-commands/universal/sprint.md', 'mcp-configs/README.md', 'mcp-configs/universal/agile-graph.json']) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    let count = 0;
    for (let at = text.indexOf('agile-graph -C '); at !== -1; at = text.indexOf('agile-graph -C ', at + 1)) {
      count++;
      const before = text.slice(Math.max(0, text.lastIndexOf('\n', at) + 1, at - 60), at);
      assert.match(before, /GRAPH_ENGINE_NO_FEEDBACK=1 (npx --no-install )?$/, `${file}: ${text.slice(at - 30, at + 40)}`);
    }
    assert.ok(count > 0, `${file} documents at least one command`);
  }
});
