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
//   - The `.claude/settings.json` hook entries init added (REQ-15, #418) are removed only
//     while the inner hook object still hashes to the recorded sha256. A matcher group,
//     event or `hooks` left empty goes; a settings.json init created, left empty, is deleted.
//     Only the entry in the group init wrote to (same event and matcher) is taken. Any command
//     still in the file afterwards, recorded or not, keeps the files under .claude/hooks/ it
//     runs, in the manifest, until that command is deleted and uninstall runs again.
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
  // -z: Git prints each path as it is, never C-quoted, so the suggested command names real files.
  const tracked = git(base, ['ls-files', '-z', '--', ...touched]);
  if (!tracked) return null;
  const files = tracked.split('\0').filter(Boolean);
  if (files.length === 0) return null;
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

/**
 * Plans the removal of the `.claude/settings.json` hook entries init added (#418). An entry goes
 * only while the inner object it names still hashes to the recorded sha256; anything else in the
 * file is kept as it is. Returns { kept: [{ entry, reason }], removed: [entry], dropped: [entry],
 * bytes, deleteFile }: `dropped` are records to forget (removed, or already gone), `bytes` is the
 * new file content (null when nothing changes), `deleteFile` when init created the file and
 * nothing else is in it.
 */
// Every hook command string in a parsed settings object.
function commandsIn(config) {
  const out = [];
  if (!plain(config) || !plain(config.hooks)) return out;
  for (const groups of Object.values(config.hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!plain(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) if (plain(hook) && typeof hook.command === 'string') out.push(hook.command);
    }
  }
  return out;
}

/**
 * The commands in .claude/settings.json as it is now, for a run with no recorded entries left (an
 * earlier run removed them, or init wrote none): a user's own entry may still run a DevOPs hook.
 * null when the file is there but cannot be read as an object; every hook file is then kept.
 */
function liveCommands(base) {
  let bytes;
  try {
    bytes = readRegular(path.join(base, SETTINGS_KEY));
  } catch {
    return null;
  }
  if (bytes === null) return [];
  let config = null;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  return plain(config) ? commandsIn(config) : null;
}

function unwireHooks(base, entries, createdFile) {
  const plan = { kept: [], removed: [], dropped: [], bytes: null, deleteFile: false, remaining: null };
  let bytes;
  try {
    bytes = readRegular(path.join(base, SETTINGS_KEY));
  } catch (error) {
    // A symlink or a non-file is kept and named; its target is not touched.
    plan.kept = entries.map(entry => ({ entry, reason: error.message }));
    return plan;
  }
  if (bytes === null) return { ...plan, dropped: [...entries] };
  let config = null;
  try {
    config = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* not JSON: kept below */
  }
  if (!plain(config)) {
    plan.kept = entries.map(entry => ({ entry, reason: `${SETTINGS_KEY} is not a JSON object` }));
    return plan;
  }
  for (const entry of entries) {
    const groups = plain(config.hooks) && Array.isArray(config.hooks[entry.event]) ? config.hooks[entry.event] : null;
    let found = null;
    for (const group of groups ?? []) {
      if (!plain(group) || !Array.isArray(group.hooks)) continue;
      // The group init wrote to: the same matcher, or none for an event without one. A user's
      // identical command in another group is theirs and stays.
      if (group.matcher !== entry.matcher) continue;
      const index = group.hooks.findIndex(hook => plain(hook) && hook.command === entry.command);
      if (index !== -1) {
        found = { group, index };
        break;
      }
    }
    if (found === null) {
      plan.dropped.push(entry);
      continue;
    }
    const inner = found.group.hooks[found.index];
    if (sha256(JSON.stringify(inner)) !== entry.sha256) {
      plan.kept.push({ entry, reason: 'edited since DevOPs wrote it' });
      continue;
    }
    // Take the entry out, then the matcher group, the event and `hooks` only when each is left empty.
    found.group.hooks.splice(found.index, 1);
    if (found.group.hooks.length === 0) groups.splice(groups.indexOf(found.group), 1);
    if (groups.length === 0) delete config.hooks[entry.event];
    if (Object.keys(config.hooks).length === 0) delete config.hooks;
    plan.removed.push(entry);
    plan.dropped.push(entry);
  }
  plan.remaining = commandsIn(config);
  if (plan.removed.length === 0) return plan;
  if (createdFile && Object.keys(config).length === 0) plan.deleteFile = true;
  else plan.bytes = `${JSON.stringify(config, null, 2)}\n`;
  return plan;
}

