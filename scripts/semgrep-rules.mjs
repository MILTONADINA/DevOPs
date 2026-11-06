#!/usr/bin/env node
// specs/security/ci-semgrep-scan.md REQ-6/REQ-7.
// Usage: node scripts/semgrep-rules.mjs verify  DIR [PINS]           check DIR against the pinned sha256 digests
//        node scripts/semgrep-rules.mjs fetch   DIR [PINS]           download the pinned commit's tarball, extract the pinned files into DIR, then verify
//        node scripts/semgrep-rules.mjs refresh [PINS [COMMIT]]      person-run: download the tarball and rewrite the digests
//                                                                    (COMMIT moves the pin to another full commit SHA)
// One request fetches the whole commit as a tarball from codeload.github.com (not one request per file, which
// a 429 burst could fail). Only the paths listed in the pins file are extracted; every tar entry is still
// checked, and any unsafe entry (path traversal, absolute or backslash path, link, device) fails the run.
// refresh re-reads only the paths already listed. Moving the pin to a new commit therefore never picks up
// rules added upstream, and fails on any listed file removed or renamed there: reconcile the file list
// first (docs/SECURITY.md, "Reconciling the file list when moving the pin").
// The rules come from the semgrep/semgrep-rules repository at one fixed commit (immutable, unlike the
// registry packs on semgrep.dev, which are regenerated upstream). They are never committed here (Semgrep
// Rules License); only the commit SHA and a sha256 per file are.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const DEFAULT_PINS = path.join(import.meta.dirname, '..', 'governance', 'semgrep-rules.sha256.json');
const REPOSITORY = 'semgrep/semgrep-rules';
const HOST = 'codeload.github.com';
const MAX_BYTES = 20 * 1024 * 1024; // one rule file
const MAX_TARBALL = 256 * 1024 * 1024; // compressed download
const MAX_UNPACKED = 1024 * 1024 * 1024; // decompressed tar stream
const ATTEMPTS = 5;
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

export const tarballUrl = (commit) => {
  assertCommit(commit);
  return `https://${HOST}/${REPOSITORY}/tar.gz/${commit}`;
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

const invalidTarball = (reason) => new Error(`invalid tarball: ${reason}`);
const unsafeEntry = (name, reason) => new Error(`unsafe tarball entry ${JSON.stringify(name)}: ${reason}`);

function tarString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function tarOctal(block, start, length, what) {
  if (block[start] & 0x80) throw invalidTarball(`unsupported binary ${what} field`);
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw invalidTarball(`malformed ${what} field`);
  return text === '' ? 0 : parseInt(text, 8);
}

function parsePax(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString('ascii'));
    if (space === -1 || !Number.isInteger(length) || length <= space - offset + 1 || offset + length > body.length) throw invalidTarball('malformed pax header');
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) throw invalidTarball('malformed pax header');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

// Validates one entry name (after any pax/GNU long-name override) and returns its segments.
function entrySegments(name, isDirectory) {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) throw unsafeEntry(name, 'absolute path, backslash or NUL');
  const segments = (isDirectory ? name.replace(/\/$/, '') : name).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw unsafeEntry(name, 'empty, "." or ".." path segment');
  return segments;
}

