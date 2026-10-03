// tests/hooks/deploy-gate.test.mjs
//
// Regression + behavior-change tests for hooks/universal/pre-tool/deploy-gate.sh,
// written BEFORE its billing four-eyes check is retired (cycle
// phase1-014-retire-billing-gate; owner authorization recorded in
// .workflow/state/approvals.jsonl as `human_authorized_gate_retirement`; see
// .workflow/state/baton.md: "Regression tests for the deploy gate and
// graph-halt are written first. Only the billing two-approver requirement
// goes.").
//
// Cases (a)-(e) are the regression guard: they must keep passing after the
// hook is edited, because none of them touches the billing four-eyes check.
// Case (f) is the behavior-change test: it asserts the TARGET behavior (a
// billing-path commit with no markers exits 0), which the unmodified hook
// did not provide -- it was RED before the billing check was retired
// (2026-09-26), and still fails when this file is run against the pre-
// retirement hook through DEPLOY_GATE_HOOK, which is how the regression
// check against the original hook tells the two apart.
//
// Every test spawns the hook exactly as .claude/settings.json's PreToolUse
// wrapper does: `bash "$H" "$cmd"`, via node:child_process spawnSync with an
// argv array (never a shell, so the command string is only ever data to the
// hook, never executed). The hook resolves `.workflow/state/graph-approvals`
// and `.workflow/state/graph-halt` relative to its own cwd, so each test
// builds a fresh, disposable "project directory" via mkdtemp+realpathSync
// UNDER THE OS TEMP DIR (never nested inside this checkout's own
// .workflow/state/, unlike some sibling tests for scripts that support a
// state-dir override): deploy-gate.sh has no such override, so isolation
// here comes entirely from cwd, and nesting inside this repo would put the
// temp dir inside THIS repo's real .git -- breaking case (e), whose whole
// point is "no configured upstream", if a hook version runs git there (the
// pre-retirement hook's billing check ran `git rev-parse @{u}` and
// `git diff`, which would have resolved THIS checkout's real upstream). realpathSync resolves macOS's /tmp -> /private/tmp symlink once,
// up front, so every path this file compares against a hook- or
// git-reported path matches byte for byte. Every temp dir is removed in a
// `finally` block; the real .workflow/state/graph-halt,
// .workflow/state/graph-approvals/ and .workflow/state/graph-cycles/*/run.json
// are never created, moved or removed by this file.
//
// The hook path is overridable via DEPLOY_GATE_HOOK (default: the repo's own
// hooks/universal/pre-tool/deploy-gate.sh) so a later validator can point
// this same, unedited file at a `git show HEAD:hooks/universal/pre-tool/deploy-gate.sh`
// extracted copy and independently re-run (a)-(f) against the ORIGINAL hook.
//
// Run with: node --test tests/hooks/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = process.env.DEPLOY_GATE_HOOK
  ? path.resolve(process.env.DEPLOY_GATE_HOOK)
  : path.join(ROOT, 'hooks', 'universal', 'pre-tool', 'deploy-gate.sh');
const STAGE_BILLING_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'stage-billing-change.sh');

if (!existsSync(HOOK_PATH)) {
  throw new Error(`deploy-gate hook not found at ${HOOK_PATH} (override its location with DEPLOY_GATE_HOOK)`);
}
if (!existsSync(STAGE_BILLING_FIXTURE)) {
  throw new Error(`fixture script not found at ${STAGE_BILLING_FIXTURE}`);
}

