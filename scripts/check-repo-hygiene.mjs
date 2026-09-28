#!/usr/bin/env node
// specs/ops/repo-hygiene.md: tracked-file hygiene that a reviewer cannot see in a diff.
//
//   node scripts/check-repo-hygiene.mjs
//
// Exits 1 and lists every problem when:
//   REQ-1  a tracked file starts with `#!` but git records it as 100644 (not executable);
//   REQ-2  .claude-plugin/plugin.json or governance/VERSION.md disagrees with package.json's version;
//   REQ-3  a render or screenshot (.pdf .png .jpg .jpeg .gif .webp .html) is tracked outside RENDER_ALLOWLIST;
//   REQ-4  the root test script is not the `tests/**/*.test.mjs` glob, or a tracked fixture is named *.test.mjs.
// The checks are pure functions over git's index listing, so tests exercise them without running git.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export const TEST_SCRIPT = 'node --test "tests/**/*.test.mjs"';
// Rendered pages that are product source, not committed renders or screenshots.
export const RENDER_ALLOWLIST = ['runtime/landing.html', 'runtime/src/dashboard/index.html', 'scripts/graph-dashboard/index.html'];
const RENDER = /\.(?:pdf|png|jpe?g|gif|webp|html)$/i;

// `git ls-files -s -z` output -> [{ mode, file }].
export function parseStage(text) {
  return text.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    return { mode: entry.slice(0, tab).split(' ')[0], file: entry.slice(tab + 1) };
  });
}

export function nonExecutableShebangs(entries, startsWithShebang) {
  return entries.filter(({ mode, file }) => mode === '100644' && startsWithShebang(file)).map(({ file }) => file);
}

export function versionProblems({ packageVersion, pluginVersion, manifestText }) {
  const problems = [];
  if (pluginVersion !== packageVersion) problems.push(`.claude-plugin/plugin.json version ${pluginVersion} != package.json ${packageVersion}`);
  const current = (manifestText.match(/^\*\*Current version\*\*: (\S+)$/m) || [])[1];
  if (current !== packageVersion) problems.push(`governance/VERSION.md current version ${current ?? '(missing)'} != package.json ${packageVersion}`);
  return problems;
}

export function unallowedRenders(files) {
  return files.filter((file) => RENDER.test(file) && !RENDER_ALLOWLIST.includes(file));
}

export function testScriptProblems(testScript, files) {
  const problems = [];
  if (testScript !== TEST_SCRIPT) problems.push(`package.json scripts.test is ${JSON.stringify(testScript)}, expected ${JSON.stringify(TEST_SCRIPT)}`);
  for (const file of files) if (file.startsWith('tests/fixtures/') && file.endsWith('.test.mjs')) problems.push(`${file}: a fixture named like a test; the test glob would run it`);
  return problems;
}

export function checkRepo({ entries, startsWithShebang, packageJson, pluginJson, manifestText }) {
  const files = entries.map(({ file }) => file);
  return [
    ...nonExecutableShebangs(entries, startsWithShebang).map((file) => `${file}: starts with #! but is not executable (git update-index --chmod=+x)`),
    ...versionProblems({ packageVersion: packageJson.version, pluginVersion: pluginJson.version, manifestText }),
    ...unallowedRenders(files).map((file) => `${file}: a committed render or screenshot outside the allowlist`),
    ...testScriptProblems(packageJson.scripts?.test, files),
  ];
}

function startsWithShebang(file) {
  const fd = openSync(path.join(ROOT, file), 'r');
  try { const b = Buffer.alloc(2); return readSync(fd, b, 0, 2, 0) === 2 && b.toString() === '#!'; } finally { closeSync(fd); }
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(import.meta.filename); } catch { return false; }
}

if (isMain()) {
  const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
  // Gitlinks (submodules) and symlinks are not regular files; only regular files are read.
  const entries = parseStage(execFileSync('git', ['-C', ROOT, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    .filter(({ mode }) => mode === '100644' || mode === '100755');
  const problems = checkRepo({
    entries, startsWithShebang,
    packageJson: JSON.parse(read('package.json')),
    pluginJson: JSON.parse(read('.claude-plugin/plugin.json')),
    manifestText: read('governance/VERSION.md'),
  });
  for (const problem of problems) console.error(`repo hygiene: ${problem}`);
  console.log(`repo hygiene: ${entries.length} files checked, ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}
