// analyzer/safe-write.js
//
// specs/phase-2/F-skill-provenance.md REQ-F10: `devops init` and
// `devops-analyze` write only inside the project they were pointed at. A
// project can commit a symlink (AGENTS.md, .claude/hooks/x.sh, .workflow), and
// a plain write, append or chmod follows it to a file outside the project. Every
// write here refuses a path when any existing component below the project root
// is a symlink, opens the final file without following a link, and sets the
// mode on the open file, never through a path.

import * as fs from 'node:fs';
import * as path from 'node:path';

export class UnsafeWriteError extends Error {}

// Windows has no O_NOFOLLOW; the component walk below still refuses links there.
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** True when something (a file, directory or link, even a dangling one) is at `p`. */
export function present(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Throws unless `target` is inside `root` and no existing component of it below
 * `root` is a symlink. `root` itself may be reached through links (macOS /tmp).
 */
export function assertInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new UnsafeWriteError(`refusing to write outside the project: ${target}`);
  if (relative === '') return;
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new UnsafeWriteError(
        `refusing to write through a symlink in the project: ${path.relative(base, current)}`,
      );
  }
}

/** mkdir -p inside the project, refusing a symlinked component before and after. */
export function mkdirInside(root, dir) {
  assertInside(root, dir);
  fs.mkdirSync(path.resolve(root, dir), { recursive: true });
  assertInside(root, dir);
}

/** Writes (or appends) `data` to a file inside the project without following a link. */
export function writeInside(
  root,
  target,
  data,
  options = {},
) {
  const file = path.resolve(root, target);
  if (file === path.resolve(root))
    throw new UnsafeWriteError(`refusing to write over the project root: ${target}`);
  mkdirInside(root, path.dirname(file));
  assertInside(root, file);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    NOFOLLOW |
    (options.append ? fs.constants.O_APPEND : fs.constants.O_TRUNC);
  const fd = fs.openSync(file, flags, options.mode ?? 0o644);
  try {
    if (!fs.fstatSync(fd).isFile())
      throw new UnsafeWriteError(`refusing to write to a non-regular file: ${target}`);
    fs.writeFileSync(fd, data);
    if (options.mode !== undefined) {
      try {
        fs.fchmodSync(fd, options.mode);
      } catch {
        /* best-effort on Windows */
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Copies `src` to `dst` inside the project; `mode` is set on the open file. */
export function copyInside(root, src, dst, mode) {
  writeInside(root, dst, fs.readFileSync(src), { mode });
}

/**
 * specs/phase-2/F-skill-provenance.md REQ-F11 (#349): before init or analyze
 * replaces a regular file inside the project whose bytes differ from `data`,
 * copy it to `.workflow/state/backups/<stamp>/<path inside the project>` and
 * return that backup's path relative to the project; otherwise return null.
 * A missing file, or one that is not a regular file (writeInside refuses
 * those), needs no backup. `same(current, data)` decides whether the bytes
 * differ (default: byte equality).
 */
export function backupIfChanged(root, target, data, stamp, same = (a, b) => a.equals(b)) {
  const base = path.resolve(root);
  const file = path.resolve(base, target);
  assertInside(base, file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    throw error;
  }
  let current, mode;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    mode = stat.mode & 0o777;
    current = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (same(current, Buffer.isBuffer(data) ? data : Buffer.from(data))) return null;
  return writeBackup(base, path.relative(base, file), current, mode, stamp);
}

/** Writes `bytes` as the backup of `name` for this run and returns its path in the project. */
export function writeBackup(root, name, bytes, mode, stamp) {
  if (!/^[0-9TZ-]+$/.test(stamp)) throw new UnsafeWriteError(`invalid backup stamp: ${stamp}`);
  const backup = path.join('.workflow/state/backups', stamp, name);
  writeInside(root, backup, bytes, { mode });
  return backup.split(path.sep).join('/');
}

/** A UTC timestamp usable as a directory name, e.g. 2026-11-07T05-30-00Z. */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}
