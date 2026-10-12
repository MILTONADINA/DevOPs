// scripts/devops-paths.js
//
// Where the installed package lives, and how to run its TypeScript tools.
// specs/release/npm-package.md REQ-2 and REQ-3.
//
// npm installs each `bin` as a symlink in node_modules/.bin. Node resolves the main
// module's symlinks before it runs it, so `import.meta.url` here is the real file
// inside the package, wherever npm put it: a project's node_modules, the global
// prefix, or the npx cache.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/** The package root: the directory holding package.json, AGENTS.md and analyzer/. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The root the commands read from. DEVOPS_ROOT overrides it for a checkout kept
 * elsewhere; unset or blank means the installed package itself.
 */
export function devopsRoot(env = process.env) {
  const configured = env.DEVOPS_ROOT;
  return configured && configured.trim() !== '' ? path.resolve(configured) : PACKAGE_ROOT;
}

/**
 * The tsx command-line entry, resolved from this package. tsx is a runtime
 * dependency, so it is present wherever the package is installed; it is never
 * looked up on PATH.
 */
export function tsxCli() {
  return createRequire(import.meta.url).resolve('tsx/cli');
}

/**
 * Run a TypeScript file from the package with the current Node and the package's
 * tsx. Returns the child's exit status (1 when it was killed by a signal).
 */
export function runTs(file, args = [], options = {}) {
  const result = spawnSync(process.execPath, [tsxCli(), file, ...args], { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
