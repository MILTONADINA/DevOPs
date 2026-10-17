// A stand-in `git` for tests of scripts/init-project.sh. Tests never run the real git
// (tests/hermeticity.test.mjs); this answers only the queries init-project.sh makes:
//   -C <dir> rev-parse --git-dir          a repository when <dir>/.git exists (folder or file)
//   -C <dir> rev-parse --git-common-dir   STUB_GIT_COMMON_DIR, else the git dir
//   -C <dir> config --get core.hooksPath  STUB_HOOKS_PATH when set, else not set
//   -C <dir> rev-parse --git-path hooks   STUB_GIT_PATH_HOOKS, else .git/hooks
// STUB_GIT_DIR overrides the git dir it prints.
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let dir = process.cwd();
if (args[0] === '-C') { dir = path.resolve(dir, args[1]); args.splice(0, 2); }
const env = process.env;
const say = (text) => { process.stdout.write(text + '\\n'); process.exit(0); };
switch (args.join(' ')) {
  case 'rev-parse --git-dir':
    if (!fs.existsSync(path.join(dir, '.git'))) process.exit(128);
    say(env.STUB_GIT_DIR || '.git');
    break;
  case 'rev-parse --git-common-dir': say(env.STUB_GIT_COMMON_DIR || env.STUB_GIT_DIR || '.git'); break;
  case 'config --get core.hooksPath': if (env.STUB_HOOKS_PATH) say(env.STUB_HOOKS_PATH); process.exit(1); break;
  case 'rev-parse --git-path hooks': say(env.STUB_GIT_PATH_HOOKS || '.git/hooks'); break;
  default: process.exit(2);
}
`;

/** Write the stub as `git` into `binDir` and return its path. */
export function writeStubGit(binDir) {
  const file = path.join(binDir, 'git');
  writeFileSync(file, `#!${process.execPath}\n${SOURCE}`);
  chmodSync(file, 0o755);
  return file;
}
