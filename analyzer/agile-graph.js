// analyzer/agile-graph.js
//
// specs/graph/agile-graph-link.md REQ-1..REQ-5: when the pinned Agile Graph engine is
// installed, register its MCP server for Claude Code in the project's .mcp.json, with
// pinned tool definitions and feedback off. It never runs `agile-graph init` or `index`:
// those decide what leaves the machine, so the person runs them.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ENGINE = '@agile-graph/engine';
// The engine version whose tools PIN_SOURCE pins. Bump the two together (REQ-1).
export const ENGINE_VERSION = '0.1.0';
export const SERVER_KEY = 'agile-graph';
export const PIN_SOURCE = 'mcp-configs/universal/agile-graph.tool-hashes.json';
export const PIN_TARGET = '.claude/agile-graph-tool-hashes.json';
export const NO_FEEDBACK = { GRAPH_ENGINE_NO_FEEDBACK: '1' };

// The engine's own engines range: Node 24 or later, below 27.
export function supportedNode(version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return Number.isInteger(major) && major >= 24 && major < 27;
}

function engineAt(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return pkg.name === ENGINE && typeof pkg.version === 'string' ? { version: pkg.version } : null;
  } catch {
    return null;
  }
}

function engineAbove(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const found = engineAt(path.join(dir, 'node_modules', ...ENGINE.split('/')));
    if (found) return found;
    if (path.dirname(dir) === dir) return null;
  }
}

// An `agile-graph` command on PATH is a symlink into the engine package (dist/cli.js).
function engineOnPath(pathEnv) {
  for (const dir of String(pathEnv ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      const cli = fs.realpathSync(path.join(dir, 'agile-graph'));
      const found = engineAt(path.dirname(path.dirname(cli)));
      if (found) return found;
    } catch { /* not in this directory */ }
  }
  return null;
}

// REQ-3. In the project or a folder above it (a workspace root): run it with
// `npx --no-install`, which resolves those same folders. Otherwise next to DevOps (a
// global install) or on PATH: run the `agile-graph` command.
export function findEngine(projectRoot, devopsRoot, pathEnv = process.env.PATH) {
  const local = engineAbove(projectRoot);
  if (local) return { ...local, via: 'project' };
  const beside = engineAbove(devopsRoot) ?? engineOnPath(pathEnv);
  return beside ? { ...beside, via: 'command' } : null;
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

// The file itself when it exists, else the nearest folder that does (it would be created).
function writable(file) {
  let target = file;
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the engine for one project. Returns { status, lines }: status is "linked",
 * "kept" (something already there was left alone, or could not be written) or
 * "skipped"; lines are for the user. It never throws for a project it cannot change.
 */
export function linkAgileGraph({
  projectRoot, devopsRoot, dryRun = false, skip = false, nodeVersion = process.versions.node, pathEnv = process.env.PATH,
}) {
  const done = (status, ...lines) => ({ status, lines });
  if (skip) return done('skipped', 'Agile Graph: skipped (--no-agile-graph).');
  const engine = findEngine(projectRoot, devopsRoot, pathEnv);
  if (!engine) {
    return done('skipped', `Agile Graph: not installed (optional). To link it, install ${ENGINE}@${ENGINE_VERSION} and run devops init again.`);
  }
  if (engine.version !== ENGINE_VERSION) {
    return done('skipped', `Agile Graph: found ${ENGINE}@${engine.version}, but this DevOps pins ${ENGINE_VERSION}; not linked.`);
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
  const pinSource = path.join(devopsRoot, PIN_SOURCE);
  const pinTarget = path.join(projectRoot, PIN_TARGET);
  const copyPins = !fs.existsSync(pinTarget);
  if (!dryRun && (!writable(mcpFile) || (copyPins && !writable(pinTarget)))) {
    return done('kept', 'Agile Graph: .mcp.json or .claude/ is not writable; left unchanged, not linked.');
  }

  const lines = [];
  if (!copyPins) {
    const same = fs.readFileSync(pinTarget).equals(fs.readFileSync(pinSource));
    lines.push(same
      ? `Agile Graph: ${PIN_TARGET} is already in place.`
      : `Agile Graph: kept your ${PIN_TARGET}; it differs from the pins this DevOps ships (${PIN_SOURCE}).`);
  }
  const entry = serverEntry(engine.via);
  if (dryRun) {
    if (copyPins) lines.push(`Agile Graph: would copy the pinned tool definitions to ${PIN_TARGET}.`);
    lines.push(`Agile Graph: would register the MCP server "${SERVER_KEY}" in .mcp.json.`);
    return { status: 'linked', lines };
  }

  // Pins first, then .mcp.json; if .mcp.json cannot be written, take back the pins this
  // run copied, so a project never holds one half of the link.
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [SERVER_KEY]: entry } };
  try {
    if (copyPins) {
      fs.mkdirSync(path.dirname(pinTarget), { recursive: true });
      fs.copyFileSync(pinSource, pinTarget, fs.constants.COPYFILE_EXCL);
    }
    try {
      fs.writeFileSync(mcpFile, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      if (copyPins) fs.rmSync(pinTarget, { force: true });
      throw error;
    }
  } catch (error) {
    return done('kept', `Agile Graph: could not write the link (${error.code ?? error.message}); left unchanged, not linked.`);
  }
  if (copyPins) lines.push(`Agile Graph: copied the pinned tool definitions to ${PIN_TARGET}.`);
  const run = engine.via === 'project' ? 'npx --no-install agile-graph' : 'agile-graph';
  lines.push(
    `Agile Graph: registered the MCP server "${SERVER_KEY}" in .mcp.json; Claude Code asks you to approve it.`,
    '  Next, choose which files Claude Code may receive, then build the index:',
    `    GRAPH_ENGINE_NO_FEEDBACK=1 ${run} -C . init --cloud-mcp --export '<glob>'`,
    `    GRAPH_ENGINE_NO_FEEDBACK=1 ${run} -C . index --lexical`,
    '  The index is a snapshot: run index again after changes, or keep `watch` running.',
  );
  return { status: 'linked', lines };
}
