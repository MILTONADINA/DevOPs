// analyzer/install-manifest.js
//
// specs/release/npm-package.md REQ-15 (#353): `devops init` and `devops analyze`
// record every file they write in `.workflow/state/install-manifest.json`, so a
// later `devops uninstall` can remove exactly those files and put back what was
// there before. Per file it keeps:
//   original  null when DevOPs created the file; else the sha256 of the bytes
//             found the first time DevOPs wrote it and a copy of them under
//             `.workflow/state/originals/`. Set once and never overwritten, so a
//             later upgrade's backup (REQ-F11) is never mistaken for it.
//   written   the sha256 of what DevOPs last wrote there; null while a write
//             that was announced has not been confirmed.
// `dirs` lists the folders DevOPs created, deepest last. `adopted` is true when
// the manifest was started in a project an earlier DevOPs had installed into
// without one: there, an `original` may be that earlier DevOPs's copy.
//
// The manifest sits in the project, so a cloned repository can commit one: every
// path in it is checked before use, and a manifest of another schema is refused.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PIN_TARGET } from './agile-graph.js';
import { UnsafeWriteError, assertInside, mkdirInside, present, replaceWholeUnique, writeInside } from './safe-write.js';

export { replaceWholeUnique };

export const MANIFEST = '.workflow/state/install-manifest.json';
export const ORIGINALS = '.workflow/state/originals';
export const MANIFEST_TEMP = `${ORIGINALS}/.install-manifest.json.tmp`;
export const SCHEMA_VERSION = 1;
// The DevOPs pre-commit hook lives in Git's hooks folder, not under the project
// root; it is recorded under this name.
export const HOOK_KEY = 'git-hooks/pre-commit';

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A project-relative path with `/` separators, no `..`, no empty or absolute part. */
export function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.startsWith('/')
    && !/^[A-Za-z]:/.test(key) && !key.includes('\\') && !key.includes('\0')
    && key.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Only where DevOPs writes. A committed manifest can therefore never name a
// project source, a secret or Git's own files for a later uninstall.
const OWN_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore', HOOK_KEY, PIN_TARGET]);
const OWN_TREES = ['.claude/skills/', '.claude/hooks/', '.claude/agents/', '.workflow/'];
export function ownFile(key) {
  return validKey(key) && (OWN_FILES.has(key) || OWN_TREES.some(tree => key.startsWith(tree)));
}
export function ownDir(key) {
  return validKey(key) && ['.claude', '.claude/skills', '.claude/hooks', '.claude/agents', '.workflow'].includes(key)
    || OWN_TREES.some(tree => validKey(key) && key.startsWith(tree));
}

