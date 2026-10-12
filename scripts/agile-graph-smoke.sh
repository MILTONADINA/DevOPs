#!/usr/bin/env bash
# scripts/agile-graph-smoke.sh
#
# specs/graph/agile-graph-link.md REQ-7: install the packed DevOps and the pinned Agile
# Graph engine into an empty project, check that the shipped tool pins match the real
# engine, run `devops init`, then start exactly the MCP server it registered and list its
# tools. CI runs this on Node 24. Not shipped in the package.
#
# Usage: bash scripts/agile-graph-smoke.sh            (from the repository root)

set -euo pipefail
export GRAPH_ENGINE_NO_FEEDBACK=1   # REQ-5: the engine must never open GitHub issues here
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "agile-graph-smoke: FAIL: $*" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 24 && NODE_MAJOR < 27 )) || fail "needs Node 24 to 26 (the engine's range), not $(node --version)"
ENGINE_VERSION="$(node --input-type=module -e "import { ENGINE_VERSION } from '$ROOT/analyzer/agile-graph.js'; console.log(ENGINE_VERSION)")"
PINS="$ROOT/mcp-configs/universal/agile-graph.tool-hashes.json"

# 1. The packed DevOps and the pinned engine, installed into an empty project.
TARBALL="$WORK/$(npm pack "$ROOT" --pack-destination "$WORK" --silent)"
APP="$WORK/app"
mkdir -p "$APP"
cp -R "$ROOT/tests/fixtures/analyzer/nextjs-project/." "$APP/"
mkdir "$APP/.git"
cd "$APP"
npm install --omit=dev --no-audit --no-fund --silent "$TARBALL" "@agile-graph/engine@$ENGINE_VERSION"
export HOME="$WORK/home"
mkdir -p "$HOME"
unset DEVOPS_ROOT
BIN="$APP/node_modules/.bin"
[[ "$("$BIN/agile-graph" --version)" == "$ENGINE_VERSION" ]] || fail "agile-graph --version is not $ENGINE_VERSION"

# 2. The shipped pins equal what the real engine reports for a cloud client with no
# optional tools. The engine needs a project for this; `devops init` never creates one.
"$BIN/agile-graph" -C . init --name agile-graph-smoke > "$WORK/ag-init.log" || { cat "$WORK/ag-init.log"; fail "agile-graph init failed"; }
"$BIN/agile-graph" -C . mcp-tools --client cloud --hashes > "$WORK/hashes.json"
node -e '
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[1], "utf8")), JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
' "$WORK/hashes.json" "$PINS" || fail "the shipped pins differ from engine $ENGINE_VERSION's mcp-tools --client cloud --hashes"
echo "agile-graph-smoke: shipped pins match @agile-graph/engine@$ENGINE_VERSION"

# 3. devops init registers the server.
"$BIN/devops-analyze" > "$WORK/analyze.log" || { cat "$WORK/analyze.log"; fail "devops-analyze failed"; }
"$BIN/devops" init > "$WORK/init.log" || { cat "$WORK/init.log"; fail "devops init failed"; }
grep -q 'registered the MCP server "agile-graph" in .mcp.json' "$WORK/init.log" || { cat "$WORK/init.log"; fail "devops init did not register the server"; }
cmp -s "$PINS" .claude/agile-graph-tool-hashes.json || fail "devops init did not copy the pins"

# 4. Start exactly the command, arguments and environment devops init wrote, from the
# project root as Claude Code does, and list the tools over MCP. The server runs in its
# own process group: `npx` starts the engine as a child, so stopping only `npx` would
# leave the engine holding the pipes open.
node --input-type=module - "$APP" <<'NODE' || fail "the registered MCP server did not serve the four pinned tools"
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const project = process.argv[2];
const deadline = setTimeout(() => { console.error('agile-graph-smoke: no answer within 60 s'); process.exit(1); }, 60000);
const entry = JSON.parse(readFileSync(`${project}/.mcp.json`, 'utf8')).mcpServers['agile-graph'];
if (entry.env?.GRAPH_ENGINE_NO_FEEDBACK !== '1') throw new Error('the entry does not turn feedback off');
if (entry.args.some(arg => arg.startsWith('--allow'))) throw new Error('the entry enables optional tools');
const child = spawn(entry.command, entry.args, { cwd: project, env: { ...process.env, ...entry.env }, detached: true });
const stop = () => {
  child.stdin.end();
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
};
let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
const reply = id => new Promise((resolve, reject) => {
  const started = Date.now();
  const poll = setInterval(() => {
    const found = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?.id === id);
    if (found) { clearInterval(poll); resolve(found); }
    else if (Date.now() - started > 30000) { clearInterval(poll); reject(new Error(`no reply ${id}: ${err.trim()}`)); }
  }, 100);
});
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agile-graph-smoke', version: '0' } } });
  const init = await reply(1);
  if (init.result?.serverInfo?.name !== 'graph-engineering') throw new Error(`unexpected server: ${JSON.stringify(init)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (await reply(2)).result.tools.map(t => t.name).sort();
  const expected = ['context_get', 'graph_neighbors', 'memory_propose', 'symbol_search'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`tools: ${names.join(', ')}`);
  console.log(`agile-graph-smoke: ${entry.command} ${entry.args.join(' ')} serves ${names.join(', ')}`);
} catch (error) {
  console.error(`agile-graph-smoke: ${error.message}`);
  process.exitCode = 1;
} finally {
  stop();
  clearTimeout(deadline);
  process.exit(process.exitCode ?? 0);
}
NODE

echo "agile-graph-smoke: devops init links @agile-graph/engine@$ENGINE_VERSION"
