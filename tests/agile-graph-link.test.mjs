// specs/graph/agile-graph-link.md: the optional Agile Graph link. Temporary DevOps roots
// and projects with a fake engine package.json; the engine itself is never run here (CI's
// agile-graph-link job runs the real one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ENGINE, PIN_SOURCE, PIN_TARGET, SERVER_KEY, linkAgileGraph, pinnedEngineVersion, serverEntry, supportedNode,
} from '../analyzer/agile-graph.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SPEC = 'specs/graph/agile-graph-link.md';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PINNED = pkg.peerDependencies?.[ENGINE];
const DEFAULT_TOOLS = ['context_get', 'graph_neighbors', 'memory_propose', 'symbol_search'];
const NODE_OK = '26.3.0';

// A DevOps root (package.json + pins) and a project, inside one temporary folder, so the
// search above the DevOps root ends in that folder's own node_modules or nowhere.
function withSetup(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agile-graph-link-')));
  try {
    const devopsRoot = path.join(dir, 'lib', 'devops');
    const projectRoot = path.join(dir, 'project');
    mkdirSync(path.join(devopsRoot, path.dirname(PIN_SOURCE)), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    copyFileSync(path.join(ROOT, 'package.json'), path.join(devopsRoot, 'package.json'));
    copyFileSync(path.join(ROOT, PIN_SOURCE), path.join(devopsRoot, PIN_SOURCE));
    const installEngine = (where, version = PINNED) => {
      const base = where === 'project' ? path.join(projectRoot, 'node_modules') : path.join(dir, 'node_modules');
      const engineDir = path.join(base, ...ENGINE.split('/'));
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(path.join(engineDir, 'package.json'), JSON.stringify({ name: ENGINE, version }));
    };
    fn({ dir, devopsRoot, projectRoot, installEngine });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listing = dir => readdirSync(dir, { recursive: true }).map(String).sort();
const mcpJson = projectRoot => JSON.parse(readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));

test(`the engine is an exact optional peer, and the shipped pins cover only the four default tools (${SPEC}#ac-1)`, () => {
  assert.match(PINNED ?? '', /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
  assert.deepEqual(pkg.peerDependenciesMeta?.[ENGINE], { optional: true });
  assert.equal(pinnedEngineVersion(ROOT), PINNED);
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
  assert.deepEqual(template.args, serverEntry('devops').args);
  assert.deepEqual(template.env, { GRAPH_ENGINE_NO_FEEDBACK: '1' });
  assert.ok(!template.args.some(arg => arg.startsWith('--allow')));
});

test(`only Node 24 to 26 is supported (${SPEC}#ac-2)`, () => {
  for (const ok of ['24.0.0', '25.1.0', '26.3.0', 'v24.11.1']) assert.equal(supportedNode(ok), true, ok);
  for (const no of ['22.12.0', '23.9.0', '27.0.0', 'nonsense']) assert.equal(supportedNode(no), false, no);
});

test(`without the engine, at another version, on Node 22 or 27, or with --no-agile-graph, nothing is written (${SPEC}#ac-2)`, () => {
  const cases = [
    { name: 'missing', setup: () => {}, nodeVersion: NODE_OK, reason: /not installed/ },
    { name: 'other version', setup: e => e('project', '0.1.1'), nodeVersion: NODE_OK, reason: /pins/ },
    { name: 'Node 22', setup: e => e('project'), nodeVersion: '22.12.0', reason: /Node 24 to 26/ },
    { name: 'Node 27', setup: e => e('project'), nodeVersion: '27.0.0', reason: /Node 24 to 26/ },
    { name: 'skip flag', setup: e => e('project'), nodeVersion: NODE_OK, skip: true, reason: /--no-agile-graph/ },
  ];
  for (const c of cases) {
    withSetup(({ devopsRoot, projectRoot, installEngine }) => {
      c.setup(installEngine);
      const before = listing(projectRoot);
      const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: c.nodeVersion, skip: c.skip });
      assert.equal(result.status, 'skipped', c.name);
      assert.equal(result.lines.length, 1, c.name);
      assert.match(result.lines[0], c.reason, c.name);
      assert.deepEqual(listing(projectRoot), before, `${c.name}: nothing written`);
    });
  }
});

test(`with the engine in the project, .mcp.json gains the pinned cloud entry and the pins are copied (${SPEC}#ac-3)`, () => {
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    installEngine('project');
    const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK });
    assert.equal(result.status, 'linked');
    const entry = mcpJson(projectRoot).mcpServers[SERVER_KEY];
    assert.deepEqual(entry, {
      type: 'stdio', command: 'npx',
      args: ['--no-install', 'agile-graph', '-C', '.', 'mcp', '--client', 'cloud', '--tool-hashes', PIN_TARGET],
      env: { GRAPH_ENGINE_NO_FEEDBACK: '1' },
    });
    assert.deepEqual(readFileSync(path.join(projectRoot, PIN_TARGET)), readFileSync(path.join(ROOT, PIN_SOURCE)));
    const next = result.lines.join('\n');
    assert.match(next, /GRAPH_ENGINE_NO_FEEDBACK=1 npx --no-install agile-graph -C \. init --cloud-mcp --export/);
    assert.match(next, /GRAPH_ENGINE_NO_FEEDBACK=1 npx --no-install agile-graph -C \. index --lexical/);
    assert.ok(!existsSync(path.join(projectRoot, '.graph')), 'the installer never runs agile-graph init');
  });
});

