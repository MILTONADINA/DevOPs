// analyzer/project-state.js
//
// specs/ops/analyzer-detection.md REQ-1: the project state `devops analyze` reports.
// Git runs in the analyzed project, and a shallow clone's commit count is not read as
// the project's age.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// Fewer commits than this in full history means a new project.
export const GREENFIELD_COMMITS = 5;

// `execFile` is execFileSync (no shell); tests pass a fake to see the options without
// running git.
export function runGit(args, cwd, execFile = execFileSync) {
  return execFile('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
}

/**
 * Returns { state, note }: state is "greenfield", "brownfield" or "hotfix"; note says why
 * when the answer rests on something the user should know (null otherwise).
 * `git(args, cwd)` returns git's stdout or throws; tests pass a fake.
 */
export function detectState(root, { git = runGit, year = new Date().getFullYear() } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) return { state: 'greenfield', note: null };

  let shallow = false;
  try {
    shallow = git(['rev-parse', '--is-shallow-repository'], root).trim() === 'true';
  } catch { /* no git, or git refused: fall back to the commit count */ }
  // A git older than 2.15 echoes the unknown flag back instead of failing; that is not
  // "true" either, so it also falls back to the count.

  let note = null;
  if (shallow) {
    note = 'shallow clone: its commit count is not the project\'s history, so it is not read as a new project';
  } else {
    try {
      const count = Number.parseInt(git(['rev-list', '--count', 'HEAD'], root).trim(), 10);
      if (Number.isInteger(count) && count < GREENFIELD_COMMITS) return { state: 'greenfield', note: null };
    } catch { /* no commits yet, or no git: decide from the files below */ }
  }

  const incidents = path.join(root, 'docs/incidents');
  if (fs.existsSync(incidents) && fs.readdirSync(incidents).some(f => f.startsWith(String(year)))) {
    return { state: 'hotfix', note };
  }
  return { state: 'brownfield', note };
}
