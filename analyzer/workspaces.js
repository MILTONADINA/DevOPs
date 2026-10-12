// analyzer/workspaces.js
//
// specs/ops/analyzer-detection.md REQ-2: the workspace packages of an npm, yarn or pnpm
// monorepo, so `devops analyze` detects the frameworks they depend on, not only the
// root package's.

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

// Bounds for a hostile or huge tree (the patterns come from the analyzed repository):
// how deep `**` reaches, how many folder entries expansion may read in total, and how
// many packages count.
export const MAX_DEPTH = 6;
export const MAX_VISITED = 20000;
export const MAX_PACKAGES = 500;

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The workspace globs: package.json "workspaces" (an array, or yarn's { packages: [...] })
// and pnpm-workspace.yaml "packages".
export function workspacePatterns(root) {
  const patterns = [];
  const pkg = readJson(path.join(root, 'package.json'));
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(declared)) patterns.push(...declared);
  try {
    const pnpm = YAML.parse(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
    if (Array.isArray(pnpm?.packages)) patterns.push(...pnpm.packages);
  } catch { /* no pnpm workspace file, or not readable YAML */ }
  return [...new Set(patterns.filter(p => typeof p === 'string' && p.trim() !== ''))];
}

// Folders below `dir` that a real package can live in: no node_modules and no hidden
// folders. Symlinks are skipped too (they could leave the project or loop): a Dirent's
// type is the entry's own, so a symlink to a folder is never isDirectory() here.
// `budget.left` counts folder entries still allowed to be read. Entries are read one at a
// time, so even one huge folder stops at the budget.
function subdirs(dir, budget) {
  const found = [];
  let handle;
  try {
    handle = fs.opendirSync(dir);
    let entry;
    while (budget.left > 0 && (entry = handle.readSync()) !== null) {
      budget.left--;
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        found.push(path.join(dir, entry.name));
      }
    }
  } catch {
    /* an unreadable folder holds no packages */
  } finally {
    try { handle?.closeSync(); } catch { /* already closed */ }
  }
  return found.sort();
}

// One path segment against one folder name, where `*` matches any run of characters.
// Two pointers with one backtrack point: time is at most the product of the two lengths,
// so a hostile pattern cannot blow up the way a backtracking regex can.
export function segmentMatches(segment, name) {
  let s = 0, n = 0, star = -1, resume = 0;
  while (n < name.length) {
    if (s < segment.length && segment[s] !== '*' && segment[s] === name[n]) { s++; n++; }
    else if (s < segment.length && segment[s] === '*') { star = s++; resume = n; }
    else if (star !== -1) { s = star + 1; n = ++resume; }
    else return false;
  }
  while (s < segment.length && segment[s] === '*') s++;
  return s === segment.length;
}

function expand(root, pattern, budget) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.some(s => s === '..')) return [];
  let current = [root];
  for (const segment of segments) {
    const next = [];
    for (const dir of current) {
      if (segment === '**') {
        const stack = [[dir, 0]];
        while (stack.length) {
          const [d, depth] = stack.pop();
          next.push(d);
          if (depth < MAX_DEPTH) for (const child of subdirs(d, budget)) stack.push([child, depth + 1]);
        }
      } else {
        for (const child of subdirs(dir, budget)) if (segmentMatches(segment, path.basename(child))) next.push(child);
      }
    }
    current = next;
  }
  return current;
}

/** The package.json files of the workspace packages under `root` (not the root's own). */
export function workspacePackages(root, { maxVisited = MAX_VISITED } = {}) {
  const patterns = workspacePatterns(root);
  // Exclusions first, with their own budget, so a large include cannot use up the reads
  // an exclusion needs and let an excluded package back in.
  const exclude = new Set();
  const excludeBudget = { left: maxVisited };
  for (const pattern of patterns.filter(p => p.startsWith('!'))) {
    for (const dir of expand(root, pattern.slice(1), excludeBudget)) exclude.add(dir);
  }
  const include = new Set();
  const includeBudget = { left: maxVisited };
  for (const pattern of patterns.filter(p => !p.startsWith('!'))) {
    for (const dir of expand(root, pattern, includeBudget)) include.add(dir);
  }
  const files = [];
  for (const dir of [...include].sort()) {
    if (exclude.has(dir) || dir === root) continue;
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) files.push(file);
    if (files.length >= MAX_PACKAGES) break;
  }
  return files;
}

/** Dependencies and devDependencies of the root and every workspace package, merged. */
export function allDependencies(root) {
  const deps = {};
  for (const file of [path.join(root, 'package.json'), ...workspacePackages(root)]) {
    const pkg = readJson(file);
    if (!pkg) continue;
    for (const field of ['dependencies', 'devDependencies']) {
      const value = pkg[field];
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(deps, value);
    }
  }
  return deps;
}