// Base env for every spawned hook call: inherits this process's environment
// (so bash/git/jq/date resolve normally) but strips two things that must
// never leak in from the ambient session -- GIT_DIR/GIT_WORK_TREE (the hook
// itself defensively `unset`s these first, but stripping them here too means
// this file's isolation does not depend on that), and DEVOPS_GRAPH_CYCLE_ID
// (this test runs AS a subagent inside a real graph cycle, which may well
// have that variable set in the ambient environment; every case here must
// be deterministic regardless of what cycle is actually running).
//
// NOTE: this uses `delete`, not `{ GIT_DIR: undefined }` -- `delete` is an
// unambiguous, version-independent way to ensure a key is absent from the
// spawned env, without relying on how a given Node version's child_process
// happens to treat an undefined-valued key.
const BASE_ENV = { ...process.env };
// No inherited GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, which
// git exports to commit hooks, and the rest) may point a spawned hook or
// fixture at another repository.
for (const key of Object.keys(BASE_ENV)) if (key.startsWith('GIT_')) delete BASE_ENV[key];
delete BASE_ENV.DEVOPS_GRAPH_CYCLE_ID;
// A fixture's Bash must not source operator startup code or inherited functions.
for (const key of Object.keys(BASE_ENV)) if (key === 'BASH_ENV' || key === 'ENV' || key.startsWith('BASH_FUNC_')) delete BASE_ENV[key];
BASE_ENV.LC_ALL = 'C';

function makeProjectDir() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'deploy-gate-test-')));
}

function withProjectDir(fn) {
  const dir = makeProjectDir();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stateDir(projectDir) {
  const dir = path.join(projectDir, '.workflow', 'state');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHaltFile(projectDir) {
  writeFileSync(path.join(stateDir(projectDir), 'graph-halt'), '');
}

function writeDeployMarker(projectDir, cycleId) {
  const approvalsDir = path.join(stateDir(projectDir), 'graph-approvals');
  mkdirSync(approvalsDir, { recursive: true });
  writeFileSync(path.join(approvalsDir, `${cycleId}.deploy`), '{}');
}

// Runs the hook exactly as the PreToolUse wrapper in .claude/settings.json
// does: `bash "$H" "$cmd"`. spawnSync + an argv array means the command
// string is passed as plain data (argv[2] inside the hook) and is never
// interpreted by a shell here.
function runHook(projectDir, command, envOverrides = {}) {
  const result = spawnSync('bash', [HOOK_PATH, command], {
    cwd: projectDir,
    env: { ...BASE_ENV, ...envOverrides },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `spawnSync could not run the hook at ${HOOK_PATH}: ${result.error}`);
  return result;
}

function assertBlocked(result, reasonPattern) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /DEPLOY-GATE BLOCK/);
  if (reasonPattern) assert.match(result.stderr, reasonPattern);
}

const DEPLOY_COMMANDS = ['vercel deploy --prod', 'wrangler deploy', 'npm publish', 'git push --tags'];

// -- (a) a plain, non-deploy-shaped command is never gated -----------------

test('(a) regression guard: git status always exits 0', () => {
  withProjectDir((dir) => {
    const result = runHook(dir, 'git status');
    assert.equal(result.status, 0, result.stderr);
  });
});

// -- (b) regression guard: production-deploy commands need a marker -------

for (const command of DEPLOY_COMMANDS) {
  test(`(b) regression guard: production-deploy command "${command}" with no approval marker exits 2`, () => {
    withProjectDir((dir) => {
      writeRunRecord(dir, 'c-test-b');
      const result = runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'c-test-b' });
      assertBlocked(result, /no approval marker/);
    });
  });
}

// -- (c) regression guard: the same commands, with the marker, exit 0 -----

for (const command of DEPLOY_COMMANDS) {
  test(`(c) regression guard: production-deploy command "${command}" with a .deploy marker exits 0`, () => {
    withProjectDir((dir) => {
      writeRunRecord(dir, 'c-test-c');
      writeDeployMarker(dir, 'c-test-c');
      const result = runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'c-test-c' });
      assert.equal(result.status, 0, result.stderr);
    });
  });
}

// -- (d) regression guard: graph-halt blocks consequential actions only ---

test('(d) regression guard: graph-halt blocks git commit but not git status', () => {
  withProjectDir((dir) => {
    writeHaltFile(dir);

    const commitResult = runHook(dir, 'git commit -m x');
    assertBlocked(commitResult, /graph kill switch is active/);

    const statusResult = runHook(dir, 'git status');
    assert.equal(statusResult.status, 0, statusResult.stderr);
  });
});

