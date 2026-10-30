#!/usr/bin/env node
// specs/security/ci-semgrep-scan.md REQ-6/REQ-7.
// Usage: node scripts/semgrep-rules.mjs verify  DIR [PINS]           check DIR against the pinned sha256 digests
//        node scripts/semgrep-rules.mjs fetch   DIR [PINS]           download each pinned rule file into DIR, then verify
//        node scripts/semgrep-rules.mjs refresh [PINS [COMMIT]]      person-run: download and rewrite the digests
//                                                                    (COMMIT moves the pin to another full commit SHA)
// The rules come from the semgrep/semgrep-rules repository at one fixed commit (immutable, unlike the
// registry packs on semgrep.dev, which are regenerated upstream). They are never committed here (Semgrep
// Rules License); only the commit SHA and a sha256 per file are.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PINS = path.join(import.meta.dirname, '..', 'governance', 'semgrep-rules.sha256.json');
const REPOSITORY = 'semgrep/semgrep-rules';
const HOST = 'raw.githubusercontent.com';
const MAX_BYTES = 20 * 1024 * 1024;
const CONCURRENCY = 8;
const ATTEMPTS = 3;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RULE_PATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9._-]+)*\.ya?ml$/;

export function assertCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) {
    throw new Error(`pins: invalid source commit ${JSON.stringify(value)} (need a full lowercase 40-hex SHA)`);
  }
}

function assertRulePath(value) {
  if (typeof value !== 'string' || !RULE_PATH_PATTERN.test(value) || value.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`pins: invalid rule path ${JSON.stringify(value)}`);
  }
}

function assertDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid download url ${JSON.stringify(String(value))}`); }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password) {
    throw new Error(`invalid download url ${JSON.stringify(String(value))}`);
  }
}

export const ruleUrl = (commit, file) => {
  assertCommit(commit);
  assertRulePath(file);
  return `https://${HOST}/${REPOSITORY}/${commit}/${file}`;
};

export function readPins(file) {
  const { source, files } = JSON.parse(readFileSync(file, 'utf8'));
  if (source?.repository !== REPOSITORY) throw new Error(`pins: invalid source repository ${JSON.stringify(source?.repository)}`);
  assertCommit(source.commit);
  if (!Array.isArray(files) || files.length === 0) throw new Error('pins: files must be a nonempty array');
  const seen = new Set();
  for (const entry of files) {
    assertRulePath(entry?.path);
    if (seen.has(entry.path)) throw new Error(`pins: duplicate rule path ${entry.path}`);
    seen.add(entry.path);
  }
  return { source, files };
}

function listFiles(dir, prefix = '') {
  const found = [];
  for (const item of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) found.push(...listFiles(dir, relative));
    else found.push(relative);
  }
  return found;
}

export function verifyRules(dir, files) {
  const problems = [];
  for (const entry of files) {
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      problems.push(`missing or malformed sha256 for ${entry.path}`);
      continue;
    }
    let bytes;
    try { bytes = readFileSync(path.join(dir, entry.path)); } catch {
      problems.push(`missing rule file ${entry.path}`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) problems.push(`digest mismatch for ${entry.path}: pinned ${entry.sha256}, got ${actual}`);
  }
  const pinned = new Set(files.map((entry) => entry.path));
  for (const file of listFiles(dir)) if (!pinned.has(file)) problems.push(`unpinned rule file ${file}`);
  if (problems.length) throw new Error(problems.join('\n'));
}

async function download(commit, file) {
  const url = ruleUrl(commit, file);
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(60_000) });
      assertDownloadUrl(response.url);
      if (!response.ok) throw Object.assign(new Error(`download failed for ${url}: HTTP ${response.status}`), { final: response.status < 500 && response.status !== 429 });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BYTES) throw Object.assign(new Error(`download of ${url} has unusable size ${bytes.length}`), { final: true });
      return bytes;
    } catch (error) {
      lastError = error;
      if (error.final || /invalid download url/.test(error.message)) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function mapLimited(items, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

async function main([mode, ...rest]) {
  if (mode === 'verify' || mode === 'fetch') {
    const dir = rest[0];
    if (!dir) throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS]');
    const { source, files } = readPins(rest[1] ?? DEFAULT_PINS);
    if (mode === 'fetch') {
      mkdirSync(dir, { recursive: true });
      const bodies = await mapLimited(files, (entry) => download(source.commit, entry.path));
      files.forEach((entry, index) => {
        const target = path.join(dir, entry.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bodies[index]);
      });
    }
    verifyRules(dir, files);
    console.log(`semgrep rules verified: ${files.length} files at ${REPOSITORY}@${source.commit} match their pinned sha256`);
  } else if (mode === 'refresh') {
    const file = rest[0] ?? DEFAULT_PINS;
    const { source, files } = readPins(file);
    if (rest[1] !== undefined) assertCommit(rest[1]);
    const commit = rest[1] ?? source.commit;
    const bodies = await mapLimited(files, (entry) => download(commit, entry.path));
    const next = files.map((entry, index) => ({ path: entry.path, sha256: sha256(bodies[index]) }));
    writeFileSync(file, `${JSON.stringify({ source: { repository: REPOSITORY, commit }, files: next }, null, 2)}\n`);
    console.log(`rewrote ${file} at ${commit}; review the diff before committing`);
  } else {
    throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS] | refresh [PINS [COMMIT]]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => { console.error(`semgrep-rules: ${error.message}`); process.exit(1); });
}
