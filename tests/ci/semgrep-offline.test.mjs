// specs/security/ci-semgrep-scan.md REQ-6/REQ-7, AC-5/AC-6.
// Synthetic rule files only: no network, no scanner, no registry content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'semgrep-rules.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'security-scan.yml');
const PINS = path.join(ROOT, 'governance', 'semgrep-rules.sha256.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');

function semgrepJob() {
  const text = readFileSync(WORKFLOW, 'utf8');
  const start = text.indexOf('\n  semgrep:');
  assert.ok(start > 0, 'semgrep job must exist');
  const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
  assert.ok(next > 0, 'a job header must follow the semgrep job');
  const end = start + 1 + next;
  return text.slice(start, end);
}

function withDir(run) {
  assert.ok(existsSync(TOOL), 'FEATURE_ABSENT: scripts/semgrep-rules.mjs must exist');
  const dir = mkdtempSync(path.join(tmpdir(), 'semgrep-rules-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function verify(dir, pins) {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins));
  const rules = path.join(dir, 'rules');
  return spawnSync(process.execPath, [TOOL, 'verify', rules, pinFile], { encoding: 'utf8', timeout: 10_000 });
}

const BODY = 'rules:\n- id: toy.rule\n  pattern: toy($X)\n  message: toy\n  languages: [python]\n  severity: INFO\n';
const pin = (name, digest, url = `https://semgrep.dev/c/p/${name}`) => ({ name, url, sha256: digest });
const place = (dir, name, text) => {
  const rules = path.join(dir, 'rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(path.join(rules, `${name}.yml`), text);
};

test('AC-6 a matching digest passes', () => withDir((dir) => {
  place(dir, 'toy', BODY);
  const r = verify(dir, { packs: [pin('toy', sha(BODY))] });
  assert.equal(r.status, 0, r.stderr);
}));

test('AC-6 a digest mismatch fails and names the pack', () => withDir((dir) => {
  place(dir, 'toy', `${BODY}# tampered\n`);
  const r = verify(dir, { packs: [pin('toy', sha(BODY))] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /digest mismatch.*toy/);
}));

test('AC-6 a missing or malformed pin digest fails', () => withDir((dir) => {
  place(dir, 'toy', BODY);
  for (const digest of [undefined, '', 'ABC', sha(BODY).toUpperCase()]) {
    const r = verify(dir, { packs: [pin('toy', digest)] });
    assert.notEqual(r.status, 0, `digest ${String(digest)} must be refused`);
    assert.match(r.stderr, /missing or malformed sha256/);
  }
}));

test('AC-6 a pinned file that is absent, or an unpinned extra file, fails', () => withDir((dir) => {
  place(dir, 'extra', BODY);
  const r = verify(dir, { packs: [pin('toy', sha(BODY))] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing rule file.*toy/);
  place(dir, 'toy', BODY);
  const r2 = verify(dir, { packs: [pin('toy', sha(BODY))] });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /unpinned rule file.*extra/);
}));

test('AC-6 pack names that could escape the directory are refused', () => withDir((dir) => {
  place(dir, 'toy', BODY);
  const r = verify(dir, { packs: [pin('../toy', sha(BODY))] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid pack name/);
}));

test('AC-6 the committed pins cover the three configured packs with sha256 digests', () => {
  assert.ok(existsSync(PINS), 'FEATURE_ABSENT: governance/semgrep-rules.sha256.json');
  const { packs } = JSON.parse(readFileSync(PINS, 'utf8'));
  assert.deepEqual(packs.map((p) => p.name).sort(), ['owasp-top-ten', 'r2c-security-audit', 'secrets']);
  for (const p of packs) {
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.match(p.url, /^https:\/\/semgrep\.dev\/c\/p\//);
  }
});

test('AC-5 the scan runs with --network none against local rule files, no registry config', () => {
  const job = semgrepJob();
  assert.match(job, /--network none/);
  assert.doesNotMatch(job, /--config\s+p\//, 'no registry pack config');
  assert.doesNotMatch(job, /(^|[\s=])p\/[a-z0-9-]+/, 'no p/ registry reference');
  assert.match(job, /--config \/rules\//);
  assert.match(job, /--disable-version-check/);
  assert.match(job, /semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/);
});

test('AC-5 rules are fetched and verified in a step before the scan; the pull stays before --network none', () => {
  const job = semgrepJob();
  const verifyAt = job.indexOf('scripts/semgrep-rules.mjs fetch');
  const pullAt = job.indexOf('docker pull');
  const runAt = job.indexOf('docker run');
  assert.ok(verifyAt > 0 && verifyAt < runAt, 'fetch+verify precedes docker run');
  assert.ok(pullAt > 0 && pullAt < runAt, 'image pull precedes the offline run');
  assert.match(job, /\/rules:ro/, 'rules are mounted read-only');
});

test('AC-6 pack urls must be https on semgrep.dev without credentials', () => withDir((dir) => {
  place(dir, 'toy', BODY);
  for (const url of ['http://semgrep.dev/c/p/toy', 'https://evil.invalid/c/p/toy', 'https://u:p@semgrep.dev/c/p/toy', 'not a url']) {
    const r = verify(dir, { packs: [pin('toy', sha(BODY), url)] });
    assert.notEqual(r.status, 0, `${url} must be refused`);
    assert.match(r.stderr, /invalid pack url/);
  }
}));

test('REQ-7 CI never runs refresh; the tool documents it as person-run', () => {
  assert.doesNotMatch(semgrepJob(), /semgrep-rules\.mjs refresh/);
  assert.ok(existsSync(TOOL), 'FEATURE_ABSENT: scripts/semgrep-rules.mjs must exist');
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:.*refresh/);
});

test('REQ-7 refresh rewrites every pinned digest from the downloaded bytes (fetch stubbed, no network)', () => withDir((dir) => {
  const stub = path.join(dir, 'stub-fetch.mjs');
  writeFileSync(stub, [
    'globalThis.fetch = async (url) => {',
    '  const response = new Response(`rules: []\\n# ${url}\\n`);',
    '  Object.defineProperty(response, "url", { value: String(url) });',
    '  return response;',
    '};',
  ].join('\n'));
  const pinFile = path.join(dir, 'pins.json');
  const stale = '0'.repeat(64);
  writeFileSync(pinFile, JSON.stringify({ packs: [pin('toy', stale), pin('other', stale)] }));
  const r = spawnSync(process.execPath, ['--import', stub, TOOL, 'refresh', pinFile], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  const { packs } = JSON.parse(readFileSync(pinFile, 'utf8'));
  for (const p of packs) assert.equal(p.sha256, sha(`rules: []\n# ${p.url}\n`), `${p.name} digest refreshed`);
  assert.deepEqual(packs.map((p) => p.name), ['toy', 'other'], 'names and order are kept');
}));

test('AC-6 a redirect to http, or to a credentialed or other host, is refused (fetch stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify({ packs: [pin('toy', '0'.repeat(64))] }));
  for (const target of ['http://semgrep.dev/c/p/toy', 'https://u:p@semgrep.dev/c/p/toy', 'https://evil.invalid/c/p/toy']) {
    const stub = path.join(dir, 'stub-redirect.mjs');
    writeFileSync(stub, [
      'globalThis.fetch = async () => {',
      '  const response = new Response("rules: []\\n");',
      `  Object.defineProperty(response, "url", { value: ${JSON.stringify(target)} });`,
      '  return response;',
      '};',
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--import', stub, TOOL, 'refresh', pinFile], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(r.status, 0, `${target} must be refused`);
    assert.match(r.stderr, /invalid pack url/);
  }
}));