// -- (e) regression guard: a push with no configured upstream and no ------
// -- billing change falls through to exit 0 --------------------------------

test('(e) regression guard: git push with no upstream and no billing change exits 0', () => {
  withProjectDir((dir) => {
    // Any syntactically valid 40-hex placeholder; no real commit is needed
    // because the hook only ever inspects this string, it never executes
    // it, and a fresh, non-git temp dir has no configured upstream (so the
    // pre-retirement hook's billing lookup also found nothing).
    const command = 'git push -q origin HEAD:refs/heads/feature --force-with-lease=feature:0123456789abcdef0123456789abcdef01234567';
    const result = runHook(dir, command);
    assert.equal(result.status, 0, result.stderr);
  });
});

// -- (f) behavior change (red on the pre-retirement hook): billing-path commit

test('(f) behavior change: billing-path commit exits 0 now that the four-eyes gate is retired (red on the pre-retirement hook)', () => {
  withProjectDir((dir) => {
    const fixture = spawnSync('bash', [STAGE_BILLING_FIXTURE, dir], { encoding: 'utf8', timeout: 30_000, env: BASE_ENV });
    assert.equal(fixture.error, undefined, `spawnSync could not run the fixture: ${fixture.error}`);
    assert.equal(fixture.status, 0, fixture.stderr);

    // Non-vacuousness (SAFETY RULE 3): prove the fixture staged the EXACT
    // path in the EXACT directory the hook is about to run in, BEFORE the
    // hook ever runs. Without this, an empty or wrong-dir fixture would give
    // the pre-retirement hook nothing to match, so it too would exit 0 and
    // this test would pass against both hooks without telling them apart.
    const toplevelMatch = fixture.stdout.match(/^TOPLEVEL=(.*)$/m);
    assert.ok(toplevelMatch, `fixture stdout missing TOPLEVEL=:\n${fixture.stdout}`);
    assert.equal(toplevelMatch[1], dir);
    const stagedMatch = fixture.stdout.match(/^STAGED_BEGIN\n([\s\S]*?)\nSTAGED_END$/m);
    assert.ok(stagedMatch, `fixture stdout missing STAGED block:\n${fixture.stdout}`);
    assert.deepEqual(stagedMatch[1].split('\n').filter(Boolean), ['stratum/src/billing/pricing.ts']);

    const result = runHook(dir, 'git commit -m "billing change, no markers"');

    // While still blocked, confirm it is for the RIGHT reason (the billing
    // four-eyes check firing on the staged path proven above), not some
    // unrelated cause (a leaked halt file, a missing-marker deploy-path
    // false match, etc.) that would coincidentally also exit 2. Gated on
    // status !== 0: once T2 retires the check, the hook exits 0 with no
    // block banner at all, and this reason-check must get out of the way
    // rather than failing in T2's author's face -- only the assertion just
    // below is meant to still run then.
    if (result.status !== 0) {
      assert.match(result.stderr, /DEPLOY-GATE BLOCK/);
      assert.match(result.stderr, /billing-path change/);
      assert.match(result.stderr, /needs TWO approval markers, found: 0\/2/);
    }

    // THE BEHAVIOUR CHANGE. The pre-retirement hook exits 2 here (observed
    // 2026-09-26, for the reason checked above); the current hook exits 0.
    // Run with DEPLOY_GATE_HOOK pointing at the pre-retirement hook, this
    // assertion must fail -- that is how the regression check against the
    // original hook tells the two apart.
    assert.equal(result.status, 0,
      `a billing-path commit was blocked (the pre-retirement behaviour): hook exited ${result.status}, stderr:\n${result.stderr}`);
  });
});

