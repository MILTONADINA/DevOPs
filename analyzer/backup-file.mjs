#!/usr/bin/env node
// specs/phase-2/F-skill-provenance.md REQ-F11 (#349): init-project.sh calls this
// before it replaces the DevOPs pre-commit hook, which can live outside the
// project (a worktree's git dir). Usage:
//   backup-file.mjs <project> <existing file> <new file> <stamp> <backup name>
// Prints the backup's path in the project when the existing file is a regular
// file whose bytes differ from the new one; prints nothing otherwise.
import fs from 'node:fs';
import { writeBackup } from './safe-write.js';

const [root, existing, replacement, stamp, name] = process.argv.slice(2);
if (!root || !existing || !replacement || !stamp || !/^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)*$/.test(name ?? '')) {
  console.error('usage: backup-file.mjs <project> <existing file> <new file> <stamp> <backup name>');
  process.exit(1);
}
let fd;
try {
  fd = fs.openSync(existing, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
} catch (error) {
  if (error.code === 'ENOENT' || error.code === 'ELOOP') process.exit(0);
  throw error;
}
let current, mode;
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) process.exit(0);
  mode = stat.mode & 0o777;
  current = fs.readFileSync(fd);
} finally {
  fs.closeSync(fd);
}
if (current.equals(fs.readFileSync(replacement))) process.exit(0);
console.log(writeBackup(root, name, current, mode, stamp));
