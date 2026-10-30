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

// Stubbed fetch: serves `${commit}/${path}` from a table, records nothing on the network.
function runWithStub(dir, args, table, { redirectTo } = {}) {
  const stub = path.join(dir, 'stub-fetch.mjs');
  writeFileSync(stub, [
    `const table = ${JSON.stringify(table)};`,
    'globalThis.fetch = async (url) => {',
    '  const key = String(url);',
    '  const body = table[key];',
    '  const response = body === undefined ? new Response("not found", { status: 404 }) : new Response(body);',
    `  Object.defineProperty(response, "url", { value: ${redirectTo ? JSON.stringify(redirectTo) : 'key'} });`,
    '  return response;',
    '};',
  ].join('\n'));
  return spawnSync(process.execPath, ['--import', stub, TOOL, ...args], { encoding: 'utf8', timeout: 10_000 });
}


const COMMIT = 'a'.repeat(40);
const rawUrl = (file, commit = COMMIT) => `https://raw.githubusercontent.com/semgrep/semgrep-rules/${commit}/${file}`;
const pins = (files, commit = COMMIT) => ({ source: { repository: 'semgrep/semgrep-rules', commit }, files });
const entry = (file, text = BODY) => ({ path: file, sha256: sha(text) });
const BODY = 'rules:\n- id: toy.rule\n  pattern: toy($X)\n  message: toy\n  languages: [python]\n  severity: INFO\n';
const place = (dir, file, text) => {
  const target = path.join(dir, 'rules', file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
};

test('AC-6 a matching digest passes, including a nested rule path', () => withDir((dir) => {
  place(dir, 'generic/secrets/toy.yaml', BODY);
  place(dir, 'python/lang/other.yml', BODY);
  const r = verify(dir, pins([entry('generic/secrets/toy.yaml'), entry('python/lang/other.yml')]));
  assert.equal(r.status, 0, r.stderr);
}));

test('AC-6 a digest mismatch fails and names the file', () => withDir((dir) => {
  place(dir, 'generic/secrets/toy.yaml', `${BODY}# tampered\n`);
  const r = verify(dir, pins([entry('generic/secrets/toy.yaml')]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /digest mismatch.*generic\/secrets\/toy\.yaml/);
}));

test('AC-6 a missing or malformed pin digest fails', () => withDir((dir) => {
  place(dir, 'toy.yaml', BODY);
  for (const digest of [undefined, '', 'ABC', sha(BODY).toUpperCase()]) {
    const r = verify(dir, pins([{ path: 'toy.yaml', sha256: digest }]));
    assert.notEqual(r.status, 0, `digest ${String(digest)} must be refused`);
    assert.match(r.stderr, /missing or malformed sha256/);
  }
}));

test('AC-6 a pinned file that is absent, or an unpinned extra file, fails', () => withDir((dir) => {
  place(dir, 'nested/extra.yaml', BODY);
  const r = verify(dir, pins([entry('toy.yaml')]));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing rule file.*toy\.yaml/);
  place(dir, 'toy.yaml', BODY);
  const r2 = verify(dir, pins([entry('toy.yaml')]));
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /unpinned rule file.*nested\/extra\.yaml/);
}));

test('AC-6 rule paths that could escape the directory or are not yaml are refused', () => withDir((dir) => {
  place(dir, 'toy.yaml', BODY);
  for (const bad of ['../toy.yaml', '/toy.yaml', 'a/../toy.yaml', 'a\\toy.yaml', 'a//toy.yaml', './toy.yaml', 'toy.txt', 'a b/toy.yaml', '']) {
    const r = verify(dir, pins([{ path: bad, sha256: sha(BODY) }]));
    assert.notEqual(r.status, 0, `${JSON.stringify(bad)} must be refused`);
    assert.match(r.stderr, /invalid rule path/);
  }
  const dup = verify(dir, pins([entry('toy.yaml'), entry('toy.yaml')]));
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /duplicate rule path/);
}));

