#!/usr/bin/env node
// Weekly dependency report (quality plan QW-4). Owner decision 2026-09-26: no bot branches.
// Dependency updates are reported in one issue, and a maintainer applies them in a normal PR.
//
//   node scripts/dependency-report.mjs <body-file>
//
// Writes the issue body (markdown) to <body-file> and prints `outdated=<n>` and `errors=<n>`
// for the workflow. npm trees are the repository root and every top-level directory with a
// package-lock.json. Python trees are the hash-locked files in .github/requirements/: the
// packages named in each .in file, checked against PyPI's latest release.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ISSUE_TITLE = 'Dependency updates available';
const ROOT = path.join(import.meta.dirname, '..');

const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);

// Compare two versions by their first three numeric parts: -1, 0 or 1.
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// A major update moves to a higher major version (or, below 1.0, a higher minor).
function isMajor(from, to) {
  const [a, b] = [parts(from), parts(to)];
  if (a[0] !== b[0]) return b[0] > a[0];
  return a[0] === 0 && b[1] > a[1];
}

const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

// `npm outdated --json` prints either the outdated packages or `{"error": {...}}` (a registry,
// network or auth failure). An error must never read as a package called "error".
export function parseOutdated(stdout, tree) {
  const parsed = JSON.parse(stdout || '{}');
  if (parsed && typeof parsed.error === 'object' && parsed.error !== null) {
    throw new Error(`npm outdated failed in ${tree}: ${parsed.error.code ?? 'error'} ${parsed.error.summary ?? ''}`.trim());
  }
  return parsed;
}

export function npmRows(outdated) {
  return Object.entries(outdated)
    .map(([name, info]) => ({
      name,
      current: info.current ?? 'not installed',
      wanted: info.wanted,
      latest: info.latest,
      type: info.type ?? 'unknown',
      major: isMajor(info.current ?? info.wanted, info.latest),
      // Nothing to apply when neither the wanted nor the latest version is newer than what is
      // installed (for example a deprecated line whose "latest" tag points at an older release).
      behindOnly: info.current !== undefined && compareVersions(info.wanted, info.current) <= 0 && compareVersions(info.latest, info.current) < 0,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

export function pinnedVersions(requirementsText) {
  const pins = {};
  for (const line of requirementsText.split('\n')) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)/);
    if (m) pins[normalizeName(m[1])] = m[2];
  }
  return pins;
}

export function pythonRows(topLevel, pinned, latest) {
  return topLevel
    .map(normalizeName)
    .map((name) => ({ name, current: pinned[name], latest: latest[name] }))
    // Any difference is an update (an rc to its final release, a .postN, a fourth version
    // field) unless PyPI's latest is strictly older than the pin (a yanked newer release).
    .filter((row) => row.current && row.latest && row.current !== row.latest && compareVersions(row.latest, row.current) >= 0)
    .map((row) => ({ ...row, major: isMajor(row.current, row.latest) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

export function renderReport({ npm, python, errors }) {
  const lines = [
    'Dependency versions checked by `.github/workflows/dependency-report.yml` (weekly).',
    '',
    'No bot opens branches in this repository. A maintainer applies the updates below in a normal pull request: npm updates with `npm update` or a manifest edit, then `npm ci` and the tests; Python updates by regenerating the hash-locked file with the command in its `.in` file. Major updates (**major**) need their changelog read first.',
    '',
  ];
  let outdated = 0;
  const olderLatest = [];
  for (const { tree, rows } of npm) {
    const updates = rows.filter((r) => !r.behindOnly);
    olderLatest.push(...rows.filter((r) => r.behindOnly).map((r) => `${tree}: ${r.name} ${r.current} (latest tag ${r.latest})`));
    if (!updates.length) continue;
    outdated += updates.length;
    lines.push(`## npm: ${tree}`, '', '| Package | Current | Wanted | Latest | Type | |', '|---|---|---|---|---|---|');
    for (const r of updates) lines.push(`| ${r.name} | ${r.current} | ${r.wanted} | ${r.latest} | ${r.type} | ${r.major ? '**major**' : ''} |`);
    lines.push('');
  }
  for (const { file, rows } of python) {
    if (!rows.length) continue;
    outdated += rows.length;
    lines.push(`## Python: ${file}`, '', '| Package | Pinned | Latest | |', '|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.name} | ${r.current} | ${r.latest} | ${r.major ? '**major**' : ''} |`);
    lines.push('');
  }
  if (olderLatest.length) {
    lines.push('Installed versions newer than the registry\'s latest tag (nothing to apply; listed so they are not mistaken for updates):', '');
    for (const o of olderLatest) lines.push(`- ${o}`);
    lines.push('');
  }
  if (!outdated && !errors.length) lines.push('All tracked dependencies are current.', '');
  if (errors.length) {
    lines.push('## Could not check', '');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('');
  }
  return { body: lines.join('\n'), outdated, errors: errors.length };
}

function npmTrees() {
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.') && existsSync(path.join(ROOT, d.name, 'package-lock.json')))
    .map((d) => d.name)
    .sort();
  return ['.', ...dirs];
}

function npmOutdated(tree) {
  const name = tree === '.' ? 'root' : tree;
  let stdout;
  try {
    stdout = execFileSync('npm', ['outdated', '--json', '--long'], { cwd: path.join(ROOT, tree), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // `npm outdated` exits 1 when anything is outdated, and also on a registry error; the JSON
    // on stdout says which.
    if (error.status !== 1 || !error.stdout) throw new Error(`npm outdated failed in ${name}: exit ${error.status ?? 'unknown'}`);
    stdout = error.stdout;
  }
  return parseOutdated(stdout, name);
}

async function pypiLatest(name) {
  const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (!response.ok) throw new Error(`PyPI returned ${response.status} for ${name}`);
  return (await response.json()).info.version;
}

async function collect() {
  const errors = [];
  const npm = [];
  for (const tree of npmTrees()) {
    try {
      npm.push({ tree: tree === '.' ? 'root' : tree, rows: npmRows(npmOutdated(tree)) });
    } catch (error) {
      errors.push(error.message);
    }
  }
  const python = [];
  const reqDir = path.join(ROOT, '.github', 'requirements');
  const inFiles = existsSync(reqDir) ? readdirSync(reqDir).filter((f) => f.endsWith('.in')).sort() : [];
  for (const inFile of inFiles) {
    const txt = `.github/requirements/${inFile.replace(/\.in$/, '.txt')}`;
    try {
      const topLevel = readFileSync(path.join(reqDir, inFile), 'utf8').split('\n')
        .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map(normalizeName);
      const pinned = pinnedVersions(readFileSync(path.join(ROOT, txt), 'utf8'));
      for (const name of topLevel.filter((n) => !pinned[n])) errors.push(`${txt}: ${name} is named in ${inFile} but has no pin in the locked file`);
      const latest = {};
      for (const name of topLevel) latest[name] = await pypiLatest(name);
      python.push({ file: txt, rows: pythonRows(topLevel, pinned, latest) });
    } catch (error) {
      errors.push(`${txt}: ${error.message}`);
    }
  }
  return { npm, python, errors };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/dependency-report.mjs <body-file>');
    process.exit(2);
  }
  const report = renderReport(await collect());
  writeFileSync(out, report.body);
  console.log(`outdated=${report.outdated}`);
  console.log(`errors=${report.errors}`);
}
