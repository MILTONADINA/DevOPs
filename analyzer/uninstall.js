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
//   - An entry marked `edited` (an edit made between two DevOPs writes, REQ-15) is kept
//     and reported whatever the file holds now; no original is restored over it.
//   - In an `adopted` manifest an original may be an earlier DevOPs's own copy, so
//     such a file is kept and reported for the user to check.
//   - The pre-commit hook is removed only while it still carries the DevOPs marker
//     and its recorded bytes.
//   - The `.mcp.json` server that init added (REQ-15) is removed only while its
//     sha256 still matches; every other key and server stays. A `.mcp.json` init
//     created, left with nothing else in it, is deleted.
// Nothing is followed through a symlink. A manifest Git tracks is refused: it came
// with the repository, not from an install here. Folders DevOPs created are removed when
// empty. Whatever is kept stays in the manifest, so a later uninstall can finish.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOOK_KEY, MANIFEST, ORIGINALS, readManifest, readRegular, replaceWhole, sha256 } from './install-manifest.js';
import { assertInside, present, writeInside } from './safe-write.js';

const HOOK_MARKER = '# DevOPs pre-commit hook';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Where init put the hook: the repository's own hooks folder. Init never writes
// into a core.hooksPath folder, so a hooksPath set since is not looked at.
function hookFile(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']);
  return common ? path.join(path.resolve(root, common), 'hooks', 'pre-commit') : null;
}

// The hook's real location for a log line: a path in the project, else the absolute path.
function hookShown(root) {
  const at = hookFile(root);
  if (at === null) return 'the pre-commit hook';
  const rel = path.relative(root, at);
  return rel.startsWith('..') || path.isAbsolute(rel) ? at : rel.split(path.sep).join('/');
}

// A path as one shell word: plain paths as they are, any other in single quotes.
export function shellWord(p) {
  return /^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

// The one closing line for files this run removed or restored that Git tracks.
function committedNote(base, touched) {
  if (touched.length === 0) return null;
  const tracked = git(base, ['ls-files', '--', ...touched]);
  if (!tracked) return null;
  const files = tracked.split('\n');
  const more = files.length > 5 ? ` (and ${files.length - 5} more)` : '';
  const shown = files.slice(0, 5).map(shellWord);
  return `Some files uninstall removed or restored are committed: commit the change, or run \`git checkout -- ${shown.join(' ')}\`${more} to keep the DevOPs versions.`;
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
  if (entry.edited === true) return { action: 'keep', reason: 'edited since DevOPs wrote it' };
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
    assertInside(root, path.join(root, entry.original.copy));
    copy = readRegular(path.join(root, entry.original.copy));
  } catch (error) {
    return { action: 'keep', reason: `its original copy is unreadable: ${error.message}` };
  }
  if (copy === null || sha256(copy) !== entry.original.sha256)
    return { action: 'keep', reason: `its original copy ${entry.original.copy} is missing or changed` };
  return { action: 'restore', at, bytes: copy };
}

/**
 * Decides what to do with one `.mcp.json` server that init added (REQ-15). Returns
 * { action: 'none' | 'keep' | 'remove' | 'delete', reason?, bytes? }: 'delete' removes the
 * file (init created it and nothing else is in it), 'remove' writes `bytes` back.
 */
function unlinkServer(base, name, recorded) {
  const file = path.join(base, '.mcp.json');
  // Read without following a link: a symlink or a non-file is kept and named.
  const bytes = readRegular(file);
  if (bytes === null) return { action: 'none' };
  let config = null;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* not JSON: kept below */
  }
  if (!plain(config)) return { action: 'keep', reason: '.mcp.json is not a JSON object' };
  if (config.mcpServers !== undefined && !plain(config.mcpServers)) return { action: 'keep', reason: '.mcp.json has no mcpServers object' };
  if (config.mcpServers === undefined || !Object.hasOwn(config.mcpServers, name)) return { action: 'none' };
  if (sha256(JSON.stringify(config.mcpServers[name])) !== recorded.sha256) return { action: 'keep', reason: 'edited since DevOPs wrote it' };
  delete config.mcpServers[name];
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  if (recorded.created_file && Object.keys(config).length === 0) return { action: 'delete' };
  return { action: 'remove', bytes: `${JSON.stringify(config, null, 2)}\n` };
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

