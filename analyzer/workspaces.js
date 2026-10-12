// analyzer/workspaces.js
//
// specs/ops/analyzer-detection.md REQ-2: the workspace packages of an npm, yarn or pnpm
// monorepo, so `devops analyze` detects the frameworks they depend on, not only the
// root package's.

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

// Bounds for a hostile or huge repository (the patterns come from it):
export const MAX_DEPTH = 6;          // how deep `**` reaches
export const MAX_VISITED = 20000;    // folder entries expansion may read in total
export const MAX_PACKAGES = 500;     // workspace packages that count
export const MAX_PATTERNS = 100;     // patterns read
export const MAX_PATTERN_LENGTH = 256;
export const MAX_SEGMENTS = 16;      // path segments in one pattern

// Only a regular file is read: a symlinked package.json could point outside the
// repository, or at a device such as /dev/stdin that never ends.
function readJson(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readYaml(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The workspace globs: package.json "workspaces" (an array, or yarn's { packages: [...] })
// and pnpm-workspace.yaml "packages". Over-long or excess patterns are dropped.
export function workspacePatterns(root) {
  const patterns = [];
  const pkg = readJson(path.join(root, 'package.json'));
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(declared)) patterns.push(...declared);
  const pnpm = readYaml(path.join(root, 'pnpm-workspace.yaml'));
  if (Array.isArray(pnpm?.packages)) patterns.push(...pnpm.packages);
  const usable = patterns.filter(p => typeof p === 'string' && p.trim() !== '' && p.length <= MAX_PATTERN_LENGTH);
  return [...new Set(usable)].slice(0, MAX_PATTERNS);
}

function segmentsOf(pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
  // Consecutive `**` mean the same as one.
  return segments.filter((s, i) => !(s === '**' && segments[i - 1] === '**'));
}

// Folders below `dir` that a real package can live in: no node_modules, no hidden folders,
// no symlinks (a Dirent's type is the entry's own, so a symlink is never isDirectory()).
// `budget.left` counts entries still allowed to be read; once it is spent, no folder is
// even opened.
function subdirs(dir, budget) {
  if (budget.left <= 0) return [];
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

// A relative folder path against a pattern's segments, `**` matching any number of
// folders. Memoised on (segment, part), so time is bounded by their product.
export function pathMatches(segments, parts) {
  const memo = new Map();
  const at = (s, p) => {
    const key = s * (parts.length + 1) + p;
    if (memo.has(key)) return memo.get(key);
    let ok;
    if (s === segments.length) ok = p === parts.length;
    else if (segments[s] === '**') ok = at(s + 1, p) || (p < parts.length && at(s, p + 1));
    else ok = p < parts.length && segmentMatches(segments[s], parts[p]) && at(s + 1, p + 1);
    memo.set(key, ok);
    return ok;
  };
  return at(0, 0);
}

// Every folder an include pattern names, walking the tree once per segment with each
// folder visited at most once per segment.
function expand(root, segments, budget) {
  let current = [root];
  for (const segment of segments) {
    const next = new Set();
    for (const dir of current) {
      if (segment === '**') {
        const stack = [[dir, 0]];
        while (stack.length) {
          const [d, depth] = stack.pop();
          if (next.has(d)) continue;
          next.add(d);
          if (depth < MAX_DEPTH) for (const child of subdirs(d, budget)) stack.push([child, depth + 1]);
        }
      } else {
        for (const child of subdirs(dir, budget)) if (segmentMatches(segment, path.basename(child))) next.add(child);
      }
    }
    current = [...next];
    if (current.length === 0) break;
  }
  return current;
}

/** The package.json files of the workspace packages under `root` (not the root's own). */
export function workspacePackages(root, { maxVisited = MAX_VISITED } = {}) {
  const patterns = workspacePatterns(root);
  const usable = list => list.map(segmentsOf).filter(s => s.length > 0 && s.length <= MAX_SEGMENTS && !s.includes('..'));
  const includes = usable(patterns.filter(p => !p.startsWith('!')));
  // Exclusions are matched against the folders found, not walked, so they hold whatever
  // the read budget did.
  const excludes = usable(patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)));
  const budget = { left: maxVisited };
  const include = new Set();
  for (const segments of includes) for (const dir of expand(root, segments, budget)) include.add(dir);
  const files = [];
  for (const dir of [...include].sort()) {
    if (dir === root) continue;
    const parts = path.relative(root, dir).split(path.sep);
    if (excludes.some(segments => pathMatches(segments, parts))) continue;
    const file = path.join(dir, 'package.json');
    try { if (fs.lstatSync(file).isFile()) files.push(file); } catch { /* none */ }
    if (files.length >= MAX_PACKAGES) break;
  }
  return files;
}

/** Dependencies and devDependencies of the root and every workspace package, merged. */
export function allDependencies(root) {
  const deps = Object.create(null);
  for (const file of [path.join(root, 'package.json'), ...workspacePackages(root)]) {
    const pkg = readJson(file);
    if (!pkg) continue;
    for (const field of ['dependencies', 'devDependencies']) {
      const value = pkg[field];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const name of Object.keys(value)) deps[name] = value[name];
      }
    }
  }
  return deps;
}