test('AC-6 the source commit must be a full lowercase 40-hex SHA of semgrep/semgrep-rules', () => withDir((dir) => {
  place(dir, 'toy.yaml', BODY);
  for (const commit of ['main', 'HEAD', 'a'.repeat(7), 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)}g`, null, 7]) {
    const r = verify(dir, pins([entry('toy.yaml')], commit));
    assert.notEqual(r.status, 0, `${String(commit)} must be refused`);
    assert.match(r.stderr, /invalid source commit/);
  }
  const other = verify(dir, { source: { repository: 'evil/semgrep-rules', commit: COMMIT }, files: [entry('toy.yaml')] });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /invalid source repository/);
}));

test('AC-6 the committed pins name a fixed commit and a pinned file set covering the three former packs', () => {
  assert.ok(existsSync(PINS), 'FEATURE_ABSENT: governance/semgrep-rules.sha256.json');
  const { source, files } = JSON.parse(readFileSync(PINS, 'utf8'));
  assert.equal(source.repository, 'semgrep/semgrep-rules');
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.ok(files.length >= 600, `expected at least 600 pinned rule files, got ${files.length}`);
  assert.equal(new Set(files.map((f) => f.path)).size, files.length, 'no duplicate paths');
  for (const f of files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.match(f.path, /^[A-Za-z0-9_-]+(\/[A-Za-z0-9._-]+)*\.ya?ml$/);
  }
  for (const prefix of ['generic/secrets/', 'javascript/', 'typescript/', 'python/']) {
    assert.ok(files.some((f) => f.path.startsWith(prefix)), `a pinned file under ${prefix}`);
  }
});

test('AC-5 the scan runs with --network none against local rule files, no registry config', () => {
  const job = semgrepJob();
  assert.match(job, /--network none/);
  assert.doesNotMatch(job, /--config\s+p\//, 'no registry pack config');
  assert.doesNotMatch(job, /(^|[\s=])p\/[a-z0-9-]+/, 'no p/ registry reference');
  assert.match(job, /--config \/rules\/(\s|\\|$)/, 'the whole rules directory is the config');
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


test('AC-6 pins are fetched from the immutable commit url and verified (fetch stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const files = ['generic/secrets/a.yaml', 'javascript/lang/b.yml'];
  writeFileSync(pinFile, JSON.stringify(pins(files.map((f) => entry(f)))));
  const table = Object.fromEntries(files.map((f) => [rawUrl(f), BODY]));
  const out = path.join(dir, 'fetched');
  const r = runWithStub(dir, ['fetch', out, pinFile], table);
  assert.equal(r.status, 0, r.stderr);
  for (const f of files) assert.equal(readFileSync(path.join(out, f), 'utf8'), BODY);
}));

test('AC-6 fetch fails closed when the served bytes differ from the pin (fetch stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('generic/secrets/a.yaml')])));
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { [rawUrl('generic/secrets/a.yaml')]: `${BODY}# drifted\n` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /digest mismatch.*generic\/secrets\/a\.yaml/);
}));

test('AC-6 fetch fails on an HTTP error and never fetches a branch url (fetch stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { 'https://raw.githubusercontent.com/semgrep/semgrep-rules/main/a.yaml': BODY });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 404/);
}));

test('AC-6 a pre-existing unpinned file in the fetch directory fails the verification (fetch stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const out = path.join(dir, 'fetched');
  mkdirSync(out);
  writeFileSync(path.join(out, 'planted.yaml'), BODY);
  const r = runWithStub(dir, ['fetch', out, pinFile], { [rawUrl('a.yaml')]: BODY });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unpinned rule file.*planted\.yaml/);
}));

test('REQ-7 CI never runs refresh; the tool documents it as person-run', () => {
  assert.doesNotMatch(semgrepJob(), /semgrep-rules\.mjs refresh/);
  assert.ok(existsSync(TOOL), 'FEATURE_ABSENT: scripts/semgrep-rules.mjs must exist');
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:.*refresh/);
});

test('REQ-7 refresh rewrites every pinned digest from the bytes at the pinned commit (fetch stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const stale = '0'.repeat(64);
  const files = ['generic/secrets/a.yaml', 'b.yaml'];
  writeFileSync(pinFile, JSON.stringify(pins(files.map((f) => ({ path: f, sha256: stale })))));
  const table = Object.fromEntries(files.map((f) => [rawUrl(f), `rules: []\n# ${f}\n`]));
  const r = runWithStub(dir, ['refresh', pinFile], table);
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(pinFile, 'utf8'));
  assert.equal(after.source.commit, COMMIT);
  for (const f of after.files) assert.equal(f.sha256, sha(`rules: []\n# ${f.path}\n`), `${f.path} digest refreshed`);
  assert.deepEqual(after.files.map((f) => f.path), files, 'paths and order are kept');
}));

test('REQ-7 refresh with a commit argument moves the pin to that commit; a non-SHA is refused (fetch stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const next = 'b'.repeat(40);
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const bad = runWithStub(dir, ['refresh', pinFile, 'main'], {});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid source commit/);
  assert.equal(JSON.parse(readFileSync(pinFile, 'utf8')).source.commit, COMMIT, 'file untouched on refusal');
  const r = runWithStub(dir, ['refresh', pinFile, next], { [rawUrl('a.yaml', next)]: 'rules: []\n' });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(pinFile, 'utf8'));
  assert.equal(after.source.commit, next);
  assert.equal(after.files[0].sha256, sha('rules: []\n'));
}));

test('AC-6 a redirect to http, or to a credentialed or other host, is refused (fetch stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  for (const target of ['http://raw.githubusercontent.com/x/a.yaml', 'https://u:p@raw.githubusercontent.com/x/a.yaml', 'https://evil.invalid/x/a.yaml', 'https://raw.githubusercontent.com:8080/x/a.yaml']) {
    const r = runWithStub(dir, ['refresh', pinFile], { [rawUrl('a.yaml')]: 'rules: []\n' }, { redirectTo: target });
    assert.notEqual(r.status, 0, `${target} must be refused`);
    assert.match(r.stderr, /invalid download url/);
  }
}));