/** Reads a regular file without following a link; null when it is missing. */
export function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new UnsafeWriteError(`refusing to read through a symlink: ${file}`);
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new UnsafeWriteError(`not a regular file: ${file}`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The checked manifest of `root`, or null when it has none. */
export function readManifest(root) {
  assertInside(root, path.join(root, MANIFEST));
  const bytes = readRegular(path.join(root, MANIFEST));
  if (bytes === null) return null;
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new UnsafeWriteError(`${MANIFEST} is not valid JSON; move it aside and run init again`);
  }
  const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const hex = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  // REQ-15: the server entries init added to .mcp.json, keyed by server name.
  const mcpServers = v => plain(v) && Object.entries(v).every(([name, entry]) => typeof name === 'string'
    && name.length > 0 && name.length <= 128 && plain(entry)
    && Object.keys(entry).sort().join(',') === 'created_file,sha256'
    && hex(entry.sha256) && typeof entry.created_file === 'boolean');
  // REQ-15 (#418): the hook entries init added to .claude/settings.json. `sha256` is of the
  // inner hook object. `matcher` is absent for an event that has none. `command` is one of the
  // forms init writes: a plain hook (`cd` to the project root, then bash on the hook), or a
  // hook run through run-hook.mjs (pre or post). Each names only a file under .claude/hooks/,
  // never one whose name starts with a dot (so `.` and `..` are refused). Each command is paired with the event
  // init wires it under: a pre command with PreToolUse, a post command with PostToolUse, a plain
  // one with SessionStart and no matcher. The names are not checked against a list: a manifest
  // from another DevOPs version may name a hook this one does not wire, and uninstall reads it.
  const PLAIN_HOOK = /^cd "\$\{CLAUDE_PROJECT_DIR:-\.\}" && bash \.claude\/hooks\/(?!\.)[A-Za-z0-9._-]{1,128} \|\| true$/;
  const PRE_HOOK = /^node "\$\{CLAUDE_PROJECT_DIR:-\.\}\/\.claude\/hooks\/run-hook\.mjs" pre (?!\.)[A-Za-z0-9._-]{1,128} (stdin|command|file) \|\| exit 2$/;
  const POST_HOOK = /^node "\$\{CLAUDE_PROJECT_DIR:-\.\}\/\.claude\/hooks\/run-hook\.mjs" post (?!\.)[A-Za-z0-9._-]{1,128} (stdin|command|file)$/;
  // The event a command must be wired under, or null when it is none of the three forms.
  const hookEvent = v => {
    if (typeof v !== 'string') return null;
    if (PLAIN_HOOK.test(v)) return 'SessionStart';
    if (PRE_HOOK.test(v)) return 'PreToolUse';
    if (POST_HOOK.test(v)) return 'PostToolUse';
    return null;
  };
  // No two entries may share a command: uninstall would take both away for one of them.
  const claudeHooks = v => Array.isArray(v) && v.every(entry => plain(entry)
    && ['command,event,sha256', 'command,event,matcher,sha256'].includes(Object.keys(entry).sort().join(','))
    && typeof entry.event === 'string' && /^[A-Za-z]{1,40}$/.test(entry.event)
    && (entry.matcher === undefined || (typeof entry.matcher === 'string' && entry.matcher.length <= 256))
    && hookEvent(entry.command) === entry.event
    && (entry.event !== 'SessionStart' || entry.matcher === undefined)
    && hex(entry.sha256))
    && new Set(v.map(entry => entry.command)).size === v.length;
  const ok = plain(data) && data.schema_version === SCHEMA_VERSION && plain(data.files) && Array.isArray(data.dirs)
    && typeof data.adopted === 'boolean'
    && (data.mcp_servers === undefined || mcpServers(data.mcp_servers))
    && (data.claude_hooks === undefined || claudeHooks(data.claude_hooks))
    && (data.claude_hooks_created_file === undefined || (typeof data.claude_hooks_created_file === 'boolean'
      && Array.isArray(data.claude_hooks) && data.claude_hooks.length > 0))
    // #426: the events and the `hooks` object init created, so uninstall deletes only those when emptied.
    && (data.claude_hooks_created_events === undefined || (Array.isArray(data.claude_hooks_created_events)
      && data.claude_hooks_created_events.every(e => typeof e === 'string' && /^[A-Za-z]{1,40}$/.test(e))
      && Array.isArray(data.claude_hooks) && data.claude_hooks.length > 0))
    && (data.claude_hooks_created_object === undefined || (typeof data.claude_hooks_created_object === 'boolean'
      && Array.isArray(data.claude_hooks) && data.claude_hooks.length > 0))
    && Object.keys(data).every(k => ['schema_version', 'adopted', 'files', 'dirs', 'mcp_servers', 'claude_hooks', 'claude_hooks_created_file', 'claude_hooks_created_events', 'claude_hooks_created_object'].includes(k))
    && data.dirs.every(ownDir)
    && Object.entries(data.files).every(([key, entry]) => ownFile(key) && plain(entry)
      && Object.keys(entry).every(k => ['original', 'written', 'edited'].includes(k))
      && (entry.edited === undefined || entry.edited === true)
      && (entry.written === null || hex(entry.written))
      && (entry.original === null || (plain(entry.original) && hex(entry.original.sha256)
        && entry.original.copy === `${ORIGINALS}/${key}` && Object.keys(entry.original).length === 2)));
  if (!ok) throw new UnsafeWriteError(`${MANIFEST} has an unknown schema or a path outside the project; move it aside and run init again`);
  return data;
}