// MR3 / specs/graph/M-masterpiece-standard.md#AC-M16.1.
// New cases use only argv command data. The fixture writes full schema1 launch
// records, including legitimate null Workflow identity fields; no real journal.
function writeRunRecord(projectDir, cycleId, patch = {}) {
  const directory = path.join(stateDir(projectDir), 'graph-cycles', cycleId);
  mkdirSync(directory, { recursive: true });
  const record = { schema_version: 1, cycleId, backlogItem: 'MR3 synthetic fixture',
    scriptPath: path.join(projectDir, '.claude', 'workflows', 'sprint-cycle.js'),
    args: { cycleId, backlogItem: 'MR3 synthetic fixture' }, runId: null,
    journalPath: null, startedAt: '2026-10-03T00:00:00.000Z', status: 'running', ...patch };
  const file = path.join(directory, 'run.json');
  writeFileSync(file, JSON.stringify(record));
  return file;
}

function approveRunning(projectDir, cycle = 'active') {
  const record = writeRunRecord(projectDir, cycle);
  writeDeployMarker(projectDir, cycle);
  return record;
}

for (const command of ['git -C . commit -m probe', 'gh pr merge 123 --squash', 'gh release create v1.0.0', 'supabase db push', 'git -C . push origin HEAD:refs/heads/feature', 'git update-ref refs/heads/feature HEAD', 'git branch -D feature', 'git reset --hard HEAD', 'git filter-branch -- feature', 'git filter-repo --refs feature']) {
  test(`AC-M16.1 halt precedes every consequential bypass: ${command}`, () => {
    withProjectDir((dir) => {
      const record = approveRunning(dir);
      writeHaltFile(dir);
      const paths = [record, path.join(stateDir(dir), 'graph-halt'), path.join(stateDir(dir), 'graph-approvals', 'active.deploy')];
      const before = paths.map((file) => readFileSync(file, 'utf8'));
      assertBlocked(runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'active' }), /graph kill switch is active/);
      assert.deepEqual(paths.map((file) => readFileSync(file, 'utf8')), before, 'halt/run/approval authority must not be rewritten');
    });
  });
}

for (const command of ['git -C . status', 'git show v0.2.0', 'git log -1', 'git rev-parse HEAD', 'ls', 'echo git tag -d v0.2.0']) {
  test(`AC-M16.1 halted safe or inert command remains allowed: ${command}`, () => {
    withProjectDir((dir) => {
      writeHaltFile(dir);
      const result = runHook(dir, command);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(path.join(stateDir(dir), 'graph-halt')));
    });
  });
}

test('AC-M16.1 Decision13 excludes unhalted gh pr merge from cycle and marker requirements', () => {
  withProjectDir((dir) => {
    const malformed = writeRunRecord(dir, 'unrelated');
    writeFileSync(malformed, '{broken');
    const result = runHook(dir, 'gh pr merge 123 --squash');
    assert.equal(result.status, 0, result.stderr);
  });
});

for (const command of ['gh release create v1.0.0', 'supabase db push', 'git push origin v1.0.0', 'git push origin HEAD:refs/tags/new-release', 'git push origin tag release-candidate', 'git push origin --follow-tags', 'cd runtime && vercel deploy --prod', 'npx vercel deploy --prod', 'VERCEL_TOKEN=fixture vercel deploy --prod', 'echo harmless\nvercel deploy --prod']) {
  test(`AC-M16.1 deploy classification retains marker gate: ${JSON.stringify(command)}`, () => {
    withProjectDir((dir) => {
      writeRunRecord(dir, 'active');
      assertBlocked(runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'active' }), /approval marker/);
      writeDeployMarker(dir, 'active');
      const result = runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'active' });
      assert.equal(result.status, 0, result.stderr);
    });
  });
}

test('AC-M16.1 no running record cannot use current or environment-selected marker', () => {
  withProjectDir((dir) => {
    writeDeployMarker(dir, 'current');
    writeDeployMarker(dir, 'env-selected');
    assertBlocked(runHook(dir, 'vercel deploy --prod'));
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'env-selected' }));
  });
});

test('AC-M16.1 two running records are ambiguous even when environment selects a marked one', () => {
  withProjectDir((dir) => {
    approveRunning(dir, 'first');
    approveRunning(dir, 'second');
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'first' }));
  });
});

