// analyzer/agile-graph.js
//
// specs/graph/agile-graph-link.md REQ-1..REQ-5: when the pinned Agile Graph engine is
// installed, register its MCP server for Claude Code in the project's .mcp.json, with
// pinned tool definitions and feedback off. It never runs `agile-graph init` or `index`:
// those decide what leaves the machine, so the person runs them.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ENGINE = '@agile-graph/engine';
export const SERVER_KEY = 'agile-graph';
export const PIN_SOURCE = 'mcp-configs/universal/agile-graph.tool-hashes.json';
export const PIN_TARGET = '.claude/agile-graph-tool-hashes.json';
export const NO_FEEDBACK = { GRAPH_ENGINE_NO_FEEDBACK: '1' };

// The engine's own engines range: Node 24 or later, below 27.
export function supportedNode(version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return Number.isInteger(major) && major >= 24 && major < 27;
}

// The engine version this DevOps pins (REQ-1): its exact optional peer.
export function pinnedEngineVersion(devopsRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(devopsRoot, 'package.json'), 'utf8'));
    const version = pkg.peerDependencies?.[ENGINE];
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

function engineIn(nodeModules) {
  const file = path.join(nodeModules, ...ENGINE.split('/'), 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pkg.name === ENGINE && typeof pkg.version === 'string' ? { version: pkg.version } : null;
  } catch {
    return null;
  }
}

// The project's own node_modules first (run with `npx --no-install`), then the
// node_modules folders above where DevOps is installed, which covers a global install
// next to the engine (run with the `agile-graph` command).
export function findEngine(projectRoot, devopsRoot) {
  const local = engineIn(path.join(projectRoot, 'node_modules'));
  if (local) return { ...local, via: 'project' };
  for (let dir = path.resolve(devopsRoot); ; dir = path.dirname(dir)) {
    const found = engineIn(path.join(dir, 'node_modules'));
    if (found) return { ...found, via: 'devops' };
    if (path.dirname(dir) === dir) return null;
  }
}

// REQ-4: relative paths so a committed .mcp.json works on every clone; no optional tools.
export function serverEntry(via) {
  const args = ['-C', '.', 'mcp', '--client', 'cloud', '--tool-hashes', PIN_TARGET];
  return via === 'project'
    ? { type: 'stdio', command: 'npx', args: ['--no-install', 'agile-graph', ...args], env: { ...NO_FEEDBACK } }
    : { type: 'stdio', command: 'agile-graph', args, env: { ...NO_FEEDBACK } };
}

function readMcpJson(file) {
  if (!fs.existsSync(file)) return { config: {} };
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!plain(config) || (config.mcpServers !== undefined && !plain(config.mcpServers))) return { error: true };
    return { config };
  } catch {
    return { error: true };
  }
}

/**
 * Register the engine for one project. Returns { status, lines }: status is "linked",
 * "kept" (something already there was left alone) or "skipped"; lines are for the user.
 */
export function linkAgileGraph({ projectRoot, devopsRoot, dryRun = false, skip = false, nodeVersion = process.versions.node }) {
  const done = (status, ...lines) => ({ status, lines });
  if (skip) return done('skipped', 'Agile Graph: skipped (--no-agile-graph).');
  const wanted = pinnedEngineVersion(devopsRoot);
  if (!wanted) return done('skipped', `Agile Graph: this DevOps pins no ${ENGINE} version; not linked.`);
  const engine = findEngine(projectRoot, devopsRoot);
  if (!engine) {
    return done('skipped', `Agile Graph: not installed (optional). To link it, install ${ENGINE}@${wanted} and run devops init again.`);
  }
  if (engine.version !== wanted) {
    return done('skipped', `Agile Graph: found ${ENGINE}@${engine.version}, but this DevOps pins ${wanted}; not linked.`);
  }
  if (!supportedNode(nodeVersion)) {
    return done('skipped', `Agile Graph: the engine needs Node 24 to 26, and this is Node ${nodeVersion}; not linked.`);
  }

  const mcpFile = path.join(projectRoot, '.mcp.json');
  const { config, error } = readMcpJson(mcpFile);
  if (error) return done('kept', 'Agile Graph: .mcp.json could not be read as a JSON object; left unchanged, not linked.');
  if (config.mcpServers && Object.hasOwn(config.mcpServers, SERVER_KEY)) {
    return done('kept', `Agile Graph: .mcp.json already registers "${SERVER_KEY}"; left unchanged.`);
  }

  const lines = [];
  const pinSource = path.join(devopsRoot, PIN_SOURCE);
  const pinTarget = path.join(projectRoot, PIN_TARGET);
  if (fs.existsSync(pinTarget)) {
    const same = fs.readFileSync(pinTarget).equals(fs.readFileSync(pinSource));
    lines.push(same
      ? `Agile Graph: ${PIN_TARGET} is already in place.`
      : `Agile Graph: kept your ${PIN_TARGET}; it differs from the pins this DevOps ships (${PIN_SOURCE}).`);
  } else if (dryRun) {
    lines.push(`Agile Graph: would copy the pinned tool definitions to ${PIN_TARGET}.`);
  } else {
    fs.mkdirSync(path.dirname(pinTarget), { recursive: true });
    fs.copyFileSync(pinSource, pinTarget);
    lines.push(`Agile Graph: copied the pinned tool definitions to ${PIN_TARGET}.`);
  }

  const entry = serverEntry(engine.via);
  if (dryRun) {
    lines.push(`Agile Graph: would register the MCP server "${SERVER_KEY}" in .mcp.json.`);
    return { status: 'linked', lines };
  }
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [SERVER_KEY]: entry } };
  fs.writeFileSync(mcpFile, `${JSON.stringify(next, null, 2)}\n`);
  const run = engine.via === 'project' ? 'npx --no-install agile-graph' : 'agile-graph';
  lines.push(
    `Agile Graph: registered the MCP server "${SERVER_KEY}" in .mcp.json; Claude Code asks you to approve it.`,
    '  Next, choose which files Claude Code may receive, then build the index:',
    `    GRAPH_ENGINE_NO_FEEDBACK=1 ${run} -C . init --cloud-mcp --export '<glob>'`,
    `    GRAPH_ENGINE_NO_FEEDBACK=1 ${run} -C . index --lexical`,
  );
  return { status: 'linked', lines };
}