/** Regular `*.tmp` files under `dir`, never through a symlink. */
function tempFilesUnder(base, dir) {
  const out = [];
  const walk = at => {
    let stat;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return;
    }
    if (stat.isDirectory()) for (const name of fs.readdirSync(at)) walk(path.join(at, name));
    else if (stat.isFile() && at.endsWith('.tmp')) out.push(at);
  };
  try {
    assertInside(base, dir);
  } catch {
    return out;
  }
  walk(dir);
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

// Uninstall's temp files sit beside the manifest, not under originals/: a symlinked
// originals folder must not stop uninstall from saving what it kept.
const STATE = '.workflow/state';
const MANIFEST_SAVE_TEMP = `${STATE}/.uninstall-manifest.tmp`;
const MCP_TEMP = `${STATE}/.uninstall-mcp.tmp`;
// Replaced whole, as install does, so an interrupted uninstall never leaves a truncated manifest.
const save = (base, data) => replaceWhole(base, MANIFEST, `${JSON.stringify(data, null, 2)}\n`, { temp: MANIFEST_SAVE_TEMP });

/** Runs the uninstall for `root`; returns the exit status. */
export function uninstall(root, { dryRun = false, log = console.log } = {}) {
  const base = path.resolve(root);
  // A manifest or originals that Git tracks came with the repository, not from an
  // install on this machine: following it could put someone else's bytes back.
  const tracked = git(base, ['ls-files', '--', MANIFEST, ORIGINALS]);
  if (tracked) {
    log(`devops uninstall: ${tracked.split('\n')[0]} is tracked by Git, so it is not this machine's install record. Run git rm --cached on it, check it, then run uninstall again.`);
    return 1;
  }
  const data = readManifest(base);
  if (data === null) {
    log(`No ${MANIFEST} here: nothing DevOPs recorded to remove.`);
    if (present(path.join(base, '.workflow/state/install.log')))
      log('An earlier DevOPs installed here before it kept a manifest; remove its files by hand.');
    return 0;
  }
  const verb = dryRun ? 'would ' : '';
  // Files this run removed or restored, for the committed-files note at the end.
  const touched = [];
  let keptCount = 0;
  let handled = 0;
  for (const key of Object.keys(data.files).sort()) {
    const entry = data.files[key];
    // The hook is shown where Git keeps it, not by its manifest key.
    const label = key === HOOK_KEY ? hookShown(base) : key;
    try {
      let step = plan(base, key, entry, data.adopted);
      // Restored by an earlier run that stopped before it updated the manifest.
      if (step.action === 'keep' && entry.original !== null && !data.adopted && key !== HOOK_KEY && entry.edited !== true) {
        const current = readRegular(path.join(base, key));
        if (current !== null && sha256(current) === entry.original.sha256) step = { action: 'none' };
      }
      if (step.action === 'keep') {
        keptCount++;
        log(`kept      ${label}: ${step.reason}`);
        continue;
      }
      if (step.action === 'remove') log(`${verb}remove    ${label}`);
      if (step.action === 'restore') log(`${verb}restore   ${label} (as it was before DevOPs)`);
      handled++;
      if (dryRun) continue;
      if (step.action === 'remove') removeRegular(step.at);
      if (step.action === 'restore') writeInside(base, key, step.bytes);
      // The hook lives in .git, which Git does not track.
      if (step.action !== 'none' && key !== HOOK_KEY) touched.push(key);
      // The manifest stops naming the file before its copy goes, so a run that stops
      // here can always be finished by running uninstall again.
      delete data.files[key];
      save(base, data);
      if (entry.original !== null) {
        const copy = path.join(base, entry.original.copy);
        assertInside(base, copy);
        if (present(copy)) removeRegular(copy);
      }
    } catch (error) {
      keptCount++;
      log(`kept      ${label}: ${error.message}`);
    }
  }
  // REQ-15: the .mcp.json server entries init added. Only that entry goes; every other key
  // and server stays. A server edited since, or a .mcp.json that is not an object, is kept.
  for (const name of Object.keys(data.mcp_servers ?? {}).sort()) {
    const recorded = data.mcp_servers[name];
    try {
      const step = unlinkServer(base, name, recorded);
      if (step.action === 'keep') {
        keptCount++;
        log(`kept      .mcp.json (the "${name}" server): ${step.reason}`);
        continue;
      }
      if (dryRun) {
        if (step.action !== 'none') log(`would remove the "${name}" server from .mcp.json`);
        if (step.action === 'delete') log('would remove .mcp.json (init created it; nothing else is in it)');
        if (step.action !== 'none') handled++;
        continue;
      }
      if (step.action !== 'none') {
        log(`remove    the "${name}" server from .mcp.json`);
        handled++;
        touched.push('.mcp.json');
        if (step.action === 'delete') {
          log('remove    .mcp.json (init created it; nothing else is in it)');
          removeRegular(path.join(base, '.mcp.json'));
        } else {
          // Replaced whole: a shared .mcp.json cut short would lose the user's other servers.
          replaceWhole(base, '.mcp.json', step.bytes, { temp: MCP_TEMP });
        }
      }
      // The record goes once the file is as it should be, so an interrupted run finishes later.
      delete data.mcp_servers[name];
      if (Object.keys(data.mcp_servers).length === 0) delete data.mcp_servers;
      if (!dryRun) save(base, data);
    } catch (error) {
      keptCount++;
      log(`kept      .mcp.json (the "${name}" server): ${error.message}`);
    }
  }
  // Recorded folders, deepest first; one that still holds anything stays.
  const dirs = [...data.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  if (dryRun) {
    for (const dir of dirs) log(`would remove ${dir}/ once empty`);
    log(`dry-run: ${handled} recorded file(s) handled, ${keptCount} kept; nothing changed.`);
    return 0;
  }
  if (keptCount === 0) {
    removeRegular(path.join(base, MANIFEST));
    // Leftovers of a write interrupted between its temp file and the rename.
    for (const file of tempFilesUnder(base, path.join(base, ORIGINALS))) removeRegular(file);
    for (const temp of [MANIFEST_SAVE_TEMP, MCP_TEMP]) {
      const file = path.join(base, temp);
      if (readRegular(file) !== null) removeRegular(file);
    }
  }
  for (const dir of emptyDirsUnder(path.join(base, ORIGINALS))) removeIfEmpty(dir);
  const left = [];
  for (const dir of dirs) {
    const full = path.join(base, dir);
    assertInside(base, full);
    if (removeIfEmpty(full)) log(`removed   ${dir}/`);
    else if (present(full)) left.push(dir);
  }
  if (keptCount > 0) {
    data.dirs = data.dirs.filter(d => left.includes(d));
    save(base, data);
    log(`${keptCount} file(s) kept; they stay in ${MANIFEST}. Check them, then run devops uninstall again.`);
    const note = committedNote(base, touched);
    if (note) log(note);
    return 0;
  }
  if (left.length) log(`Left in place (not empty): ${left.map(d => `${d}/`).join(', ')}`);
  if (data.adopted)
    log('An earlier DevOPs installed here before this manifest; a file it wrote that init never changed is not recorded, so check .claude/ and .workflow/ by hand.');
  log('DevOPs removed.');
  const note = committedNote(base, touched);
  if (note) log(note);
  return 0;
}