test(`with the engine next to DevOps (a global install), the entry runs the agile-graph command (${SPEC}#ac-3)`, () => {
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    installEngine('beside-devops');
    const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK });
    assert.equal(result.status, 'linked');
    const entry = mcpJson(projectRoot).mcpServers[SERVER_KEY];
    assert.equal(entry.command, 'agile-graph');
    assert.deepEqual(entry.args, ['-C', '.', 'mcp', '--client', 'cloud', '--tool-hashes', PIN_TARGET]);
  });
});

test(`--dry-run reports the link and writes nothing (${SPEC}#ac-3)`, () => {
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    installEngine('project');
    const before = listing(projectRoot);
    const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK, dryRun: true });
    assert.equal(result.status, 'linked');
    assert.match(result.lines.join('\n'), /would copy[\s\S]*would register/);
    assert.deepEqual(listing(projectRoot), before);
  });
});

test(`other servers and keys in .mcp.json are kept when the entry is added (${SPEC}#ac-4)`, () => {
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    installEngine('project');
    const other = { command: 'other-server', args: ['--flag'] };
    writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ $schema: 'x', mcpServers: { other } }));
    assert.equal(linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK }).status, 'linked');
    const config = mcpJson(projectRoot);
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
    withSetup(({ devopsRoot, projectRoot, installEngine }) => {
      installEngine('project');
      writeFileSync(path.join(projectRoot, '.mcp.json'), c.mcp);
      const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK });
      assert.equal(result.status, 'kept', c.name);
      assert.equal(readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'), c.mcp, `${c.name}: unchanged`);
      assert.ok(!existsSync(path.join(projectRoot, PIN_TARGET)), `${c.name}: no pins copied`);
    });
  }
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    installEngine('project');
    mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const reviewed = '{"context_get":"' + 'a'.repeat(64) + '"}\n';
    writeFileSync(path.join(projectRoot, PIN_TARGET), reviewed);
    const result = linkAgileGraph({ projectRoot, devopsRoot, nodeVersion: NODE_OK });
    assert.equal(result.status, 'linked');
    assert.equal(readFileSync(path.join(projectRoot, PIN_TARGET), 'utf8'), reviewed, 'existing pins kept');
    assert.match(result.lines.join('\n'), /kept your .*differs/);
  });
});

test(`devops init runs the link: one line without the engine, the skip flag honoured, exit 0 (${SPEC}#ac-2)`, () => {
  withSetup(({ devopsRoot, projectRoot, installEngine }) => {
    for (const file of ['AGENTS.md', 'CLAUDE.md']) copyFileSync(path.join(ROOT, file), path.join(devopsRoot, file));
    const manifest = path.join(devopsRoot, 'empty-manifest.yml');
    writeFileSync(manifest, 'skills:\n');
    mkdirSync(path.join(projectRoot, '.workflow'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.workflow/profile.yml'), 'skills:\nhooks:\nsubagents:\n');
    const env = { ...process.env, DEVOPS_ROOT: devopsRoot };
    const run = (...extra) => spawnSync(process.execPath,
      [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'analyzer/install.ts'), '--target', projectRoot, '--manifest', manifest, ...extra],
      { cwd: projectRoot, env, encoding: 'utf8', timeout: 30_000 });

    const absent = run('--dry-run');
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.stdout.split('\n').filter(line => line.startsWith('Agile Graph:')).length, 1);
    assert.match(absent.stdout, /Agile Graph: not installed \(optional\)/);

    installEngine('project');
    const skipped = run('--no-agile-graph');
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /Agile Graph: skipped \(--no-agile-graph\)/);
    assert.ok(!existsSync(path.join(projectRoot, '.mcp.json')));

    const linked = run();
    assert.equal(linked.status, 0, linked.stderr);
    if (supportedNode(process.versions.node)) {
      assert.match(linked.stdout, /registered the MCP server "agile-graph" in \.mcp\.json/);
      assert.equal(mcpJson(projectRoot).mcpServers[SERVER_KEY].command, 'npx');
    } else {
      assert.match(linked.stdout, /needs Node 24 to 26/);
      assert.ok(!existsSync(path.join(projectRoot, '.mcp.json')));
    }
  });
});

test(`/sprint describes the Agile Graph cycle, its prerequisites and the fallback (${SPEC}#ac-6)`, () => {
  const sprint = readFileSync(path.join(ROOT, 'slash-commands/universal/sprint.md'), 'utf8');
  const section = sprint.slice(sprint.indexOf('## With Agile Graph'));
  assert.ok(sprint.includes('## With Agile Graph'), 'the section exists');
  assert.ok(sprint.includes('Sprint runs use Agile Graph (MIT, https://github.com/MILTONADINA/agile-graph) when it is installed.'));
  for (const needed of ['.graph/project.json', ' plan ', ' run ', ' inspect ', ' accept ', ' reject ', 'check-add', 'provider-add', 'Docker',
    'graph-preflight.sh', 'graph-halt', 'deploy gate', '--allow-run']) {
    assert.ok(section.includes(needed), `mentions ${needed.trim()}`);
  }
  assert.match(section, /Otherwise[\s\S]*Workflow/, 'falls back to the existing pipeline');
});

test(`every documented agile-graph command turns feedback off (${SPEC}#ac-6)`, () => {
  for (const file of ['README.md', 'slash-commands/universal/sprint.md', 'mcp-configs/README.md']) {
    const commands = readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter(line => /agile-graph -C /.test(line));
    assert.ok(commands.length > 0, `${file} documents at least one command`);
    for (const line of commands) assert.match(line, /GRAPH_ENGINE_NO_FEEDBACK=1/, `${file}: ${line.trim()}`);
  }
});