// Parses a gzip tar archive in memory and returns the regular files whose path (below the archive's single
// top-level directory) is in `wanted`. Nothing touches the disk here, so a refusal leaves nothing behind.
export function extractTarball(gzipped, wanted) {
  let tar;
  try { tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED }); } catch (error) { throw invalidTarball(`gzip: ${error.message}`); }
  const found = new Map();
  let top;
  let offset = 0;
  let sawEnd = false;
  let override = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { sawEnd = true; break; }
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== tarOctal(header, 148, 8, 'checksum')) throw invalidTarball('header checksum mismatch');
    const size = tarOctal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] || 0x30);
    const bodyStart = offset + 512;
    if (bodyStart + size > tar.length) throw invalidTarball('truncated entry');
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === 'g') { parsePax(body); continue; } // global header: codeload records the commit here; carries no files
    if (type === 'x') {
      const fields = parsePax(body);
      if ('size' in fields || 'linkpath' in fields) throw unsafeEntry(fields.path ?? '', 'unsupported pax override');
      override = fields.path === undefined ? {} : { name: fields.path };
      continue;
    }
    if (type === 'L') { override = { name: tarString(body, 0, body.length) }; continue; }
    const prefix = tarString(header, 345, 155);
    const ownName = tarString(header, 0, 100);
    const name = override.name ?? (prefix ? `${prefix}/${ownName}` : ownName);
    override = {};
    if (type !== '0' && type !== '5') throw unsafeEntry(name, `entry type ${JSON.stringify(type)} is not a regular file or directory`);
    const isDirectory = type === '5';
    const segments = entrySegments(name, isDirectory);
    if (top === undefined) top = segments[0];
    if (segments[0] !== top) throw unsafeEntry(name, `outside the single top-level directory ${JSON.stringify(top)}`);
    if (isDirectory || segments.length === 1) continue;
    const relative = segments.slice(1).join('/');
    if (!wanted.has(relative)) continue;
    if (found.has(relative)) throw unsafeEntry(name, 'duplicate entry for a pinned file');
    if (size === 0 || size > MAX_BYTES) throw unsafeEntry(name, `unusable size ${size}`);
    found.set(relative, Buffer.from(body));
  }
  if (!sawEnd) throw invalidTarball('no end-of-archive marker (truncated?)');
  const missing = [...wanted].filter((file) => !found.has(file));
  if (missing.length) throw new Error(missing.map((file) => `missing rule file ${file}`).join('\n'));
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request for the whole commit. 429 and 5xx are retried with exponential backoff (honouring a short
// Retry-After); any other HTTP error is final.
async function downloadTarball(commit) {
  const url = tarballUrl(commit);
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let wait = 2 ** (attempt - 1) * 1000;
    try {
      const response = await fetch(url, { headers: { accept: 'application/gzip' }, signal: AbortSignal.timeout(180_000) });
      assertDownloadUrl(response.url);
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(Math.max(wait, retryAfter * 1000), 30_000);
        throw Object.assign(new Error(`download failed for ${url}: HTTP ${response.status}`), { final: response.status < 500 && response.status !== 429 });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_TARBALL) throw Object.assign(new Error(`download of ${url} has unusable size ${bytes.length}`), { final: true });
      return bytes;
    } catch (error) {
      lastError = error;
      if (error.final || /invalid download url/.test(error.message)) break;
      if (attempt < ATTEMPTS) await sleep(wait);
    }
  }
  throw lastError;
}

async function main([mode, ...rest]) {
  if (mode === 'verify' || mode === 'fetch') {
    const dir = rest[0];
    if (!dir) throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS]');
    const { source, files } = readPins(rest[1] ?? DEFAULT_PINS);
    if (mode === 'fetch') {
      const extracted = extractTarball(await downloadTarball(source.commit), new Set(files.map((entry) => entry.path)));
      mkdirSync(dir, { recursive: true });
      for (const [file, bytes] of extracted) {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    }
    verifyRules(dir, files);
    console.log(`semgrep rules verified: ${files.length} files at ${REPOSITORY}@${source.commit} match their pinned sha256`);
  } else if (mode === 'refresh') {
    const file = rest[0] ?? DEFAULT_PINS;
    const { source, files } = readPins(file);
    if (rest[1] !== undefined) assertCommit(rest[1]);
    const commit = rest[1] ?? source.commit;
    const extracted = extractTarball(await downloadTarball(commit), new Set(files.map((entry) => entry.path)));
    const next = files.map((entry) => ({ path: entry.path, sha256: sha256(extracted.get(entry.path)) }));
    writeFileSync(file, `${JSON.stringify({ source: { repository: REPOSITORY, commit }, files: next }, null, 2)}\n`);
    console.log(`rewrote ${file} at ${commit}; review the diff before committing`);
  } else {
    throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS] | refresh [PINS [COMMIT]]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => { console.error(`semgrep-rules: ${error.message}`); process.exit(1); });
}
