// specs/graph/branch-protection-preflight.md REQ-1..3 / AC-1..3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CONTEXTS = ['validate', 'runtime-test', 'setup-linux', 'gitleaks', 'semgrep', 'dependency-audit'];
const RESOURCE = 'repos/fixture-owner/fixture-repo/branches/main/protection';
const REQUEST = ['api', '--hostname', 'github.com', '--method', 'GET', RESOURCE];
const SENSITIVE_SENTINEL = 'fixture-response-must-not-be-dumped';
const healthy = () => ({
  required_status_checks: { strict: true, contexts: [...CONTEXTS] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: { required_approving_review_count: 0 },
});

function fixture(options = {}) {
  const state = path.join(ROOT, '.workflow', 'state');
  mkdirSync(state, { recursive: true });
  const outer = realpathSync(mkdtempSync(path.join(state, 'branch-protection-')));
  const repo = path.join(outer, 'repo');
  const bin = path.join(repo, 'fake-bin');
  for (const dir of ['scripts', 'governance/graph', '.workflow/state', '.workflow/proofs', 'node_modules/.bin', 'runtime/node_modules/.bin', 'home', 'gh-config', 'fake-bin']) {
    mkdirSync(path.join(repo, dir), { recursive: true });
  }
  copyFileSync(path.join(ROOT, 'scripts', 'graph-preflight.mjs'), path.join(repo, 'scripts', 'graph-preflight.mjs'));
  copyFileSync(path.join(ROOT, 'governance', 'graph', 'preflight-remediations.yml'), path.join(repo, 'governance', 'graph', 'preflight-remediations.yml'));
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module', engines: { node: '>=20.0.0' } }));
  const policy = path.join(repo, 'governance', 'required-checks.yml');
  const allowlist = path.join(repo, '.workflow', 'network-allowlist.txt');
  writeFileSync(policy, JSON.stringify({ contexts: CONTEXTS }));
  writeFileSync(allowlist, 'github.com\napi.github.com\n');
  const settings = {
    repo,
    origin: options.origin ?? 'https://github.com/fixture-owner/fixture-repo.git',
    response: options.response ?? JSON.stringify(healthy()),
    gitFails: options.gitFails ?? false,
    rebindFails: options.rebindFails ?? false,
    rebindExit: options.rebindExit ?? false,
    originExit: options.originExit ?? false,
    ghExit: options.ghExit ?? 0,
    ghSignal: options.ghSignal ?? false,
    ghHangs: options.ghHangs ?? false,
  };
  const settingsPath = path.join(repo, 'fixture-settings.json');
  const log = path.join(repo, 'fixture-requests.jsonl');
  writeFileSync(settingsPath, JSON.stringify(settings));
  const common = `import { readFileSync, appendFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(${JSON.stringify(settingsPath)}, 'utf8'));
const args = process.argv.slice(2);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('GIT_')));
const tool = process.argv[1].split('/').at(-1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool, args, cwd: process.cwd(), gitEnv }) + '\\n');
`;
  const executable = (name, body) => writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  executable('git', `${common}
if (config.gitFails) process.exit(69);
if (args.join(' ') === 'rev-parse --show-toplevel') {
  if (config.rebindExit && !process.env.GIT_DIR) { console.log(config.repo); process.exit(98); }
  console.log(config.rebindFails && !process.env.GIT_DIR ? config.repo + '/wrong-root' : config.repo);
} else if (args.join(' ') === 'remote get-url origin') {
  if (config.originExit && !process.env.GIT_DIR) { console.log(config.origin); process.exit(98); }
  console.log(process.env.GIT_DIR ? 'https://github.com/foreign-owner/foreign-repo.git' : config.origin);
} else if (args.join(' ') === 'ls-remote --exit-code origin HEAD') {
  console.log('abcdef0 HEAD');
} else if (args.join(' ') === 'rev-parse HEAD') {
  console.log('abcdef0');
} else process.exit(97);
`);
  if (!options.missingGh) executable('gh', `${common}
// Safety deadline is longer than the designed 10s API timeout but shorter
// than the fixture's 30s outer limit; even broken code leaves no live stub.
if (config.ghHangs) setTimeout(() => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'gh-deadman' }) + '\\n');
  process.exit(99);
}, 25_000);
else if (config.ghSignal) process.kill(process.pid, 'SIGTERM');
else if (config.ghExit) { console.error(${JSON.stringify(SENSITIVE_SENTINEL)}); process.exit(config.ghExit); }
else process.stdout.write(config.response);
`);
  executable('npm', 'console.log("10.0.0");\n');
  for (const name of ['gitleaks', 'semgrep', 'cosign']) {
    executable(name, `console.log(${JSON.stringify(name === 'cosign' ? 'GitVersion: fixture-version' : 'fixture-version')});\n`);
  }
  const env = {
    PATH: bin,
    HOME: path.join(repo, 'home'),
    GH_CONFIG_DIR: path.join(repo, 'gh-config'),
    LANG: 'C',
    ...options.env,
  };
  return {
    repo, outer, policy, allowlist, env,
    run({ normal = false } = {}) {
      const result = spawnSync(process.execPath, [path.join(repo, 'scripts', 'graph-preflight.mjs'), ...(normal ? [] : ['--check-only'])], {
        cwd: repo, env, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.error, undefined, result.error?.message);
      const report = JSON.parse(readFileSync(path.join(repo, '.workflow', 'state', 'preflight.json'), 'utf8'));
      const branch = report.checks.find((check) => check.id === 'branch.protection');
      assert.ok(branch, 'preflight must emit branch.protection; an absent feature is not a passing negative');
      const requests = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
      return { result, report, branch, requests };
    },
    cleanup() { rmSync(outer, { recursive: true, force: true }); },
  };
}

function withFixture(options, run) {
  const f = fixture(options);
  try { run(f); } finally { f.cleanup(); }
}

function requests(out) { return out.requests.filter((request) => request.tool === 'gh'); }
function accepted(out) {
  assert.equal(out.result.status, 0, out.result.stderr || out.result.stdout);
  assert.equal(out.report.status, 'ready');
  assert.equal(out.branch.status, 'pass');
  assert.match(out.branch.evidence, /fixture-owner\/fixture-repo/);
  assert.match(out.branch.evidence, /main/);
  assert.equal(requests(out).length, 1);
  assert.deepEqual(requests(out)[0].args, REQUEST);
  assert.equal(requests(out)[0].cwd, out.requests.find((request) => request.tool === 'git').cwd);
}
function refused(out, reason, { noRequest = false } = {}) {
  assert.equal(out.result.status, 20, out.result.stderr || out.result.stdout);
  assert.equal(out.report.status, 'needs_human');
  assert.equal(out.branch.status, 'fail');
  assert.match(out.branch.evidence, reason);
  assert.doesNotMatch(JSON.stringify(out.report) + out.result.stdout + out.result.stderr, new RegExp(SENSITIVE_SENTINEL));
  if (noRequest) assert.deepEqual(requests(out), [], 'rejected prerequisite must not invoke gh');
  else assert.deepEqual(requests(out).map((request) => request.args), [REQUEST]);
}

for (const origin of [
  'https://github.com/fixture-owner/fixture-repo.git',
  'git@github.com:fixture-owner/fixture-repo.git',
  'ssh://git@github.com/fixture-owner/fixture-repo',
]) test(`healthy protection passes for ${origin}`, () => {
  withFixture({ origin }, (f) => accepted(f.run({ normal: origin.startsWith('https:') })));
});

for (const missing of CONTEXTS) test(`missing required context ${missing} fails`, () => {
  const response = healthy();
  response.required_status_checks.contexts = CONTEXTS.filter((name) => name !== missing);
  withFixture({ response: JSON.stringify(response) }, (f) => refused(f.run(), new RegExp(missing)));
});

test('historical stratum-test does not satisfy runtime-test', () => {
  const response = healthy();
  response.required_status_checks.contexts = CONTEXTS.map((name) => name === 'runtime-test' ? 'stratum-test' : name);
  withFixture({ response: JSON.stringify(response) }, (f) => refused(f.run(), /runtime-test/));
});

test('an additional ordinary required context is accepted', () => {
  const response = healthy();
  response.required_status_checks.contexts.push('extra-owner-check');
  withFixture({ response: JSON.stringify(response) }, (f) => accepted(f.run()));
});

for (const forbidden of ['deepteam', 'Claude semantic security review']) test(`unfunded required context ${forbidden} fails`, () => {
  const response = healthy();
  response.required_status_checks.contexts.push(forbidden);
  withFixture({ response: JSON.stringify(response) }, (f) => refused(f.run(), new RegExp(forbidden, 'i')));
});

for (const [name, mutate, reason] of [
  ['non-strict checks', (r) => { r.required_status_checks.strict = false; }, /strict/i],
  ['string strict setting', (r) => { r.required_status_checks.strict = 'true'; }, /strict/i],
  ['disabled administrator enforcement', (r) => { r.enforce_admins.enabled = false; }, /admin/i],
  ['missing administrator object', (r) => { delete r.enforce_admins; }, /admin/i],
  ['one approving review', (r) => { r.required_pull_request_reviews.required_approving_review_count = 1; }, /review|approv/i],
  ['string zero reviews', (r) => { r.required_pull_request_reviews.required_approving_review_count = '0'; }, /review|approv/i],
  ['null review policy', (r) => { r.required_pull_request_reviews = null; }, /review|approv/i],
  ['null status checks', (r) => { r.required_status_checks = null; }, /status|context/i],
  ['non-array contexts', (r) => { r.required_status_checks.contexts = 'validate'; }, /context/i],
  ['non-string context', (r) => { r.required_status_checks.contexts.push(42); }, /context/i],
  ['empty context name', (r) => { r.required_status_checks.contexts.push(''); }, /context/i],
]) test(`${name} fails with its protection diagnostic`, () => {
  const response = healthy();
  mutate(response);
  withFixture({ response: JSON.stringify(response) }, (f) => refused(f.run(), reason));
});

for (const response of ['{broken-json', 'null', '[]', '{' + SENSITIVE_SENTINEL]) test(`invalid protection response ${response} fails`, () => {
  withFixture({ response }, (f) => refused(f.run(), /response|JSON|object/i));
});

for (const [name, options, reason] of [
  ['HTTP 404-style failure', { ghExit: 1 }, /gh|API|request|protection/i],
  ['terminated API process', { ghSignal: true }, /gh|API|request|signal|protection/i],
]) test(`${name} fails without dumping tool output`, () => {
  withFixture(options, (f) => refused(f.run(), reason));
});

test('hanging gh reaches the implementation timeout before the fixture timeout', () => {
  withFixture({ ghHangs: true }, (f) => {
    const out = f.run();
    refused(out, /timeout|timed out|ETIMEDOUT/i);
    assert.equal(out.requests.some((request) => request.tool === 'gh-deadman'), false, 'implementation must time out before the safety deadline');
  });
});

test('missing gh is a failed check rather than a script error', () => {
  withFixture({ missingGh: true }, (f) => refused(f.run(), /gh|unavailable|ENOENT/i, { noRequest: true }));
});

for (const [name, content] of [
  ['invalid JSON', '{broken'],
  ['empty contexts', JSON.stringify({ contexts: [] })],
  ['duplicate contexts', JSON.stringify({ contexts: [...CONTEXTS, CONTEXTS[0]] })],
  ['untrimmed context', JSON.stringify({ contexts: [...CONTEXTS, ' spaced '] })],
  ['unexpected policy key', JSON.stringify({ contexts: CONTEXTS, branch: 'other' })],
  ['unfunded DeepTeam', JSON.stringify({ contexts: [...CONTEXTS, 'deepteam'] })],
  ['unfunded Claude', JSON.stringify({ contexts: [...CONTEXTS, 'Claude semantic security review'] })],
]) test(`${name} policy fails before gh`, () => {
  withFixture({}, (f) => {
    writeFileSync(f.policy, content);
    refused(f.run(), /policy|config|context|required.checks|deepteam|Claude/i, { noRequest: true });
  });
});

for (const kind of ['missing', 'nonregular']) test(`${kind} policy fails before gh`, () => {
  withFixture({}, (f) => {
    rmSync(f.policy);
    if (kind === 'nonregular') mkdirSync(f.policy);
    refused(f.run(), /policy|config|required.checks/i, { noRequest: true });
  });
});

test('missing exact API allowlist entry withholds gh', () => {
  withFixture({}, (f) => {
    writeFileSync(f.allowlist, 'github.com\napi.github.com.example.invalid\n');
    refused(f.run(), /allowlist|api\.github\.com/i, { noRequest: true });
  });
});

for (const file of ['policy', 'allowlist']) test(`${file} redirect is refused by the new check without gh`, () => {
  withFixture({}, (f) => {
    const target = path.join(f.outer, `sibling-${file}.txt`);
    const original = readFileSync(f[file]);
    writeFileSync(target, original);
    rmSync(f[file]);
    symlinkSync(target, f[file]);
    refused(f.run(), /outside|redirect|project root/i, { noRequest: true });
    assert.deepEqual(readFileSync(target), original);
    // Legacy gitRemote reads its allowlist first. This oracle covers the new
    // check's refusal, not whole-program file-read mediation.
  });
});

for (const origin of [
  'https://example.invalid/fixture-owner/fixture-repo.git',
  'https://user:credential@github.com/fixture-owner/fixture-repo.git', // Synthetic userinfo rejection fixture; gitleaks:allow
  'https://github.com:443/fixture-owner/fixture-repo.git',
  'https://github.com/fixture-owner/fixture-repo?query=1',
  'https://github.com/fixture-owner/fixture-repo#fragment',
  'https://github.com/fixture-owner/fixture-repo/extra',
  'git@github.com:../fixture-repo.git',
  'https://github.com/fixture-owner/repo%2Fother',
]) test(`invalid origin is rejected before gh: ${origin}`, () => {
  withFixture({ origin }, (f) => refused(f.run(), /origin|GitHub|repository/i, { noRequest: true }));
});

test('ambient GH and Git routing cannot supply another project origin', () => {
  withFixture({}, (f) => {
    const hostile = {
      GH_HOST: 'foreign.invalid', GH_REPO: 'foreign-owner/foreign-repo',
      GIT_DIR: path.join(f.outer, 'other.git'), GIT_WORK_TREE: path.join(f.outer, 'other-worktree'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://github.com/foreign-owner/foreign-repo.git',
    };
    Object.assign(f.env, hostile);
    const out = f.run();
    accepted(out);
    const clean = out.requests.filter((request) => request.tool === 'git'
      && Object.entries(hostile).filter(([name]) => name.startsWith('GIT_')).every(([name, value]) => request.gitEnv[name] !== value));
    assert.ok(clean.some((request) => request.args.join(' ') === 'rev-parse --show-toplevel'), 'new root lookup must remove inherited Git routing');
    assert.ok(clean.some((request) => request.args.join(' ') === 'remote get-url origin'), 'new origin lookup must remove inherited Git routing');
  });
});

test('sanitized root mismatch after initial Git success fails instead of skipping', () => {
  withFixture({ rebindFails: true }, (f) => {
    f.env.GIT_DIR = path.join(f.outer, 'other.git');
    const out = f.run();
    assert.equal(out.report.checks.find((check) => check.id === 'git.runs').status, 'pass');
    refused(out, /root|Git|git/i, { noRequest: true });
  });
});

for (const [name, options] of [
  ['sanitized root process failure', { rebindExit: true }],
  ['sanitized origin process failure', { originExit: true }],
]) test(`${name} fails without gh after initial Git success`, () => {
  withFixture(options, (f) => {
    f.env.GIT_DIR = path.join(f.outer, 'other.git');
    const out = f.run();
    assert.equal(out.report.checks.find((check) => check.id === 'git.runs').status, 'pass');
    refused(out, /root|origin|Git|git/i, { noRequest: true });
  });
});

test('initial Git failure skips protection without gh and remains non-ready', () => {
  withFixture({ gitFails: true }, (f) => {
    const out = f.run();
    assert.equal(out.result.status, 20, out.result.stdout);
    assert.equal(out.report.status, 'needs_human');
    assert.equal(out.report.checks.find((check) => check.id === 'git.runs').status, 'fail');
    assert.equal(out.branch.status, 'skipped');
    assert.match(out.branch.evidence, /git\.runs|Git|git/i);
    assert.deepEqual(requests(out), []);
  });
});
