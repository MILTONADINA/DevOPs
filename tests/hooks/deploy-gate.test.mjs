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
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
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
      const result = runHook(dir, command, { DEVOPS_GRAPH_CYCLE_ID: 'c-test-b' });
      assertBlocked(result, /no approval marker/);
    });
  });
}

// -- (c) regression guard: the same commands, with the marker, exit 0 -----

for (const command of DEPLOY_COMMANDS) {
  test(`(c) regression guard: production-deploy command "${command}" with a .deploy marker exits 0`, () => {
    withProjectDir((dir) => {
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
