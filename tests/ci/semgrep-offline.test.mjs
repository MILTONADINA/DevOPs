// specs/security/ci-semgrep-scan.md REQ-6/REQ-7, AC-5/AC-6.
// Synthetic rule files only: no network, no scanner, no registry content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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

// Minimal ustar writer for synthetic tarballs (the tool under test parses real codeload archives).
function tarEntry(name, body = '', { type = '0', linkname = '' } = {}) {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}
const tarball = (entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const TOP = 'semgrep-semgrep-rules-aaaaaaa';
// A codeload-shaped archive: a global pax header, one top-level directory, pinned files and unrelated repository files.
const repoTarball = (files, extra = []) => tarball([
  tarEntry('pax_global_header', `52 comment=${'a'.repeat(40)}\n`, { type: 'g' }),
  tarEntry(`${TOP}/`, '', { type: '5' }),
  ...Object.entries(files).map(([file, text]) => tarEntry(`${TOP}/${file}`, text)),
  tarEntry(`${TOP}/README.md`, '# not a rule\n'),
  ...extra,
]);

// Stubbed fetch: serves a URL from a table of Buffers, logs every request, never touches the network.
// status: { [url]: [code, ...] } makes the first requests to that url answer with those codes.
function runWithStub(dir, args, table, { redirectTo, status = {} } = {}) {
  const stub = path.join(dir, 'stub-fetch.mjs');
  const log = path.join(dir, 'requests.log');
  const encoded = Object.fromEntries(Object.entries(table).map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
  writeFileSync(stub, [
    "import { appendFileSync } from 'node:fs';",
    `const table = ${JSON.stringify(encoded)};`,
    `const status = ${JSON.stringify(status)};`,
    'const seen = {};',
    'globalThis.fetch = async (url) => {',
    '  const key = String(url);',
    `  appendFileSync(${JSON.stringify(log)}, key + "\\n");`,
    '  seen[key] = (seen[key] ?? 0) + 1;',
    '  const code = status[key]?.[seen[key] - 1];',
    '  const body = table[key] === undefined ? undefined : Buffer.from(table[key], "base64");',
    '  const response = code ? new Response("busy", { status: code }) : body === undefined ? new Response("not found", { status: 404 }) : new Response(body);',
    `  Object.defineProperty(response, "url", { value: ${redirectTo ? JSON.stringify(redirectTo) : 'key'} });`,
    '  return response;',
    '};',
  ].join('\n'));
  const result = spawnSync(process.execPath, ['--import', stub, TOOL, ...args], { encoding: 'utf8', timeout: 20_000 });
  result.requests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return result;
}


const COMMIT = 'a'.repeat(40);
const tarUrl = (commit = COMMIT) => `https://codeload.github.com/semgrep/semgrep-rules/tar.gz/${commit}`;
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

test('AC-6 the pins include the mixed-case and late-listed rule files of the former packs', () => {
  const { files } = JSON.parse(readFileSync(PINS, 'utf8'));
  const pinned = new Set(files.map((f) => f.path));
  for (const required of [
    'csharp/lang/security/cryptography/X509-subject-name-validation.yaml',
    'javascript/lang/security/detect-pseudoRandomBytes.yaml',
    'generic/visualforce/security/ncino/html/UseSRIForCDNs.yaml',
    'generic/visualforce/security/ncino/vf/XSSFromUnescapedURLParam.yaml',
    'generic/visualforce/security/ncino/xml/CSPHeaderAttribute.yaml',
    'generic/visualforce/security/ncino/xml/VisualForceAPIVersion.yaml',
    'terraform/aws/security/aws-provisioner-exec.yaml',
  ]) assert.ok(pinned.has(required), `${required} must be pinned`);
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


test('AC-6 fetch downloads ONE commit tarball (not one request per file) and extracts only the pinned files (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const files = ['generic/secrets/a.yaml', 'javascript/lang/b.yml'];
  writeFileSync(pinFile, JSON.stringify(pins(files.map((f) => entry(f)))));
  const out = path.join(dir, 'fetched');
  const r = runWithStub(dir, ['fetch', out, pinFile], { [tarUrl()]: repoTarball(Object.fromEntries([...files, 'other/unpinned.yaml'].map((f) => [f, BODY]))) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.requests, [tarUrl()], 'exactly one request, to codeload at the pinned commit');
  for (const f of files) assert.equal(readFileSync(path.join(out, f), 'utf8'), BODY);
  assert.equal(existsSync(path.join(out, 'other', 'unpinned.yaml')), false, 'unpinned repository files are not extracted');
  assert.equal(existsSync(path.join(out, 'README.md')), false);
}));

test('AC-6 fetch fails closed when the tarball bytes differ from the pin (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('generic/secrets/a.yaml')])));
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { [tarUrl()]: repoTarball({ 'generic/secrets/a.yaml': `${BODY}# drifted\n` }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /digest mismatch.*generic\/secrets\/a\.yaml/);
}));

test('AC-6 fetch fails when a pinned file is missing from the tarball and names it (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml'), entry('gone/b.yaml')])));
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { [tarUrl()]: repoTarball({ 'a.yaml': BODY }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing rule file.*gone\/b\.yaml/);
}));