// The hook a run-hook.mjs command runs (its <hook-file>), or null for any other command. The
// command may end in `|| exit 2` (a pre hook).
const RUN_HOOK_NAME = / (?:pre|post) ([A-Za-z0-9._-]+) (?:stdin|command|file)(?: \|\| exit 2)?$/;
const runHookFile = command => RUN_HOOK_NAME.exec(command)?.[1] ?? null;
const hookNameOf = command => runHookFile(command) ?? /\.claude\/hooks\/([A-Za-z0-9._-]+)/.exec(command)?.[1] ?? command;
const hookLabel = entry => `the ${entry.event} hook for ${hookNameOf(entry.command)}`;

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
const SETTINGS_KEY = '.claude/settings.json';
const SETTINGS_TEMP = '.claude/settings.json.tmp';
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
  // #418: the settings.json hook entries are planned before the files, so a kept entry can keep
  // the files it still runs. A kept entry whose command runs run-hook.mjs keeps the runner and the
  // hook it names: the files loop leaves both alone, and the kept line below names them once.
  const settingsPlan = data.claude_hooks ? unwireHooks(base, data.claude_hooks, data.claude_hooks_created_file === true) : null;
  // The settings entries go before any hook file does: a run that cannot rewrite settings.json, or
  // stops part way, never leaves an active entry whose runner or hook is gone (which would block
  // every matching call).
  let settingsFailed = false;
  // #418: the settings.json hook entries init added. Only those entries go; the file is written
  // once, whole and with its permissions, and a record goes once its entry is gone or removed.
  if (data.claude_hooks) {
    const plan = settingsPlan;
    for (const { entry, reason } of plan.kept) {
      keptCount++;
      log(`kept      ${SETTINGS_KEY} (${hookLabel(entry)}): ${reason}`);
    }
    if (dryRun) {
      for (const entry of plan.removed) log(`would remove ${hookLabel(entry)} from ${SETTINGS_KEY}`);
      if (plan.deleteFile) log(`would remove ${SETTINGS_KEY} (init created it; nothing else is in it)`);
      handled += plan.removed.length;
    } else {
      try {
        for (const entry of plan.removed) log(`remove    ${hookLabel(entry)} from ${SETTINGS_KEY}`);
        if (plan.deleteFile) {
          log(`remove    ${SETTINGS_KEY} (init created it; nothing else is in it)`);
          removeRegular(path.join(base, SETTINGS_KEY));
        } else if (plan.bytes !== null) {
          // Replaced whole: the user's own settings share this file.
          replaceWhole(base, SETTINGS_KEY, plan.bytes, { temp: SETTINGS_TEMP });
        }
        handled += plan.removed.length;
        const dropped = new Set(plan.dropped);
        data.claude_hooks = data.claude_hooks.filter(entry => !dropped.has(entry));
        if (data.claude_hooks.length === 0) {
          delete data.claude_hooks;
          delete data.claude_hooks_created_file;
        }
        save(base, data);
      } catch (error) {
        keptCount++;
        settingsFailed = true;
        log(`kept      ${SETTINGS_KEY}: ${error.message}`);
      }
    }
  }
  // Every command still in settings.json after this run (or, when the file could not be read,
  // the kept entries' commands) keeps the files under .claude/hooks/ it runs, whether DevOPs
  // recorded that command or not: a command whose runner is gone blocks every matching call.
  const keptRunnerFiles = new Map(); // command -> the manifest keys it still runs
  const live = settingsPlan === null ? liveCommands(base) : null;
  const stillRun = settingsPlan === null ? (live ?? []) : (settingsPlan.remaining ?? settingsPlan.kept.map(({ entry }) => entry.command));
  // A settings.json that cannot be read may run any hook: keep them all, named once below.
  if (settingsPlan === null && live === null) stillRun.push(...Object.keys(data.files).filter(key => key.startsWith('.claude/hooks/')));
  // When settings.json could not be rewritten, the entries meant to go are still in it and still run.
  if (settingsFailed) stillRun.push(...settingsPlan.removed.map(entry => entry.command));
  for (const command of stillRun) {
    const names = new Set([...command.matchAll(/\.claude\/hooks\/([A-Za-z0-9._-]+)/g)].map(m => m[1]));
    // Unanchored: a command the user extended (`... # note`, `... ; other`) still runs the hook.
    for (const m of command.matchAll(/run-hook\.mjs"? (?:pre|post) ([A-Za-z0-9._-]+)/g)) names.add(m[1]);
    // A kept hook keeps the files it calls beside it (protect-gates.sh runs protect-gates.mjs, the
    // gate hooks run their classifier), followed until nothing new is named.
    const queue = [...names];
    while (queue.length) {
      const name = queue.pop();
      // run-hook.mjs lists every hook it may run; the command names the one it does run.
      if (name === 'run-hook.mjs') continue;
      let text;
      try {
        text = readRegular(path.join(base, '.claude/hooks', name));
      } catch {
        continue; // unreadable: the hook itself is kept, and its companions are judged on their own
      }
      if (text === null) continue;
      for (const m of text.toString('utf8').matchAll(/[A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh)\b/g)) {
        if (data.files[`.claude/hooks/${m[0]}`] !== undefined && !names.has(m[0])) {
          names.add(m[0]);
          queue.push(m[0]);
        }
      }
    }
    const keys = [...names].map(name => `.claude/hooks/${name}`).filter(key => data.files[key] !== undefined);
    if (keys.length) keptRunnerFiles.set(command, keys);
  }
  const keptRunnerKeys = new Set();
  for (const keys of keptRunnerFiles.values()) {
    const fresh = keys.filter(key => !keptRunnerKeys.has(key));
    for (const key of fresh) keptRunnerKeys.add(key);
    if (fresh.length === 0) continue;
    keptCount += fresh.length;
    log(`kept      ${fresh.join(' and ')}: an entry in ${SETTINGS_KEY} still runs ${fresh.length === 1 ? 'it' : 'them'}; delete that entry, then run devops uninstall again`);
  }
  for (const key of Object.keys(data.files).sort()) {
    if (keptRunnerKeys.has(key)) continue; // named with the kept entry above
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