test('AC-M16.1 one valid running record with null Workflow IDs selects its own marker, ignoring other statuses and env', () => {
  withProjectDir((dir) => {
    approveRunning(dir, 'active');
    for (const status of ['completed', 'blocked', 'failed', 'indeterminate']) writeRunRecord(dir, status, { status });
    const result = runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'wrong-env' });
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(path.join(stateDir(dir), 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.at(-1).cycle, 'active');
    assert.equal(events.at(-1).event, 'deploy_gate_approved');
  });
});

test('AC-M16.1 marker for a different cycle cannot approve the sole running cycle', () => {
  withProjectDir((dir) => {
    writeRunRecord(dir, 'active');
    writeDeployMarker(dir, 'wrong');
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'wrong' }));
  });
});

for (const [name, patch] of [
  ['wrong schema', { schema_version: 2 }], ['missing cycle', { cycleId: null }],
  ['directory mismatch', { cycleId: 'other' }], ['argument cycle mismatch', { args: { cycleId: 'other' } }], ['unsafe cycle', { cycleId: '../outside' }],
  ['unknown status', { status: 'complete-ish' }], ['nonstring status', { status: ['running'] }],
]) {
  test(`AC-M16.1 malformed authority fails closed beside a valid running record: ${name}`, () => {
    withProjectDir((dir) => {
      approveRunning(dir, 'active');
      writeRunRecord(dir, 'corrupt', { status: 'completed', ...patch });
      assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
    });
  });
}

test('AC-M16.1 malformed JSON is not silently ignored beside a valid running record', () => {
  withProjectDir((dir) => {
    approveRunning(dir);
    writeFileSync(writeRunRecord(dir, 'corrupt'), '{');
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
  });
});

test('AC-M16.1 a nonregular run.json cannot be ignored beside valid running authority', () => {
  withProjectDir((dir) => {
    approveRunning(dir);
    mkdirSync(path.join(stateDir(dir), 'graph-cycles', 'nonregular', 'run.json'), { recursive: true });
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
  });
});

for (const redirected of ['record', 'directory']) {
  test(`AC-M16.1 symlinked ${redirected} cannot supply apparently harmless completed authority`, () => {
    withProjectDir((dir) => {
      approveRunning(dir);
      const target = path.join(dir, 'synthetic-record-target');
      mkdirSync(target);
      writeFileSync(path.join(target, 'run.json'), JSON.stringify({ schema_version: 1, cycleId: 'redirected', status: 'completed' }));
      const cycles = path.join(stateDir(dir), 'graph-cycles');
      if (redirected === 'record') {
        mkdirSync(path.join(cycles, 'redirected'));
        symlinkSync(path.join(target, 'run.json'), path.join(cycles, 'redirected', 'run.json'));
      } else symlinkSync(target, path.join(cycles, 'redirected'));
      assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
    });
  });
}

function stageRefs(dir) {
  const helper = path.join(import.meta.dirname, 'fixtures', 'stage-hook-refs.sh');
  const result = spawnSync('bash', [helper, dir], { env: BASE_ENV, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^TOPLEVEL=(.*)$/m)?.[1], dir);
  assert.deepEqual(result.stdout.match(/^REFS_BEGIN\n([\s\S]*?)\nREFS_END$/m)?.[1].split('\n'), [
    'refs/heads/both', 'refs/heads/branch-only', 'refs/heads/feature',
    'refs/tags/both', 'refs/tags/release-candidate', 'refs/tags/tag-only', 'refs/tags/v1.0.0',
  ]);
  return result.stdout.match(/^GIT_BIN=(.*)$/m)?.[1];
}

