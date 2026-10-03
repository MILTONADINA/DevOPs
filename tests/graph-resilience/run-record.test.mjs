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

// --- D1 (PB-74): resume args.acknowledgements ({item, answer}) validation --
// sprint-cycle.js needs the owner's acknowledgement answers to reach the five
// downstream roles' prompts on a resume (never the preflight or planner), carried
// through the resume-args block's
// `args.acknowledgements`. This is a lighter 2-field shape than --ack's own
// {item, answer, at} `isAcknowledgement` validator above: `at` is not
// required here. A single combined test, not split accept/reject cases --
// on the pre-fix tree nothing validates args.acknowledgements at all, so an
// accept-only test would pass vacuously; only asserting the rejections too
// makes this red before the fix lands.

test('resume update --args acknowledgements accepts {item, answer} entries and rejects malformed ones without touching the record', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-d1-ack-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'd1ack', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'd1ack', 'run.json');

    const started = run('update', '--cycle', 'd1ack', '--runId', 'A', '--status', 'running');
    assert.equal(started.status, 0, started.stderr);

    const newJournal = path.join(dir, 'B', 'journal.jsonl');
    const base = { cycleId: 'd1ack', backlogItem: 'exact backlog text', resumedFrom: 'A',
      plan: { tasks: [{ id: 'T1' }] }, priorBuildResults: [], priorCoderResults: [] };
    const resume = (acknowledgements) => run('update', '--cycle', 'd1ack', '--runId', 'B', '--resumedFrom', 'A',
      '--journal', newJournal, '--status', 'running', '--args', JSON.stringify({ ...base, acknowledgements }));

    // Snapshot right after the last call that is meant to succeed, and before
    // any of the malformed resume attempts below (which must all leave this
    // byte-for-byte unchanged). Every rejected variant below reuses --runId B
    // / --resumedFrom A: record.runId must stay 'A' throughout so each
    // attempt keeps hitting the same resume-args branch instead of being
    // skipped as a no-op same-runId update.
    const before = readFileSync(file, 'utf8');

    const rejects = [
      ['non-array', { item: 'x', answer: 'y' }],
      ['entry missing answer', [{ item: 'x' }]],
      ['entry with empty-string answer', [{ item: 'x', answer: '' }]],
      ['entry missing item', [{ answer: 'y' }]],
    ];
    for (const [label, acknowledgements] of rejects) {
      const rejected = resume(acknowledgements);
      assert.notEqual(rejected.status, 0, `expected rejection for ${label}`);
      assert.match(rejected.stderr, /acknowledgements/, `expected an acknowledgements-specific error for ${label}`);
      assert.equal(readFileSync(file, 'utf8'), before, `record must be unchanged after rejecting ${label}`);
    }

    // A conflicts[]-shaped item (an object, not a string) is valid too --
    // mirrors --ack's own isAcknowledgement, which this validator does not
    // reuse but agrees with on what counts as a "present" item.
    const good = [{ item: 'plain string item', answer: 'y' },
      { item: { higher: 'AGENTS.md precedence line', lower: 'plan.md', clause: 'owner decision > plan' }, answer: 'z' }];
    const resumed = resume(good);
    assert.equal(resumed.status, 0, resumed.stderr);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.runId, 'B');
    assert.equal(record.journalPath, newJournal);
    assert.deepEqual(record.args.acknowledgements, good);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage (independent of the coder's combined case above):
// three properties the case above doesn't exercise, each a plausible
// regression a future refactor could introduce silently:
//   1. hasItemAndAnswer checks item's PRESENCE (`!== undefined && !==
//      null`), not truthiness -- `0` and `false` are legitimate items. A
//      refactor to `if (!entry.item)` would silently start rejecting these.
//   2. `entry !== null` is checked before any `entry.item`/`entry.answer`
//      property read -- without it, a null array entry crashes with an
//      unrelated "Cannot read properties of null" TypeError instead of the
//      validator's own message (both are a non-zero exit, so only the
//      message content -- asserted below -- would catch this guard's
//      removal).
//   3. Extra fields on an entry (e.g. `at`) are tolerated, not rejected --
//      confirms the documented forward-compat intent noted above the
//      validator: a full {item, answer, at} entry (the same shape --ack's
//      isAcknowledgement writes onto record.acknowledgements) still passes
//      this lighter 2-field check.
test('resume update --args acknowledgements: item presence (not truthiness), a null entry, and extra fields', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-d1-ack-edge-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'd1ackedge', '--backlog', 'x');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'd1ackedge', 'run.json');
    const started = run('update', '--cycle', 'd1ackedge', '--runId', 'A', '--status', 'running');
    assert.equal(started.status, 0, started.stderr);

    const newJournal = path.join(dir, 'B', 'journal.jsonl');
    const base = { cycleId: 'd1ackedge', backlogItem: 'x', resumedFrom: 'A',
      plan: { tasks: [{ id: 'T1' }] }, priorBuildResults: [], priorCoderResults: [] };
    const resume = (acknowledgements) => run('update', '--cycle', 'd1ackedge', '--runId', 'B', '--resumedFrom', 'A',
      '--journal', newJournal, '--status', 'running', '--args', JSON.stringify({ ...base, acknowledgements }));

    const before = readFileSync(file, 'utf8');
    const rejected = resume([null]);
    assert.notEqual(rejected.status, 0, 'expected rejection for a null array entry');
    assert.match(rejected.stderr, /acknowledgements/, "a null entry must fail the validator's own check, not crash with an unrelated TypeError");
    assert.equal(readFileSync(file, 'utf8'), before, 'record must be unchanged after rejecting a null entry');

    const good = [{ item: 0, answer: 'zero is a legitimate item' },
      { item: false, answer: 'false is a legitimate item' },
      { item: 'x', answer: 'y', at: '2026-09-26T00:00:00.000Z' }];
    const resumed = resume(good);
    assert.equal(resumed.status, 0, resumed.stderr);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(record.args.acknowledgements, good);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- D2 (PB-68): every run id a cycle has resumed through, not just the ----