test('AC-6 fetch fails on an HTTP 404 without retry and retries a 429 (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { 'https://codeload.github.com/semgrep/semgrep-rules/tar.gz/main': repoTarball({ 'a.yaml': BODY }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 404/);
  assert.deepEqual(r.requests, [tarUrl()], '404 is final: one request, never a branch url');
  const second = path.join(dir, 'second');
  mkdirSync(second);
  const retried = runWithStub(second, ['fetch', path.join(second, 'fetched'), pinFile], { [tarUrl()]: repoTarball({ 'a.yaml': BODY }) }, { status: { [tarUrl()]: [429] } });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.requests.length, 2, 'one 429 then one success');
}));

test('AC-6 a corrupt or truncated tarball fails closed (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const good = repoTarball({ 'a.yaml': BODY });
  for (const bad of [Buffer.from('not a gzip file'), good.subarray(0, Math.floor(good.length / 2))]) {
    const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { [tarUrl()]: bad });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid tarball/);
  }
}));

test('AC-6 unsafe tar entries (traversal, absolute, backslash, symlink, hardlink, device) fail closed and write nothing outside the directory (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const cases = {
    traversal: tarEntry(`${TOP}/../../escaped.yaml`, BODY),
    'dot-dot segment': tarEntry(`${TOP}/a/../../escaped.yaml`, BODY),
    absolute: tarEntry('/tmp/escaped.yaml', BODY),
    backslash: tarEntry(`${TOP}/a\\..\\escaped.yaml`, BODY),
    symlink: tarEntry(`${TOP}/link.yaml`, '', { type: '2', linkname: '../../outside' }),
    hardlink: tarEntry(`${TOP}/hard.yaml`, '', { type: '1', linkname: `${TOP}/a.yaml` }),
    device: tarEntry(`${TOP}/dev.yaml`, '', { type: '3' }),
  };
  for (const [name, bad] of Object.entries(cases)) {
    const sub = path.join(dir, name.replace(/\W/g, '_'));
    mkdirSync(sub);
    const r = runWithStub(sub, ['fetch', path.join(sub, 'fetched'), pinFile], { [tarUrl()]: repoTarball({ 'a.yaml': BODY }, [bad]) });
    assert.notEqual(r.status, 0, `${name} must be refused`);
    assert.match(r.stderr, /unsafe tarball entry/, name);
    assert.equal(existsSync(path.join(sub, 'escaped.yaml')), false, `${name}: nothing escaped`);
    assert.equal(existsSync(path.join(dir, 'escaped.yaml')), false, `${name}: nothing escaped`);
  }
}));

test('AC-6 a tarball whose entries do not share one top-level directory is refused (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const tgz = tarball([tarEntry(`${TOP}/a.yaml`, BODY), tarEntry('other-root/a.yaml', BODY)]);
  const r = runWithStub(dir, ['fetch', path.join(dir, 'fetched'), pinFile], { [tarUrl()]: tgz });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe tarball entry.*top-level/);
}));

