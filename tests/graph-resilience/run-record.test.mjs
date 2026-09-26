import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'scripts', 'graph-run-record.mjs');

// D1: resolve HEAD by reading the repository's own ref files instead of
// shelling out to the toolchain -- tests/hermeticity.test.mjs forbids test
// files from spawning a derivable subprocess for something a plain read
// can answer. Mirrors ref resolution precedence: HEAD -> (if the checkout
// is a worktree, its private HEAD/commondir indirection) -> a loose ref
// file if one exists, else the same ref's line in packed-refs -- a loose
// ref always overrides a stale packed-refs entry for the same name, so the
// loose file is always tried first. A non-symbolic HEAD (detached) is
// returned as-is, since it already holds the literal commit id.
function readHead(root) {
  let gitDir = path.join(root, '.git');
  if (!statSync(gitDir).isDirectory()) {
    const pointer = /^gitdir:\s*(.+)$/.exec(readFileSync(gitDir, 'utf8').trim());
    if (!pointer) throw new Error(`readHead: unrecognized .git file at ${gitDir}`);
    gitDir = path.resolve(root, pointer[1]);
  }
  const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const symbolic = /^ref:\s*(\S+)/.exec(head);
  if (!symbolic) return head;
  const ref = symbolic[1];
  const commonDirFile = path.join(gitDir, 'commondir');
  const commonDir = existsSync(commonDirFile) ? path.resolve(gitDir, readFileSync(commonDirFile, 'utf8').trim()) : gitDir;
  const loose = path.join(commonDir, ref);
  if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
  const packedRefs = path.join(commonDir, 'packed-refs');
  if (existsSync(packedRefs)) {
    for (const line of readFileSync(packedRefs, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      if (line.endsWith(` ${ref}`)) return line.slice(0, line.length - ref.length - 1).trim();
    }
  }
  throw new Error(`readHead: could not resolve ${ref} under ${commonDir}`);
}

// Live HEAD, for AC-M5.1's git_sha-freshness fixtures.
const HEAD = readHead(root);

test('run record preserves exact input and clears a block only after passing preflight', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-record-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    // AC-M5.1 will require launch to read a fresh, HEAD-matching preflight --
    // give it a valid one so this call keeps succeeding once that rule lands.
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'c7', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'c7', 'run.json');
    assert.equal(JSON.parse(readFileSync(file)).args.backlogItem, 'exact backlog text');
    const originalJournal = path.join(dir, 'wf_old', 'journal.jsonl');
    const started = run('update', '--cycle', 'c7', '--status', 'running', '--runId', 'wf_old', '--journal', originalJournal);
    assert.equal(started.status, 0, started.stderr);
    const block = path.join(dir, 'blocked.md');
    writeFileSync(block, 'blocked');
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'needs_human' }));
    const refused = run('update', '--cycle', 'c7', '--status', 'running', '--clearBlocked', 'true');
    assert.notEqual(refused.status, 0);
    assert.ok(existsSync(block));
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready' }));
    writeFileSync(block, '## Class\nneeds_human\n');
    const humanOnly = run('update', '--cycle', 'c7', '--status', 'running', '--clearBlocked', 'true');
    assert.notEqual(humanOnly.status, 0);
    assert.ok(existsSync(block));
    writeFileSync(block, '## Class\napi\n');
    const incomplete = run('update', '--cycle', 'c7', '--status', 'running', '--runId', 'wf_new', '--resumedFrom', 'wf_old', '--clearBlocked', 'true');
    assert.notEqual(incomplete.status, 0);
    assert.ok(existsSync(block));
    const resumeArgs = { backlogItem: 'exact backlog text', cycleId: 'c7', plan: { tasks: [{ id: 'T1' }] },
      priorBuildResults: [], priorCoderResults: [], resumedFrom: 'wf_old' };
    const newJournal = path.join(dir, 'wf_new', 'journal.jsonl');
    // AC-M5.1 will also require clearBlocked's preflight.ran_at to be newer
    // than blocked.md's mtime -- keep this final, intended-to-succeed call
    // valid under that rule too, without touching the earlier intended-to-fail
    // calls' preflight/blocked state above (block still reads '## Class\napi\n').
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD,
      ran_at: new Date(statSync(block).mtimeMs + 5000).toISOString() }));
    const resumed = run('update', '--cycle', 'c7', '--status', 'running', '--runId', 'wf_new', '--journal', newJournal,
      '--args', JSON.stringify(resumeArgs), '--resumedFrom', 'wf_old', '--clearBlocked', 'true');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(existsSync(block), false);
    const record = JSON.parse(readFileSync(file));
    assert.equal(record.runId, 'wf_new');
    assert.equal(record.journalPath, newJournal);
    assert.deepEqual(record.args, resumeArgs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- REQ-M3: 'indeterminate' becomes a valid run-record status -------------

test('AC-M3.1: update --status indeterminate is accepted', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m3-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'm3', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    const updated = run('update', '--cycle', 'm3', '--status', 'indeterminate');
    // Today's status allowlist is ['running', 'blocked', 'completed', 'failed'];
    // 'indeterminate' is rejected as an "invalid run update".
    assert.equal(updated.status, 0, updated.stderr);
    const file = path.join(dir, 'graph-cycles', 'm3', 'run.json');
    assert.equal(JSON.parse(readFileSync(file)).status, 'indeterminate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- REQ-M5: launch and unblock are bound to a fresh preflight -------------

test('AC-M5.1: launch refuses (and writes no run.json) when preflight.json git_sha does not match HEAD', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-sha-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: '0'.repeat(40), ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'm5-sha', '--backlog', 'x');
    // Today launch never reads preflight.json at all -- it only checks
    // --backlog and that the cycle id is new.
    assert.notEqual(launched.status, 0);
    assert.equal(existsSync(path.join(dir, 'graph-cycles', 'm5-sha', 'run.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-M5.1: launch refuses when preflight.json ran_at is more than 15 minutes old', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-stale-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD,
      ran_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() }));
    const launched = run('launch', '--cycle', 'm5-stale', '--backlog', 'x');
    assert.notEqual(launched.status, 0);
    assert.equal(existsSync(path.join(dir, 'graph-cycles', 'm5-stale', 'run.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Security finding (cycle 8 security-stage review of AC-M5.1's own diff):
// requireFreshPreflight's staleness check is `Date.now() - ranAt > 15 min`,
// a one-sided bound -- a future-dated ran_at makes that subtraction negative,
// so it never trips and reads as "fresh" with no upper bound. Otherwise a
// fully valid fixture (status ready, HEAD-matching git_sha) must still be
// refused when ran_at is ahead of now by more than the clock-skew allowance.
test('AC-M5.1: launch refuses (and writes no run.json) when preflight.json ran_at is more than 60 seconds in the future', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-future-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD,
      ran_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }));
    const launched = run('launch', '--cycle', 'm5-future', '--backlog', 'x');
    assert.notEqual(launched.status, 0);
    assert.equal(existsSync(path.join(dir, 'graph-cycles', 'm5-future', 'run.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage (independent of the coder's case above): the fix's
// 60-second clock-skew allowance is load-bearing -- the file's very first
// test ("run record preserves exact input...") sets a resume fixture's
// ran_at to `blocked.md mtime + 5000ms`, a few seconds ahead of real now,
// and depends on that allowance to keep passing -- but nothing previously
// asserted that the allowance actually accepts a value inside it, only that
// +10 minutes is refused. Without this, the bound could regress to 0s (or
// vanish) and every existing "in the future" test would stay green while
// silently breaking the legitimate small-skew case.
test('AC-M5.1: launch accepts preflight.json ran_at up to 60 seconds in the future (clock-skew allowance)', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-skew-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD,
      ran_at: new Date(Date.now() + 30 * 1000).toISOString() }));
    const launched = run('launch', '--cycle', 'm5-skew', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    assert.ok(existsSync(path.join(dir, 'graph-cycles', 'm5-skew', 'run.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC-M5.1: update --clearBlocked true throws when blocked.md is newer than preflight.json ran_at', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-block-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    // ran_at is backdated 10s so that blocked.md's real (roughly "now") mtime
    // is unambiguously newer than it, without needing to touch any mtime.
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD,
      ran_at: new Date(Date.now() - 10000).toISOString() }));
    const launched = run('launch', '--cycle', 'm5-block', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    const block = path.join(dir, 'blocked.md');
    writeFileSync(block, '## Class\napi\n');
    const refused = run('update', '--cycle', 'm5-block', '--status', 'running', '--clearBlocked', 'true');
    // Today clearBlocked only checks preflight.status ('ready'/'remediated');
    // it never compares ran_at against blocked.md's mtime.
    assert.notEqual(refused.status, 0);
    assert.ok(existsSync(block));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Backlog T4 (security finding 1): requireFreshPreflight read
// .workflow/state/preflight.json via a plain readFileSync with no
// symlink-escape guard -- unlike this same file's existing guard on
// run.json, `realpathSync(file) !== file` (in the 'update' branch above). A
// preflight.json symlinked to an otherwise-fully-valid, HEAD-matching
// preflight file elsewhere let launch through on the pointed-to file's
// content.
test('AC-M5.1: launch refuses (and writes no run.json) when preflight.json is a symlink to an otherwise-valid file', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-symlink-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    // The symlink target is a separately-written, otherwise-valid,
    // HEAD-matching preflight file elsewhere inside the same temp dir, so it
    // is cleaned up along with everything else in the finally block below.
    const real = path.join(dir, 'preflight-real.json');
    writeFileSync(real, JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    symlinkSync(real, path.join(dir, 'preflight.json'));
    const launched = run('launch', '--cycle', 'm5-symlink', '--backlog', 'x');
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /redirected/);
    assert.equal(existsSync(path.join(dir, 'graph-cycles', 'm5-symlink', 'run.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage (T4 verification): the fix above gates on
// `existsSync(preflightFile) && realpathSync(...) !== preflightFile`, not a
// bare `realpathSync(...) !== preflightFile` -- the existsSync half of that
// conjunction is load-bearing. A genuinely missing preflight.json must keep
// failing with its original ENOENT from readFileSync, not get relabeled
// 'redirected' by the new guard (realpathSync on a nonexistent path itself
// throws ENOENT, which would masquerade as the wrong error if the guard ran
// unconditionally). Nothing before this asserted that distinction.
test('AC-M5.1: launch still fails with the original ENOENT (not "redirected") when preflight.json is simply missing', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ac-m5-enoent-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    const launched = run('launch', '--cycle', 'm5-enoent', '--backlog', 'x');
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /ENOENT/);
    assert.doesNotMatch(launched.stderr, /redirected/);
    assert.equal(existsSync(path.join(dir, 'graph-cycles', 'm5-enoent', 'run.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- REQ-M7: update --ack records the owner's acknowledgements -------------
// Not named by an explicit AC in the backlog's T6 list (see the task's
// flagged ambiguity); added per this project's general proof-of-work
// convention. Shape per the spec text (specs/graph/M-masterpiece-standard.md
// REQ-M7): `acknowledgements: [{item, answer, at}]`, appended onto -- never
// replacing -- any prior entries, consistent with how every other `update`
// field layers onto the existing record instead of overwriting it.

test('update --ack appends {item, answer, at} entries onto run.json acknowledgements and rejects malformed input without touching the record', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ack-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'ack1', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'ack1', 'run.json');

    // A plain status update with no --ack must not touch acknowledgements.
    const plain = run('update', '--cycle', 'ack1', '--status', 'running');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(readFileSync(file)).acknowledgements, undefined);

    const first = [{ item: 'planner said X or Y, which wins?', answer: 'Y wins', at: '2026-09-25T20:10:00.000Z' }];
    const firstUpdate = run('update', '--cycle', 'ack1', '--status', 'running', '--ack', JSON.stringify(first));
    assert.equal(firstUpdate.status, 0, firstUpdate.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file)).acknowledgements, first);

    // A second call appends -- with a conflicts[]-shaped item (an object,
    // not a string) -- and must not overwrite the first entry.
    const second = [{ item: { higher: 'AGENTS.md precedence line', lower: 'plan.md', clause: 'owner decision > plan' },
      answer: 'owner confirmed', at: '2026-09-25T20:11:00.000Z' }];
    const secondUpdate = run('update', '--cycle', 'ack1', '--status', 'running', '--ack', JSON.stringify(second));
    assert.equal(secondUpdate.status, 0, secondUpdate.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file)).acknowledgements, [...first, ...second]);

    // Malformed input is rejected, and every rejection leaves the record
    // (including its accumulated acknowledgements) byte-for-byte unchanged.
    const before = readFileSync(file, 'utf8');
    const rejects = [
      '{"item":"x","answer":"y","at":"2026-09-25T20:12:00.000Z"}', // object, not an array
      '[]', // an ack that acknowledges nothing is a caller bug
      '[{"answer":"y","at":"2026-09-25T20:12:00.000Z"}]', // missing item
      '[{"item":"x","at":"2026-09-25T20:12:00.000Z"}]', // missing answer
      '[{"item":"x","answer":""}]', // empty answer, and missing at
      '[{"item":"x","answer":"y","at":"not-a-date"}]', // unparseable at
      '[{"item":"x","answer":"y","at":"2026-09-25T20:12:00.000Z"},"not-an-object"]', // one bad entry taints the batch
      'not json at all',
    ];
    for (const bad of rejects) {
      const rejected = run('update', '--cycle', 'ack1', '--status', 'running', '--ack', bad);
      assert.notEqual(rejected.status, 0, `expected rejection for ${bad}`);
      assert.equal(readFileSync(file, 'utf8'), before, `record must be unchanged after rejecting ${bad}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage gap (independent of the coder's case above): the
// on-disk guard at graph-run-record.mjs's `record.acknowledgements !==
// undefined && !Array.isArray(record.acknowledgements)` check has no test.
// A hand-edited or otherwise corrupted run.json could hold a non-array
// acknowledgements field; --ack must refuse to append onto it rather than
// silently coercing or clobbering.
test('update --ack rejects when the existing on-disk acknowledgements field is not an array, without touching the record', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-ack-guard-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'ackguard', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'ackguard', 'run.json');

    const corrupted = { ...JSON.parse(readFileSync(file, 'utf8')), acknowledgements: 'not-an-array' };
    writeFileSync(file, `${JSON.stringify(corrupted, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(file, 'utf8');

    const good = [{ item: 'x', answer: 'y', at: '2026-09-25T20:13:00.000Z' }];
    const rejected = run('update', '--cycle', 'ackguard', '--status', 'running', '--ack', JSON.stringify(good));
    assert.notEqual(rejected.status, 0, rejected.stderr);
    assert.equal(readFileSync(file, 'utf8'), before, 'record must be unchanged when the existing acknowledgements field is not an array');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- D1: readHead(root) self-check against graph-preflight.sh's own report -

test('AC-D1.1: readHead(root) agrees with graph-preflight --check-only report git_sha', (t) => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-readhead-test-'));
  const reportPath = path.join(dir, 'preflight-report.json');
  const env = { ...process.env, GRAPH_PREFLIGHT_REPORT: reportPath };
  try {
    // Spawning bash on this repo's own script is fine under the hermeticity
    // rule; only a direct toolchain subprocess (git among them) is not. The
    // exit code (0/10/20) is deliberately not asserted on -- it swings on
    // this machine's live tool/dependency checks, unrelated to git_sha --
    // and --check-only means no check attempts a live repair either.
    spawnSync('bash', [path.join(root, 'scripts', 'graph-preflight.sh'), '--check-only'], { cwd: root, env, encoding: 'utf8' });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report.git_sha === null) {
      // Only happens when git itself failed inside graph-preflight.mjs:
      // either its own git.runs check failed (main() still completes, no
      // report.error field), or the whole script threw first (report.error
      // present). Either way there is nothing for readHead to agree with.
      t.skip(`graph-preflight reported no git_sha; report.error=${report.error ?? '(none -- its git.runs check failed)'}`);
      return;
    }
    assert.equal(readHead(root), report.git_sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