// single most recent one resumedFrom already tracks -------------------------
// scripts/graph-run-record.mjs update --resumedFrom overwrites
// record.resumedFrom on every resume, so after a second resume the first
// run's id is gone from run.json -- record.priorRunIds is meant to
// accumulate every one of them instead. On the pre-fix tree nothing
// populates priorRunIds at all, so only asserting its full accumulated list
// (not merely that resumedFrom still names the latest) makes this red.
// Same complete-resume pattern as the D1 test above: a fresh HEAD-matching
// preflight.json via readHead, full valid --args on each resume, no
// --clearBlocked.

test('two successive resume updates accumulate every prior run id onto priorRunIds while resumedFrom keeps only the latest', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-d2-priorrunids-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'd2prior', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'd2prior', 'run.json');

    const started = run('update', '--cycle', 'd2prior', '--runId', 'A', '--status', 'running');
    assert.equal(started.status, 0, started.stderr);

    const argsFor = (resumedFrom) => ({ cycleId: 'd2prior', backlogItem: 'exact backlog text', resumedFrom,
      plan: { tasks: [{ id: 'T1' }] }, priorBuildResults: [], priorCoderResults: [] });

    // Resume 1: A -> B.
    const journalB = path.join(dir, 'B', 'journal.jsonl');
    const resumedToB = run('update', '--cycle', 'd2prior', '--runId', 'B', '--resumedFrom', 'A',
      '--journal', journalB, '--status', 'running', '--args', JSON.stringify(argsFor('A')));
    assert.equal(resumedToB.status, 0, resumedToB.stderr);

    // Resume 2: B -> C.
    const journalC = path.join(dir, 'C', 'journal.jsonl');
    const resumedToC = run('update', '--cycle', 'd2prior', '--runId', 'C', '--resumedFrom', 'B',
      '--journal', journalC, '--status', 'running', '--args', JSON.stringify(argsFor('B')));
    assert.equal(resumedToC.status, 0, resumedToC.stderr);

    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.runId, 'C');
    assert.equal(record.resumedFrom, 'B');
    assert.deepEqual(record.priorRunIds, ['A', 'B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage gap (independent of the coder's case above, and
// explicitly flagged as untested in the coder's own report): D2's on-disk
// guard at graph-run-record.mjs's `record.priorRunIds !== undefined &&
// !Array.isArray(record.priorRunIds)` check has no test. Mirrors the
// existing acknowledgements corruption-guard test above (same file, same
// pattern, sibling field): a hand-edited or otherwise corrupted run.json
// could hold a non-array priorRunIds field, and a resume must refuse to
// append onto it rather than silently coercing or clobbering.
test('resume update rejects when the existing on-disk priorRunIds field is not an array, without touching the record', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-d2-priorrunids-guard-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'd2guard', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'd2guard', 'run.json');
    const started = run('update', '--cycle', 'd2guard', '--runId', 'A', '--status', 'running');
    assert.equal(started.status, 0, started.stderr);

    const corrupted = { ...JSON.parse(readFileSync(file, 'utf8')), priorRunIds: 'not-an-array' };
    writeFileSync(file, `${JSON.stringify(corrupted, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(file, 'utf8');

    const journalB = path.join(dir, 'B', 'journal.jsonl');
    const resumeArgs = { cycleId: 'd2guard', backlogItem: 'exact backlog text', resumedFrom: 'A',
      plan: { tasks: [{ id: 'T1' }] }, priorBuildResults: [], priorCoderResults: [] };
    const rejected = run('update', '--cycle', 'd2guard', '--runId', 'B', '--resumedFrom', 'A',
      '--journal', journalB, '--status', 'running', '--args', JSON.stringify(resumeArgs));
    assert.notEqual(rejected.status, 0, rejected.stderr);
    assert.match(rejected.stderr, /priorRunIds/, 'expected a priorRunIds-specific error, not a silent coercion');
    assert.equal(readFileSync(file, 'utf8'), before, 'record must be unchanged when the existing priorRunIds field is not an array');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Tester-added coverage: the linear A->B->C case above never revisits an id,
// so it cannot distinguish "append" from "append without checking for a
// duplicate first" -- it would pass identically even if the `includes`
// dedup guard were deleted outright. This test hand-seeds priorRunIds with
// the cycle's OWN current runId before the next resume, so that resume's
// captured pre-update id is already present in the list: post-fix, that id
// must be skipped (not duplicated) while the following resume's id is
// still appended normally, proving the guard skips only true duplicates.
test('a resume skips appending onto priorRunIds when the pre-update runId is already present, but still appends a genuinely new one', () => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-d2-priorrunids-dedup-test-'));
  const env = { ...process.env, GRAPH_STATE_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    writeFileSync(path.join(dir, 'preflight.json'), JSON.stringify({ status: 'ready', git_sha: HEAD, ran_at: new Date().toISOString() }));
    const launched = run('launch', '--cycle', 'd2dedup', '--backlog', 'exact backlog text');
    assert.equal(launched.status, 0, launched.stderr);
    const file = path.join(dir, 'graph-cycles', 'd2dedup', 'run.json');
    const started = run('update', '--cycle', 'd2dedup', '--runId', 'A', '--status', 'running');
    assert.equal(started.status, 0, started.stderr);

    // Hand-seed priorRunIds with 'A' -- the exact id this cycle's runId
    // already is, and therefore the exact id the next resume's capture
    // (record.runId, read before the overwrite) will produce.
    const seeded = { ...JSON.parse(readFileSync(file, 'utf8')), priorRunIds: ['A'] };
    writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`);

    const argsFor = (resumedFrom) => ({ cycleId: 'd2dedup', backlogItem: 'exact backlog text', resumedFrom,
      plan: { tasks: [{ id: 'T1' }] }, priorBuildResults: [], priorCoderResults: [] });

    // Resume 1: A -> B. Captured priorRunId is 'A', already in the seeded
    // list -- must be skipped, not duplicated.
    const journalB = path.join(dir, 'B', 'journal.jsonl');
    const resumedToB = run('update', '--cycle', 'd2dedup', '--runId', 'B', '--resumedFrom', 'A',
      '--journal', journalB, '--status', 'running', '--args', JSON.stringify(argsFor('A')));
    assert.equal(resumedToB.status, 0, resumedToB.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).priorRunIds, ['A'], 'a duplicate id must not be appended');

    // Resume 2: B -> C. Captured priorRunId is 'B', genuinely new -- must
    // be appended, proving the dedup guard above only skips true duplicates.
    const journalC = path.join(dir, 'C', 'journal.jsonl');
    const resumedToC = run('update', '--cycle', 'd2dedup', '--runId', 'C', '--resumedFrom', 'B',
      '--journal', journalC, '--status', 'running', '--args', JSON.stringify(argsFor('B')));
    assert.equal(resumedToC.status, 0, resumedToC.stderr);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.runId, 'C');
    assert.deepEqual(record.priorRunIds, ['A', 'B']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- D1: readHead(root) self-check against graph-preflight.sh's own report -

test('AC-D1.1: readHead(root) agrees with graph-preflight --check-only report git_sha', (t) => {
  const dir = mkdtempSync(path.join(root, '.workflow', 'state', 'graph-readhead-test-'));
  const reportPath = path.join(dir, 'preflight-report.json');
  const fakeBin = path.join(dir, 'fake-gh');
  mkdirSync(fakeBin);
  const protection = {"required_status_checks":{"strict":true,"contexts":["validate","runtime-test","setup-linux","gitleaks","semgrep","dependency-audit"]},"enforce_admins":{"enabled":true},"required_pull_request_reviews":{"required_approving_review_count":0}};
  writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(protection)}'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, GRAPH_PREFLIGHT_REPORT: reportPath };
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