for (const [command, expected] of [
  ['git push origin branch-only', 0], ['git push origin tag-only', 2],
  ['git push origin both', 2], ['git push origin absent-name', 2], ['git push origin HEAD', 2],
  ['git push origin feature', 0], ['git -C "$DYNAMIC_CONTEXT" push origin branch-only', 2],
  ['git push origin release-candidate', 2],
  ['git -C "directory with spaces" push origin branch-only', 0],
  ['git -C . -C "directory with spaces" push origin branch-only', 0],
  ['git -C "directory with spaces" push origin tag-only', 2],
  ['git -C missing-directory push origin branch-only', 2],
  ['git push origin HEAD:refs/heads/feature --force-with-lease=feature:0123456789abcdef0123456789abcdef01234567', 0],
]) {
  test(`AC-M16.1 literal push identity resolves only a known local branch without tag ambiguity: ${command}`, () => {
    withProjectDir((dir) => {
      stageRefs(dir);
      if (expected === 2) writeRunRecord(dir, 'active');
      const result = runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'active' });
      if (expected === 2) assertBlocked(result); else assert.equal(result.status, 0, result.stderr);
    });
  });
}

test('AC-M16.1 external git -C is gated without attempting a lookup outside the fixture project', () => {
  withProjectDir((dir) => {
    const realGit = stageRefs(dir);
    assert.ok(realGit?.startsWith('/'));
    writeRunRecord(dir, 'active');
    const wrapperDir = path.join(dir, 'tripwire-bin');
    mkdirSync(wrapperDir);
    const sentinel = path.join(dir, 'outside-lookup-attempted');
    const outside = path.join(dir, '..', 'not-this-project');
    writeFileSync(path.join(wrapperDir, 'git'), `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$PWD" == "$MR3_OUTSIDE"* ]]; then printf attempted > "$MR3_SENTINEL"; exit 93; fi\nfor arg in "$@"; do if [[ "$arg" == "$MR3_OUTSIDE"* || "$arg" == ../not-this-project* ]]; then printf attempted > "$MR3_SENTINEL"; exit 93; fi; done\nexec "$MR3_REAL_GIT" "$@"\n`, { mode: 0o700 });
    const result = runHook(dir, 'git -C ../not-this-project push origin branch-only', {
      DEVOPS_GRAPH_CYCLE_ID: 'active', PATH: `${wrapperDir}:${BASE_ENV.PATH}`, MR3_REAL_GIT: realGit,
      MR3_OUTSIDE: path.resolve(outside), MR3_SENTINEL: sentinel,
    });
    assertBlocked(result);
    assert.equal(existsSync(sentinel), false, 'reject escaped Git context before any lookup there');
  });
});

