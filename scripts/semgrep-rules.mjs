#!/usr/bin/env node
// specs/security/ci-semgrep-scan.md REQ-6/REQ-7.
// Usage: node scripts/semgrep-rules.mjs verify DIR [PINS]   check DIR against the pinned sha256 digests
//        node scripts/semgrep-rules.mjs fetch  DIR [PINS]   download each pinned pack into DIR, then verify
//        node scripts/semgrep-rules.mjs refresh [PINS]      person-run: download and rewrite the digests
// Registry rule files are never committed (Semgrep Rules License); only their digests are.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PINS = path.join(import.meta.dirname, '..', 'governance', 'semgrep-rules.sha256.json');
const MAX_BYTES = 20 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function readPins(file) {
  const { packs } = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(packs) || packs.length === 0) throw new Error('pins: packs must be a nonempty array');
  const seen = new Set();
  for (const pack of packs) {
    if (typeof pack?.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(pack.name)) {
      throw new Error(`pins: invalid pack name ${JSON.stringify(pack?.name)}`);
    }
    if (seen.has(pack.name)) throw new Error(`pins: duplicate pack ${pack.name}`);
    seen.add(pack.name);
  }
  return packs;
}

export function verifyRules(dir, packs) {
  const problems = [];
  for (const pack of packs) {
    if (typeof pack.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pack.sha256)) {
      problems.push(`missing or malformed sha256 for ${pack.name}`);
      continue;
    }
    let bytes;
    try { bytes = readFileSync(path.join(dir, `${pack.name}.yml`)); } catch {
      problems.push(`missing rule file ${pack.name}.yml`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== pack.sha256) problems.push(`digest mismatch for ${pack.name}: pinned ${pack.sha256}, got ${actual}`);
  }
  const pinned = new Set(packs.map((pack) => `${pack.name}.yml`));
  for (const file of readdirSync(dir)) if (!pinned.has(file)) problems.push(`unpinned rule file ${file}`);
  if (problems.length) throw new Error(problems.join('\n'));
}

async function download(url) {
  if (!url.startsWith('https://')) throw new Error(`refusing non-https url ${url}`);
  const response = await fetch(url, { headers: { accept: 'application/yaml' } });
  if (!response.ok) throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error(`download of ${url} has unusable size ${bytes.length}`);
  return bytes;
}

async function main([mode, ...rest]) {
  if (mode === 'verify' || mode === 'fetch') {
    const dir = rest[0];
    if (!dir) throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS]');
    const packs = readPins(rest[1] ?? DEFAULT_PINS);
    if (mode === 'fetch') {
      mkdirSync(dir, { recursive: true });
      for (const pack of packs) writeFileSync(path.join(dir, `${pack.name}.yml`), await download(pack.url));
    }
    verifyRules(dir, packs);
    console.log(`semgrep rules verified: ${packs.length} packs match their pinned sha256`);
  } else if (mode === 'refresh') {
    const file = rest[0] ?? DEFAULT_PINS;
    const packs = readPins(file);
    for (const pack of packs) pack.sha256 = sha256(await download(pack.url));
    writeFileSync(file, `${JSON.stringify({ packs }, null, 2)}\n`);
    console.log(`rewrote ${file}; review the diff before committing`);
  } else {
    throw new Error('usage: semgrep-rules.mjs verify|fetch DIR [PINS] | refresh [PINS]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => { console.error(`semgrep-rules: ${error.message}`); process.exit(1); });
}
