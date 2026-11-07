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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UnsafeWriteError, assertInside, present, writeInside } from './safe-write.js';

export const MANIFEST = '.workflow/state/install-manifest.json';
export const ORIGINALS = '.workflow/state/originals';
export const SCHEMA_VERSION = 1;
// The DevOPs pre-commit hook lives in Git's hooks folder, not under the project
// root; it is recorded under this name.
export const HOOK_KEY = 'git-hooks/pre-commit';

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A project-relative path with `/` separators, no `..`, no empty or absolute part. */
export function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.startsWith('/')
    && !/^[A-Za-z]:/.test(key) && !key.includes('\\') && !key.includes('\0')
    && key.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Only where DevOPs writes. A committed manifest can therefore never name a
// project source, a secret or Git's own files for a later uninstall.
const OWN_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore', HOOK_KEY]);
const OWN_TREES = ['.claude/skills/', '.claude/hooks/', '.claude/agents/', '.workflow/'];
export function ownFile(key) {
  return validKey(key) && (OWN_FILES.has(key) || OWN_TREES.some(tree => key.startsWith(tree)));
}
export function ownDir(key) {
  return validKey(key) && ['.claude', '.claude/skills', '.claude/hooks', '.claude/agents', '.workflow'].includes(key)
    || OWN_TREES.some(tree => validKey(key) && key.startsWith(tree));
}

/** Reads a regular file without following a link; null when it is missing. */
function readRegular(file) {
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

function parse(root) {
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
  const ok = plain(data) && data.schema_version === SCHEMA_VERSION && plain(data.files) && Array.isArray(data.dirs)
    && typeof data.adopted === 'boolean'
    && Object.keys(data).every(k => ['schema_version', 'adopted', 'files', 'dirs'].includes(k))
    && data.dirs.every(ownDir)
    && Object.entries(data.files).every(([key, entry]) => ownFile(key) && plain(entry)
      && Object.keys(entry).every(k => ['original', 'written'].includes(k))
      && (entry.written === null || hex(entry.written))
      && (entry.original === null || (plain(entry.original) && hex(entry.original.sha256)
        && entry.original.copy === `${ORIGINALS}/${key}` && Object.keys(entry.original).length === 2)));
  if (!ok) throw new UnsafeWriteError(`${MANIFEST} has an unknown schema or a path outside the project; move it aside and run init again`);
  return data;
}

/**
 * Opens the manifest of `root` for recording. Call `before(key)` just before a
 * write, `after(key)` just after it, and `save()` once at the end. `file` is the
 * file's real location when it is not `root/key` (the pre-commit hook).
 */
export const ADOPTED_NOTICE = 'Install manifest: started in a project an earlier DevOPs installed into; files that release wrote are recorded as originals.';

export function openManifest(root) {
  const base = path.resolve(root);
  // install.log is written by every init since F.06: its presence without a
  // manifest means an earlier DevOPs installed here.
  const found = parse(base);
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
      if (Object.hasOwn(data.files, key)) return;
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
        return;
      }
      // A copy left by an earlier run (its manifest since lost) is the older truth.
      const copy = `${ORIGINALS}/${key}`;
      const kept = readRegular(path.join(base, copy));
      if (kept === null) writeInside(base, copy, bytes, { exclusive: true });
      data.files[key] = { original: { sha256: sha256(kept ?? bytes), copy }, written: null };
    },
    after(key, file) {
      const bytes = readRegular(locate(key, file));
      if (bytes === null) throw new UnsafeWriteError(`${key} was not written`);
      if (!Object.hasOwn(data.files, key)) throw new UnsafeWriteError(`${key} was written without being recorded first`);
      data.files[key].written = sha256(bytes);
    },
    /** Records a folder DevOPs is about to create (with mkdir -p) when it is absent. */
    dir(key) {
      if (!ownDir(key)) throw new UnsafeWriteError(`not a folder DevOPs creates: ${key}`);
      assertInside(base, path.join(base, key));
      const parts = key.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!present(path.join(base, dir)) && !data.dirs.includes(dir)) data.dirs.push(dir);
      }
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
      writeInside(base, MANIFEST, `${JSON.stringify(data, null, 2)}\n`);
    },
    data,
    /** True when this call started the manifest (none was on disk). */
    started: found === null,
  };
  // The manifest's own folders, recorded before anything is written into them.
  api.dir('.workflow/state');
  return api;
}