test('AC-6 a pre-existing unpinned file in the fetch directory fails the verification (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const out = path.join(dir, 'fetched');
  mkdirSync(out);
  writeFileSync(path.join(out, 'planted.yaml'), BODY);
  const r = runWithStub(dir, ['fetch', out, pinFile], { [tarUrl()]: repoTarball({ 'a.yaml': BODY }) });
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

test('REQ-7 refresh rewrites every pinned digest from ONE tarball at the pinned commit (stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const stale = '0'.repeat(64);
  const files = ['generic/secrets/a.yaml', 'b.yaml'];
  writeFileSync(pinFile, JSON.stringify(pins(files.map((f) => ({ path: f, sha256: stale })))));
  const r = runWithStub(dir, ['refresh', pinFile], { [tarUrl()]: repoTarball(Object.fromEntries(files.map((f) => [f, `rules: []\n# ${f}\n`]))) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.requests, [tarUrl()]);
  const after = JSON.parse(readFileSync(pinFile, 'utf8'));
  assert.equal(after.source.commit, COMMIT);
  for (const f of after.files) assert.equal(f.sha256, sha(`rules: []\n# ${f.path}\n`), `${f.path} digest refreshed`);
  assert.deepEqual(after.files.map((f) => f.path), files, 'paths and order are kept');
}));

test('REQ-7 refresh with a commit argument moves the pin; a non-SHA is refused; a file missing at the new commit fails and leaves the pins untouched (stubbed)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  const next = 'b'.repeat(40);
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  const bad = runWithStub(dir, ['refresh', pinFile, 'main'], {});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid source commit/);
  assert.equal(JSON.parse(readFileSync(pinFile, 'utf8')).source.commit, COMMIT, 'file untouched on refusal');
  const missing = runWithStub(dir, ['refresh', pinFile, next], { [tarUrl(next)]: repoTarball({ 'renamed.yaml': 'rules: []\n' }) });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing rule file.*a\.yaml/);
  assert.equal(JSON.parse(readFileSync(pinFile, 'utf8')).source.commit, COMMIT, 'file untouched on failure');
  const r = runWithStub(dir, ['refresh', pinFile, next], { [tarUrl(next)]: repoTarball({ 'a.yaml': 'rules: []\n' }) });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(pinFile, 'utf8'));
  assert.equal(after.source.commit, next);
  assert.equal(after.files[0].sha256, sha('rules: []\n'));
}));

test('AC-6 a redirect to http, or to a credentialed or other host, is refused (stubbed, no network)', () => withDir((dir) => {
  const pinFile = path.join(dir, 'pins.json');
  writeFileSync(pinFile, JSON.stringify(pins([entry('a.yaml')])));
  for (const target of ['http://codeload.github.com/x', 'https://u:p@codeload.github.com/x', 'https://evil.invalid/x', 'https://codeload.github.com:8080/x', 'https://raw.githubusercontent.com/x']) {
    const r = runWithStub(dir, ['refresh', pinFile], { [tarUrl()]: repoTarball({ 'a.yaml': 'rules: []\n' }) }, { redirectTo: target });
    assert.notEqual(r.status, 0, `${target} must be refused`);
    assert.match(r.stderr, /invalid download url/);
  }
}));

test('REQ-6 the network allowlist names codeload.github.com and no longer raw.githubusercontent.com', () => {
  const lines = readFileSync(path.join(ROOT, '.workflow', 'network-allowlist.txt'), 'utf8').split('\n').map((l) => l.trim());
  const hosts = lines.filter((l) => l && !l.startsWith('#'));
  assert.ok(hosts.includes('codeload.github.com'));
  assert.ok(!hosts.includes('raw.githubusercontent.com'));
});

test('REQ-7 docs/SECURITY.md documents how to reconcile the file list when moving the pin', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  assert.match(doc, /Reconciling the file list/);
  assert.match(doc, /tar -tzf/);
});
