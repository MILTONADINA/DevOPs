// analyzer/uninstall.js
//
// specs/release/npm-package.md REQ-16 (#353): `devops uninstall [--dry-run]` removes
// what `devops init` and `devops analyze` recorded in the install manifest
// (REQ-15) and puts back what the project held before.
//
// Per recorded file:
//   - DevOPs created it (original null): removed when its bytes still equal what
//     DevOPs wrote; kept and reported when they were edited since.
//   - It existed before DevOPs: the original bytes are put back when the file still
//     holds what DevOPs wrote (or is gone), and only when the kept copy still has
//     the recorded sha256. An edited file is kept and reported.
//   - In an `adopted` manifest an original may be an earlier DevOPs's own copy, so
//     such a file is kept and reported for the user to check.
//   - The pre-commit hook is removed only while it still carries the DevOPs marker
//     and its recorded bytes.
// Nothing is followed through a symlink. Folders DevOPs created are removed when
// empty. Whatever is kept stays in the manifest, so a later uninstall can finish.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOOK_KEY, MANIFEST, ORIGINALS, readManifest, readRegular, sha256 } from './install-manifest.js';
import { assertInside, present, writeInside } from './safe-write.js';

const HOOK_MARKER = '# DevOPs pre-commit hook';

/** Where Git keeps this project's hooks; null outside a repository. */
function hookFile(root) {
  try {
    const dir = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dir ? path.join(path.resolve(root, dir), 'pre-commit') : null;
  } catch {
    return null;
  }
}

function hasMarker(bytes) {
  return bytes.toString('utf8').split('\n').includes(HOOK_MARKER);
}

/** Removes a regular file without following a link. */
function removeRegular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  fs.unlinkSync(file);
}

/**
 * Decides what to do with one recorded file. Returns
 * { action: 'remove' | 'restore' | 'none' | 'keep', reason?, bytes? }.
 */
function plan(root, key, entry, adopted) {
  const hook = key === HOOK_KEY;
  const at = hook ? hookFile(root) : path.join(root, key);
  if (at === null) return { action: 'keep', reason: 'the Git hooks folder could not be found' };
  let current;
  try {
    if (!hook) assertInside(root, at);
    current = readRegular(at);
  } catch (error) {
    return { action: 'keep', reason: error.message };
  }
  if (entry.written === null && current !== null)
    return { action: 'keep', reason: 'its write was never confirmed, so what it holds is unknown' };
  const unchanged = current !== null && sha256(current) === entry.written;
  if (current !== null && !unchanged) return { action: 'keep', reason: 'edited since DevOPs wrote it' };
  if (hook) {
    if (current === null) return { action: 'none', at };
    if (!hasMarker(current)) return { action: 'keep', reason: 'it is not the DevOPs hook' };
    // A hook that was there before is never the project's own: init replaces only a
    // hook carrying the DevOPs marker, so the original is an earlier DevOPs hook.
    return { action: 'remove', at };
  }
  if (entry.original === null) return current === null ? { action: 'none', at } : { action: 'remove', at };
  if (adopted)
    return { action: 'keep', reason: 'recorded where an earlier DevOPs had installed; its original may be that release\'s copy' };
  let copy;
  try {
    copy = readRegular(path.join(root, entry.original.copy));
  } catch (error) {
    return { action: 'keep', reason: `its original copy is unreadable: ${error.message}` };
  }
  if (copy === null || sha256(copy) !== entry.original.sha256)
    return { action: 'keep', reason: `its original copy ${entry.original.copy} is missing or changed` };
  return { action: 'restore', at, bytes: copy };
}

/** Empty folders under `dir` (and `dir` itself), deepest first, without following links. */
function emptyDirsUnder(dir) {
  const out = [];
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const name of fs.readdirSync(dir)) out.push(...emptyDirsUnder(path.join(dir, name)));
  out.push(dir);
  return out;
}

function removeIfEmpty(dir) {
  try {
    if (fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      return true;
    }
  } catch {
    /* gone already, or not ours to remove */
  }
  return false;
}

/** Runs the uninstall for `root`; returns the exit status. */
export function uninstall(root, { dryRun = false, log = console.log } = {}) {
  const base = path.resolve(root);
  const data = readManifest(base);
  if (data === null) {
    log(`No ${MANIFEST} here: nothing DevOPs recorded to remove.`);
    if (present(path.join(base, '.workflow/state/install.log')))
      log('An earlier DevOPs installed here before it kept a manifest; remove its files by hand.');
    return 0;
  }
  const verb = dryRun ? 'would ' : '';
  const kept = {};
  const resolved = [];
  for (const key of Object.keys(data.files).sort()) {
    const entry = data.files[key];
    const step = plan(base, key, entry, data.adopted);
    if (step.action === 'keep') {
      kept[key] = entry;
      log(`kept      ${key}: ${step.reason}`);
      continue;
    }
    if (step.action === 'remove') {
      if (!dryRun) removeRegular(step.at);
      log(`${verb}remove    ${key}`);
    } else if (step.action === 'restore') {
      if (!dryRun) writeInside(base, key, step.bytes);
      log(`${verb}restore   ${key} (as it was before DevOPs)`);
    }
    resolved.push(key);
  }
  const keptCount = Object.keys(kept).length;
  if (dryRun) {
    log(`dry-run: ${resolved.length} recorded file(s) handled, ${keptCount} kept; nothing changed.`);
    return 0;
  }
  // The originals copies of handled files are no longer needed.
  for (const key of resolved) {
    const original = data.files[key].original;
    if (original === null) continue;
    const copy = path.join(base, original.copy);
    assertInside(base, copy);
    try {
      removeRegular(copy);
    } catch {
      /* already gone */
    }
  }
  if (keptCount === 0) removeRegular(path.join(base, MANIFEST));
  for (const dir of emptyDirsUnder(path.join(base, ORIGINALS))) removeIfEmpty(dir);
  // Recorded folders, deepest first; one that still holds anything stays.
  const dirs = [...data.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  const left = [];
  for (const dir of dirs) {
    const full = path.join(base, dir);
    assertInside(base, full);
    if (removeIfEmpty(full)) log(`removed   ${dir}/`);
    else if (present(full)) left.push(dir);
  }
  if (keptCount > 0) {
    writeInside(base, MANIFEST, `${JSON.stringify({ ...data, files: kept, dirs: data.dirs.filter(d => left.includes(d)) }, null, 2)}\n`);
    log(`${keptCount} file(s) kept; they stay in ${MANIFEST}. Check them, then run devops uninstall again.`);
  } else {
    if (left.length) log(`Left in place (not empty): ${left.map(d => `${d}/`).join(', ')}`);
    if (data.adopted)
      log('An earlier DevOPs installed here before this manifest; a file it wrote that init never changed is not recorded, so check .claude/ and .workflow/ by hand.');
    log('DevOPs removed.');
  }
  return 0;
}