test('AC-M16.1 real deploy wrapper preserves valid JSON command newlines and fixture root', () => {
  withProjectDir((dir) => {
    const settings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
    const wrapper = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).find((entry) => entry.command.includes('H=hooks/universal/pre-tool/deploy-gate.sh;'))?.command;
    assert.equal(typeof wrapper, 'string');
    const hookDir = path.join(dir, 'hooks', 'universal', 'pre-tool');
    mkdirSync(hookDir, { recursive: true });
    copyFileSync(HOOK_PATH, path.join(hookDir, 'deploy-gate.sh'));
    const helper = path.join(path.dirname(HOOK_PATH), 'graph-command-classifier.mjs');
    if (existsSync(helper)) copyFileSync(helper, path.join(hookDir, path.basename(helper)));
    const wrapperPath = path.join(dir, 'valid-delivery-wrapper.sh');
    writeFileSync(wrapperPath, wrapper);
    writeHaltFile(dir);
    const nested = path.join(dir, 'nested'); mkdirSync(nested);
    const command = 'echo "fixture quoted"\ngh release create v1.0.0';
    const result = spawnSync('bash', [wrapperPath], { cwd: nested, env: { ...BASE_ENV, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assertBlocked(result, /graph kill switch is active/);
    const events = readFileSync(path.join(stateDir(dir), 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].command, command);
    assert.equal(events[0].event, 'deploy_gate_block');
    assert.ok(existsSync(path.join(stateDir(dir), 'graph-halt')));
  });
});


test('AC-M16.1 a real ordinary branch remains allowed despite unrelated malformed cycle state', () => {
  withProjectDir((dir) => {
    stageRefs(dir);
    writeFileSync(writeRunRecord(dir, 'corrupt'), '{');
    const result = runHook(dir, 'git push origin feature');
    assert.equal(result.status, 0, result.stderr);
  });
});

test('AC-M16.1 symlinked state authority fails closed without following another state tree', () => {
  withProjectDir((dir) => {
    const target = path.join(dir, 'synthetic-state-target');
    mkdirSync(path.join(target, 'graph-cycles', 'active'), { recursive: true });
    mkdirSync(path.join(target, 'graph-approvals'));
    writeFileSync(path.join(target, 'graph-cycles/active/run.json'), JSON.stringify({ schema_version: 1, cycleId: 'active', status: 'running' }));
    writeFileSync(path.join(target, 'graph-approvals/active.deploy'), '{}');
    mkdirSync(path.join(dir, '.workflow'));
    symlinkSync(target, path.join(dir, '.workflow/state'));
    assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
    assert.equal(readFileSync(path.join(target, 'graph-approvals/active.deploy'), 'utf8'), '{}');
  });
});

test('AC-M16.1 a symlinked Git context cannot borrow an outside fixture branch', () => {
  withProjectDir((outside) => {
    stageRefs(outside);
    withProjectDir((dir) => {
      const realGit = stageRefs(dir);
      writeRunRecord(dir, 'active');
      symlinkSync(outside, path.join(dir, 'redirected-context'));
      const bin = path.join(dir, 'tripwire-bin'); mkdirSync(bin);
      const sentinel = path.join(dir, 'outside-lookup-attempted');
      writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$PWD" == "$MR3_OUTSIDE"* ]]; then printf attempted > "$MR3_SENTINEL"; exit 93; fi\nfor arg in "$@"; do if [[ "$arg" == "$MR3_OUTSIDE"* || "$arg" == *redirected-context* ]]; then printf attempted > "$MR3_SENTINEL"; exit 93; fi; done\nexec "$MR3_REAL_GIT" "$@"\n', { mode: 0o700 });
      assertBlocked(runHook(dir, 'git -C redirected-context push origin branch-only', {
        PATH: `${bin}:${BASE_ENV.PATH}`, MR3_REAL_GIT: realGit, MR3_OUTSIDE: outside,
        MR3_SENTINEL: sentinel, DEVOPS_GRAPH_CYCLE_ID: 'active',
      }));
      assert.equal(existsSync(sentinel), false, 'a symlink escape is denied before any Git lookup');
    });
  });
});

for (const redirected of ['.workflow', 'graph-cycles']) {
  test(`AC-M16.1 symlinked ${redirected} authority is rejected inside an owned outer fixture`, () => {
    withProjectDir((outer) => {
      const dir = path.join(outer, 'project'); mkdirSync(dir);
      const outside = path.join(outer, 'other-state'); mkdirSync(outside);
      const outsideCycles = path.join(outside, 'state', 'graph-cycles');
      mkdirSync(path.join(outsideCycles, 'active'), { recursive: true });
      const record = path.join(outsideCycles, 'active', 'run.json');
      const recordBytes = JSON.stringify({ schema_version: 1, cycleId: 'active', status: 'running' });
      writeFileSync(record, recordBytes);
      if (redirected === '.workflow') {
        mkdirSync(path.join(outside, 'state', 'graph-approvals'));
        writeFileSync(path.join(outside, 'state', 'graph-approvals', 'active.deploy'), '{}');
        symlinkSync(outside, path.join(dir, '.workflow'));
      } else {
        writeDeployMarker(dir, 'active');
        symlinkSync(outsideCycles, path.join(stateDir(dir), 'graph-cycles'));
      }
      assertBlocked(runHook(dir, 'vercel deploy --prod', { DEVOPS_GRAPH_CYCLE_ID: 'active' }));
      assert.equal(readFileSync(record, 'utf8'), recordBytes);
    });
  });
}

for (const redirected of ['gitfile', 'git-directory-symlink', 'commondir', 'refs-directory', 'loose-ref', 'packed-refs']) {
  test(`AC-M16.1 escaped ${redirected} metadata is gated before any Git plumbing invocation`, () => {
    withProjectDir((outer) => {
      const dir = path.join(outer, 'project'); const outside = path.join(outer, 'other-repo');
      mkdirSync(dir); mkdirSync(outside);
      stageRefs(dir); stageRefs(outside);
      writeRunRecord(dir, 'active');
      const gitDir = path.join(dir, '.git'); const outsideGit = path.join(outside, '.git');
      if (redirected === 'gitfile' || redirected === 'git-directory-symlink') {
        rmSync(gitDir, { recursive: true });
        if (redirected === 'gitfile') writeFileSync(gitDir, `gitdir: ${outsideGit}\n`);
        else symlinkSync(outsideGit, gitDir);
      } else if (redirected === 'commondir') writeFileSync(path.join(gitDir, 'commondir'), `${outsideGit}\n`);
      else if (redirected === 'refs-directory') {
        rmSync(path.join(gitDir, 'refs'), { recursive: true });
        symlinkSync(path.join(outsideGit, 'refs'), path.join(gitDir, 'refs'));
      } else if (redirected === 'loose-ref') {
        rmSync(path.join(gitDir, 'refs/heads/feature'));
        symlinkSync(path.join(outsideGit, 'refs/heads/feature'), path.join(gitDir, 'refs/heads/feature'));
      } else {
        const packed = path.join(outsideGit, 'packed-refs');
        writeFileSync(packed, '# pack-refs with: peeled fully-peeled sorted\n');
        symlinkSync(packed, path.join(gitDir, 'packed-refs'));
      }
      // cwd and -C may both remain inside project while Git follows metadata.
      // An all-calls tripwire proves rejection happens BEFORE invoking Git.
      const bin = path.join(dir, 'tripwire-bin'); mkdirSync(bin);
      const sentinel = path.join(dir, 'git-plumbing-attempted');
      writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\nprintf attempted > "$MR3_SENTINEL"\nexit 93\n', { mode: 0o700 });
      const result = runHook(dir, 'git push origin feature', {
        PATH: `${bin}:${BASE_ENV.PATH}`, MR3_SENTINEL: sentinel, DEVOPS_GRAPH_CYCLE_ID: 'active',
      });
      assertBlocked(result);
      assert.equal(existsSync(sentinel), false, 'unsafe metadata must be rejected before a Git process can follow it');
    });
  });
}

test('AC-M16.1 ordinary branch lookup removes inherited Git routing and config overrides', () => {
  withProjectDir((outer) => {
    const dir = path.join(outer, 'project'); const other = path.join(outer, 'other-repo');
    mkdirSync(dir); mkdirSync(other);
    const realGit = stageRefs(dir); stageRefs(other);
    assert.ok(realGit?.startsWith('/'));
    const bin = path.join(dir, 'tripwire-bin'); mkdirSync(bin);
    const sentinel = path.join(dir, 'git-override-leaked');
    const lookup = path.join(dir, 'safe-git-lookup');
    writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "${GIT_DIR:-}" == "$MR3_OTHER/.git" || "${GIT_WORK_TREE:-}" == "$MR3_OTHER" ]] || [[ "${GIT_CONFIG_COUNT:-0}" != 0 && "${GIT_CONFIG_KEY_0:-}" == core.hooksPath && "${GIT_CONFIG_VALUE_0:-}" == "$MR3_OTHER/synthetic-hooks" ]]; then\n  printf inherited-override > "$MR3_SENTINEL"; exit 93\nfi\nprintf safe > "$MR3_LOOKUP"\nexec "$MR3_REAL_GIT" "$@"\n', { mode: 0o700 });
    const result = runHook(dir, 'git push origin feature', {
      PATH: `${bin}:${BASE_ENV.PATH}`, MR3_SENTINEL: sentinel, MR3_LOOKUP: lookup, MR3_REAL_GIT: realGit, MR3_OTHER: other,
      GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(other, 'synthetic-hooks'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(sentinel), false, 'the fixed lookup must not inherit caller Git routing/config values');
    assert.equal(readFileSync(lookup, 'utf8'), 'safe', 'a real sanitized local lookup supplies the branch exception');
  });
});