/**
 * Opens the manifest of `root` for recording. Call `before(key)` just before a
 * write, `after(key)` just after it, and `save()` once at the end. Each record
 * also saves at once (keepPending), so a run killed by a signal keeps what it
 * recorded. `file` is the file's real location when it is not `root/key`
 * (the pre-commit hook).
 */
/**
 * Writes `bytes` to `target` whole: into `temp` (`target.tmp`), flushed to disk, then
 * renamed over it (or, with `exclusive`, linked to it, which fails when the
 * target exists). A signal or crash leaves the old file or the new one, never
 * part of it. An existing target's permissions are kept. A leftover `.tmp` is overwritten by the next write.
 */
export function replaceWhole(base, target, bytes, { exclusive = false, temp = `${target}.tmp` } = {}) {
  // The new file keeps the old one's permissions: a .mcp.json a user made private (0600)
  // must not come back readable by others.
  let mode;
  try {
    const stat = fs.lstatSync(path.join(base, target));
    if (stat.isFile()) mode = stat.mode & 0o7777;
  } catch {
    /* no file yet: the default mode */
  }
  writeInside(base, temp, bytes, mode === undefined ? {} : { mode });
  const tempFile = path.join(base, temp);
  const fd = fs.openSync(tempFile, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const file = path.join(base, target);
  assertInside(base, file);
  if (exclusive) {
    fs.linkSync(tempFile, file);
    fs.unlinkSync(tempFile);
  } else fs.renameSync(tempFile, file);
}

/**
 * The text to write for `config` in place of `original` (the text it was read from, or null for a
 * new file). Indented as the original is: a tab when its first indented line starts with one,
 * else that line's spaces, and 2 spaces when there is no indented line. The trailing newline is
 * kept when the original had one; a new file gets one. CRLF line ends are kept when the original's
 * first line ends in one.
 */
export function jsonText(config, original) {
  const text = original ?? null;
  const first = text === null ? null : /^([ \t]+)\S/m.exec(text);
  const indent = first === null ? '  ' : first[1].includes('\t') ? '\t' : ' '.repeat(first[1].length);
  const newline = text === null || text.endsWith('\n') ? '\n' : '';
  const out = `${JSON.stringify(config, null, indent)}${newline}`;
  return text !== null && /^[^\n]*\r\n/.test(text) ? out.replace(/\n/g, '\r\n') : out;
}

/** A number literal as sign, significant digits and exponent, so `1.50e1` and `15` compare equal. */
function decimalValue(literal) {
  const [, sign, int, frac = '', exp = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  let digits = (int + frac).replace(/^0+/, '');
  if (digits === '') return `${sign}0`;
  let power = BigInt(exp) - BigInt(frac.length);
  const trimmed = digits.replace(/0+$/, '');
  power += BigInt(digits.length - trimmed.length);
  digits = trimmed;
  return `${sign}${digits}e${power}`;
}

/**
 * True when the JSON text has a number literal outside a string that JSON.parse would not keep
 * exactly: an integer above 2^53 that rounds, a decimal with more digits than a double holds, or
 * a value too large that becomes Infinity (written back as null), or -0 (written back as 0). A
 * literal that only changes spelling, such as `1.0` or `1e2`, is kept. Text inside strings is skipped.
 */
export function hasUnsafeInteger(text) {
  const number = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    number.lastIndex = i;
    const match = ch === '-' || (ch >= '0' && ch <= '9') ? number.exec(text) : null;
    if (match === null) {
      i++;
      continue;
    }
    const literal = match[0];
    const value = Number(literal);
    if (!Number.isFinite(value) || decimalValue(literal) !== decimalValue(Object.is(value, -0) ? '0' : String(value))) return true;
    i += literal.length;
  }
  return false;
}

export const ADOPTED_NOTICE = 'Install manifest: started in a project an earlier DevOPs installed into; files that release wrote are recorded as originals.';

export function openManifest(root) {
  const base = path.resolve(root);
  // install.log is written by every init since F.06: its presence without a
  // manifest means an earlier DevOPs installed here.
  const found = readManifest(base);
  const data = found ?? {
    schema_version: SCHEMA_VERSION,
    adopted: present(path.join(base, '.workflow/state/install.log')),
    files: {},
    dirs: [],
  };
  const locate = (key, file) => {
    if (!ownFile(key)) throw new UnsafeWriteError(`not a path DevOPs writes: ${key}`);
    if (file) return file;
    const resolved = path.join(base, key);
    assertInside(base, resolved);
    return resolved;
  };
  const api = {
    before(key, file) {
      const at = locate(key, file);
      if (Object.hasOwn(data.files, key)) {
        // Bytes that differ from what DevOPs last wrote were edited by someone else.
        const entry = data.files[key];
        const now = entry.written === null ? null : readRegular(at);
        if (now !== null && sha256(now) !== entry.written) {
          entry.edited = true;
          api.save({ keepPending: true });
        }
        return;
      }
      if (!file) {
        // The folders this write will create, outermost first.
        const parts = key.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (!present(path.join(base, dir)) && !data.dirs.includes(dir)) data.dirs.push(dir);
        }
      }
      const bytes = readRegular(at);
      if (bytes === null) {
        data.files[key] = { original: null, written: null };
        // Saved before the write, so a kill mid-write leaves the file recorded.
        api.save({ keepPending: true });
        return;
      }
      // A copy left by an earlier run (its manifest since lost) is the older truth.
      const copy = `${ORIGINALS}/${key}`;
      // A symlinked folder above the copy would make the read below hash an outside file.
      assertInside(base, path.join(base, copy));
      const kept = readRegular(path.join(base, copy));
      // Written whole: a copy cut short by a signal would later be restored as the original.
      if (kept === null) replaceWhole(base, copy, bytes, { exclusive: true });
      data.files[key] = { original: { sha256: sha256(kept ?? bytes), copy }, written: null };
      api.save({ keepPending: true });
    },
    after(key, file) {
      const bytes = readRegular(locate(key, file));
      if (bytes === null) throw new UnsafeWriteError(`${key} was not written`);
      if (!Object.hasOwn(data.files, key)) throw new UnsafeWriteError(`${key} was written without being recorded first`);
      data.files[key].written = sha256(bytes);
      // Saved now, not only at exit: a SIGINT or SIGTERM skips the exit listener.
      api.save({ keepPending: true });
    },
    /**
     * Records the `.mcp.json` server entry `init` is about to write (REQ-15). `.mcp.json` itself is
     * not a recorded file: other tools share it, so only this entry is recorded.
     */
    mcpServer(name, entry, createdFile) {
      data.mcp_servers = {
        ...(data.mcp_servers ?? {}),
        [name]: { sha256: sha256(JSON.stringify(entry)), created_file: createdFile },
      };
      api.save({ keepPending: true });
    },
    /** Drops the record of a server entry whose `.mcp.json` write failed. */
    forgetMcpServer(name) {
      if (!data.mcp_servers || !Object.hasOwn(data.mcp_servers, name)) return;
      delete data.mcp_servers[name];
      if (Object.keys(data.mcp_servers).length === 0) delete data.mcp_servers;
      api.save({ keepPending: true });
    },
    /**
     * Records the `.claude/settings.json` hook entries `init` is about to add (#418). The file
     * itself is not a recorded file: the user's own settings share it. `createdFile` is kept from
     * the first record, so a later run never claims a file an earlier run found. `createdEvents`
     * are the events whose array this run created, and `createdObject` says it created `hooks`
     * (#426): uninstall deletes those only once its own removal empties them.
     */
    claudeHooks(entries, createdFile, createdEvents, createdObject) {
      const commands = new Set(entries.map(entry => entry.command));
      const legacy = data.claude_hooks_created_events === undefined && (data.claude_hooks?.length ?? 0) > 0;
      data.claude_hooks = [...(data.claude_hooks ?? []).filter(entry => !commands.has(entry.command)), ...entries];
      data.claude_hooks_created_file ??= createdFile;
      // Both are always written for a new record. A manifest that already has entries but not these
      // fields is from 0.8.x: it stays that way, so uninstall keeps that release's cleanup for the
      // arrays 0.8.x created, which this run cannot know about.
      if (!legacy) {
        data.claude_hooks_created_events = [...new Set([...(data.claude_hooks_created_events ?? []), ...createdEvents])];
        data.claude_hooks_created_object = data.claude_hooks_created_object === true || createdObject;
      }
      api.save({ keepPending: true });
    },
    /** Drops the records of settings.json hook entries whose write failed. */
    forgetClaudeHooks(commands) {
      if (!data.claude_hooks) return;
      data.claude_hooks = data.claude_hooks.filter(entry => !commands.includes(entry.command));
      if (data.claude_hooks.length === 0) {
        delete data.claude_hooks;
        delete data.claude_hooks_created_file;
        delete data.claude_hooks_created_events;
        delete data.claude_hooks_created_object;
      }
      api.save({ keepPending: true });
    },
    /** Records a folder DevOPs is about to create (with mkdir -p) when it is absent. */
    dir(key) {
      if (!ownDir(key)) throw new UnsafeWriteError(`not a folder DevOPs creates: ${key}`);
      assertInside(base, path.join(base, key));
      const parts = key.split('/');
      let added = false;
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!present(path.join(base, dir)) && !data.dirs.includes(dir)) {
          data.dirs.push(dir);
          added = true;
        }
      }
      if (added) api.save({ keepPending: true });
    },
    // An entry whose write was never confirmed is dropped, unless `keepPending`
    // (a writer in another process confirms it later).
    // A pending entry whose file is on disk gets its current hash, so a write that
    // failed part-way still leaves the created file recorded.
    save({ keepPending = false } = {}) {
      if (!keepPending)
        for (const [key, entry] of Object.entries(data.files)) {
          if (entry.written !== null || key === HOOK_KEY) continue;
          const bytes = readRegular(path.join(base, key));
          if (bytes !== null) entry.written = sha256(bytes);
          else if (entry.original === null) delete data.files[key];
        }
      // Replaced whole, so an interruption cannot leave a truncated manifest
      // that the next run would refuse.
      // The temp file sits under originals/, which .gitignore already covers.
      replaceWhole(base, MANIFEST, `${JSON.stringify(data, null, 2)}\n`, { temp: MANIFEST_TEMP });
    },
    data,
    /** True when this call started the manifest (none was on disk). */
    started: found === null,
  };
  // The manifest's own folders, recorded before anything is written into them.
  api.dir('.workflow/state');
  return api;
}

