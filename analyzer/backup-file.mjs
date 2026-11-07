// specs/phase-2/F-skill-provenance.md REQ-F11 (#349): init-project.sh calls this
// before it replaces the DevOPs pre-commit hook, which can live outside the
// project (a worktree's git dir). Usage:
//   backup-file.mjs <project> <existing file> <new file, or - for stdin> <backup name>
// Prints the backup's path in the project when the existing file is a regular
// file whose bytes differ from the new one; prints nothing otherwise.
import fs from 'node:fs';
import { freshBackupStamp, writeBackup } from './safe-write.js';

const [root, existing, replacement, name] = process.argv.slice(2);
if (!root || !existing || !replacement || !/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)*$/.test(name ?? '')) {
  console.error('usage: backup-file.mjs <project> <existing file> <new file> <backup name>');
  process.exit(1);
}
let fd;
try {
  fd = fs.openSync(existing, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  // init-project.sh refuses a symlinked hook first; never back up through one.
  if (error.code === 'ELOOP') {
    console.error(`refusing to read through a symlink: ${existing}`);
    process.exit(2);
  }
  throw error;
}
let current, mode;
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    console.error(`not a regular file: ${existing}`);
    process.exit(2);
  }
  mode = stat.mode & 0o777;
  current = fs.readFileSync(fd);
} finally {
  fs.closeSync(fd);
}
if (current.equals(fs.readFileSync(replacement === '-' ? 0 : replacement))) process.exit(0);
console.log(writeBackup(root, name, current, mode, freshBackupStamp(root)));
