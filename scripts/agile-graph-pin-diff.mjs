// scripts/agile-graph-pin-diff.mjs
//
// specs/graph/agile-graph-link.md REQ-8: compare an engine version's tool definition
// hashes (`agile-graph mcp-tools --client cloud --hashes`) with the pins DevOps ships.
// Used by scripts/agile-graph-version-check.sh in the weekly workflow; not shipped.
//
// Usage: node scripts/agile-graph-pin-diff.mjs <engine-hashes.json> <pins.json>
// Prints {"match":bool,"changed":[...],"added":[...],"removed":[...]} and exits 0.

import { readFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Tools whose hash differs, tools the engine adds, and pinned tools it no longer has. */
export function comparePins(engine, pins) {
  if (!plainObject(engine) || !plainObject(pins)) throw new Error('both inputs must be JSON objects of tool name to hash');
  const changed = Object.keys(engine).filter(tool => Object.hasOwn(pins, tool) && pins[tool] !== engine[tool]).sort();
  const added = Object.keys(engine).filter(tool => !Object.hasOwn(pins, tool)).sort();
  const removed = Object.keys(pins).filter(tool => !Object.hasOwn(engine, tool)).sort();
  return { match: changed.length + added.length + removed.length === 0, changed, added, removed };
}

// Node resolves symlinks in the main module's path, so compare real paths: run through a
// symlinked folder (macOS /var/folders, for one), the plain comparison never matched and
// the script printed nothing.
if (isMain(import.meta.url)) {
  const [engineFile, pinsFile] = process.argv.slice(2);
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(`${JSON.stringify(comparePins(read(engineFile), read(pinsFile)))}\n`);
}