// The manifest and its originals are this machine's record: uninstall refuses
// them once Git tracks them (REQ-16), so init and analyze both keep them out of
// Git (REQ-10; #390, #391).
export const LOCAL_STATE_IGNORES = [MANIFEST, `${ORIGINALS}/`];

/**
 * Append each of `lines` that `.gitignore` lacks, keeping its bytes, line
 * endings and a missing final newline. `record` (from openManifest) records the
 * write so uninstall restores the original file. With `dryRun` nothing is
 * written. Returns the lines that were (or would be) added.
 */
export function ignoreLines(root, lines, { record, dryRun = false } = {}) {
  const file = path.join(path.resolve(root), '.gitignore');
  const ignored = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const have = new Set(ignored.split(/\r?\n/));
  const missing = lines.filter(line => !have.has(line));
  if (!missing.length || dryRun) return missing;
  const eol = ignored.match(/\r?\n/)?.[0] ?? '\n';
  record?.before('.gitignore');
  try {
    writeInside(root, file, `${ignored && !ignored.endsWith('\n') ? eol : ''}${missing.map(line => line + eol).join('')}`, { append: true });
  } finally {
    // After a failed write, save() still hashes whatever reached the disk.
    if (record && fs.existsSync(file)) record.after('.gitignore');
  }
  return missing;
}
