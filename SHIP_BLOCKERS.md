# Ship Blockers — Gaps Between Now and a Shippable Masterpiece

**Produced**: 2026-09-14, via a systematic audit (3 parallel investigations covering
DevOps core, Stratum, and cross-cutting consistency) that checked actual runtime
state — ran the test commands, ran the claim validator, checked live CI run
history, computed real hashes — rather than trusting what docs claim.

**Headline finding**: the most serious gaps here are not "features not yet built."
They are **claims the project already makes about itself that are currently
false** — a validator that doesn't validate, CI that's been silently red for a
week, a pruner that fails its own benchmark, test suites that don't run. A
masterpiece can't be built on top of broken instrumentation. Section 1 is the
priority; everything else is real but lower urgency.

---

## 1. Critical — active defects, not missing features

These are things the project currently *claims* are true (in docs, in its own
"sealed" closures) that are not true right now. Fix these before anything else,
because they're what everything else would be verified against.

### 1.1 The claim/proof-of-work system — resolved 2026-09-14, was ~97% non-functional

**Original finding**: only 3 of 97 claims validated. 92 failures were
`git_sha does not exist in this repository`.

**Root cause was wrong-ish**: not destroyed history, and not primarily
squash-merges rewriting SHAs away. The commits were never gone — GitHub
retains a squash-merged PR's original commits, reachable by SHA via its API
and via `git fetch origin <sha>`, for a long time after the source branch
is deleted. A plain `git fetch origin` only follows *existing* branch/tag
refs, so it never pulled these back in — that's the actual mechanism, not
history destruction.

**Fix applied**: `scripts/recover-claim-provenance.sh` — fetches each
missing SHA individually (`git fetch origin <sha>`, verified 52/52 distinct
missing SHAs recoverable this way) and anchors it under
`refs/claim-provenance/<sha>` so it survives `git gc` (a plain fetch only
updates the ephemeral `FETCH_HEAD`, which the next fetch overwrites,
leaving the object unreachable and prunable again). Zero claim YAML
rewritten, zero validator logic changed, nothing force-pushed or deleted.

**Result**: `npm run validate:claims` went from **3/97 to 87/120 passing**
(total claim count grew slightly from graph-engineering-cycle proof
artifacts created during this session). The recovered refs are local-only
so far — **not yet pushed to origin** (`scripts/recover-claim-provenance.sh
--push` does that; left as an explicit human decision rather than a
default, since it writes new refs to the shared remote).

**Remaining failures (33 at first count, 29 after the 1.3 cycle's remediation — 97/126 passing; 97/130 on 2026-09-15 after the third adversarial pass under the full, re-running `npm run validate:claims` — 104/130 under `--no-rerun`, the difference being seven legacy `claim-2026-05-22-*` proofs whose re-run now exits 1 (pre-existing drift, on the triage list below); the 4 newest failures are cycle 6's own claims 032–035, which validate once that cycle's files are committed) are a different, smaller, separate issue**, not
part of this item's original scope: 11 "missing or empty files_changed",
10 "re-run exit code 1 != expected 0" (real drift, needs individual
triage), and ~12 "invalid spec_ref" — mostly on *new* claims the
graph-engineering pipeline's own tester subagents created this session as
proof artifacts, using spec_ref values (like `"graph task T9"`) that don't
match the validator's expected format. Worth a follow-up fix to
`sprint-cycle.js`'s tester prompt so future cycles produce claims that
actually validate; not urgent since it doesn't affect the historical-claim
recovery this item was about.

**Update, later 2026-09-14**: the invalid-spec_ref root cause is fixed going forward — `.claude/workflows/sprint-cycle.js`'s tester and security prompts now state the claim schema (next-free id, a `specs/` anchor, tracked-only `files_changed`, a re-runnable `test_command`, the hash formula, no dependence on npm verbosity or on HEAD equalling a fixed SHA). The ~10 existing invalid-spec_ref claims from cycles 1–4 and the 7 legacy `claim-2026-05-22-*` re-run failures remain to be triaged individually; none affect the historical-claim recovery this item was about.

### 1.2 CI has been silently red for 7+ days on `main`, including a sealed Phase 2 security control

Confirmed via `gh run list` / `gh run view --log-failed`:

- **"Security scan"** workflow — failing on every scheduled run from
  2026-09-08 through 2026-09-14 (7/7). Root cause: the DeepTeam OWASP-ASI
  red-team step — **one of Phase 2 Area B's sealed "✅ Closed" deliverables**
  — errors `ERROR: DeepTeam not installed` despite `pip install` reporting
  success immediately above it in the same job (environment/PATH bug in the
  workflow, not a code defect). A previously-sealed security control has
  regressed in CI and nobody caught it.
- **"Refresh Sigstore trust bundle"** workflow — failing daily:
  `curl: (22) 404` against `https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json`
  (upstream Sigstore TUF path changed). The offline verification trust
  bundle (`.workflow/sigstore/trust-bundle.json`) has not been refreshed.
- Separately, gitleaks is flagging `stratum/test/billing/verify-stripe.test.ts:16,20`
  as containing real Stripe secrets — **confirmed false positive** (they're
  literal test fixtures for a key-classifier unit test), but there's no
  allowlist entry, so it blocks the pipeline regardless.

**Action**: fix the DeepTeam install step (likely a venv/PATH issue in the
workflow YAML), fix or replace the Sigstore TUF URL, add a gitleaks allowlist
entry for the test fixture file. All three are small, mechanical fixes —
there's no excuse for CI staying red this long undetected. Consider adding
a notification (Slack/email) on scheduled-workflow failure so this doesn't
recur silently.

### 1.3 Neither project's test suite currently runs — partially resolved 2026-09-14

- **DevOps core**: there is no root-level `test` script in `package.json` at
  all. The one eval mechanism that exists — `test:skills` — crashes
  immediately: `Cannot find module '.../governance/skill-evals/run-evals.js'`.
  `governance/skill-evals/registry.yml` defines real eval prompts and
  expected behaviors for skills, but **nothing has ever executed them** —
  it's a spec with no runner behind it.
- **Stratum**: `npm test` → `sh: node_modules/.bin/vitest: Permission denied`
  (the binary is `-rw-r--r--`, missing the execute bit). Bypassing via
  `node node_modules/vitest/vitest.mjs run` hits a second, deeper break:
  `Cannot find module @rollup/rollup-darwin-arm64` (the known npm
  optional-dependencies bug; needs `rm -rf node_modules package-lock.json &&
  npm i`). **The test-count claims in `docs/LAUNCH_READINESS.md` (e.g. "246
  pass + 5 todo", "97 passing + 5 todo") cannot currently be independently
  verified.**

**Action**: (a) `chmod +x` the vitest binary or force a clean reinstall for
Stratum, verify the rollup native module resolves; (b) either write the
missing `governance/skill-evals/run-evals.js` runner for DevOps-core, or
remove the dangling `test:skills` script until it's real; (c) add both to
CI so this can't silently regress again.

**Update 2026-09-14 — partially resolved.** Actions (a) and (b) are done;
(c) was not part of this backlog item and remains open. Worked via the
graph-engineering pipeline (cycle `ship-blockers-1-3`); every figure below
is taken from that cycle's capture files under
`.workflow/state/graph-cycles/ship-blockers-1-3/`, not from memory.

**(b) DevOps-core — resolved by removal, not by writing the runner.**
`test:skills` was removed from the root `package.json` (T1), and the
header of `governance/skill-evals/registry.yml` now states plainly that no
runner exists and none of its prompts has ever been executed (T2). Option
(ii) "remove the dangling script" was chosen over option (i) "write
`run-evals.js`" because the registry is 4 skills × 1 prompt each, with
prose `expected_behavior` strings — the only honest runner for that is an
LLM-as-judge harness, which is Phase 6 scope and needs API budget; a
string-match stub would have been a fake test. `npm run test:skills` now
fails with npm's own `Missing script: "test:skills"` (exit 1) instead of
the `Cannot find module .../run-evals.js` crash. **DevOps-core still has
no root `test` script.** That is the honest current state; this item did
not change it.

**(a) Stratum — the symptom diagnosis was right, but the cause was
incomplete.** `stratum/node_modules` was installed on Windows. Evidence:
every entry in `node_modules/.bin` has `.cmd`/`.ps1` siblings; all 91
non-symlink files there are dated May 28 and were mode 644; the only 2
entries that are symlinks (`js-yaml`, `nanoid`) are the ones npm re-linked
on macOS on 2026-09-14. A Windows install explains BOTH halves of the
original finding at once — npm on Windows writes shim *scripts* rather
than symlinks, and NTFS carries no execute bit for them to arrive with, so
`.bin/vitest` came over as a plain 644 file; and a Windows install never
selects the `@rollup/rollup-darwin-arm64` optional package, so the darwin
native binary was simply absent. Sequence (times from file mtimes and the
capture files):

- 16:18 — baseline capture (`npm-test-baseline-2026-09-14.txt`,
  `npm-test-fallback-baseline-2026-09-14.txt`,
  `stratum-test-baseline-summary.md`): `npm test` exit 126 (`Permission
  denied`), fallback exit 1 (`Cannot find module
  @rollup/rollup-darwin-arm64`). The original finding reproduced exactly.
- 16:19 — 1.5's `npm audit fix` install ran (`node_modules/.bin/` and
  `node_modules/@rollup/rollup-darwin-arm64/` mtimes). That reinstall
  resolved the rollup half **incidentally, before this item was worked**.
  It re-linked only 2 shims and did not touch `.bin/vitest`'s mode.
- 16:50 — the 1.5 cycle's own T7 re-run (`stratum-test-postfix-diff.md`;
  also `ship-blockers-1-5/final-verification-summary.md` §3) recorded
  `npm test` **still exit 126, byte-identical** to the baseline, and only
  the `vitest.mjs` fallback passing (101 files / 825 pass + 5 todo). So the
  claim that "T7/T8 ran `npm test` successfully" was inaccurate — T7 ran
  the fallback, and T8 invoked `node_modules/typescript/lib/tsc.js`
  directly for the same reason (`.bin/tsc` is another 644 shim; see that
  summary's §5).
- 20:21 — this cycle's fix: `chmod +x node_modules/.bin/vitest`, and
  nothing else. After it, `npm test` (`vitest run`) produced, verbatim from
  `npm-test-postchmod-2026-09-14.txt`:

```
 Test Files  101 passed (101)
      Tests  825 passed | 5 todo (830)
```

with exit code 0. No reinstall, no lockfile change, no dependency change:
`git status` on `stratum/package.json` and `stratum/package-lock.json` is
clean (1.5's own lockfile change was already committed in `1fd0d46`), so
the 1.5 boundary was respected. The pipeline's tester stage re-ran
`npm test` independently two minutes later with the same result
(`npm-test-postchmod-tester-rerun-2026-09-14.txt`).

**Caveat — the fix is not durable.** `node_modules/` is gitignored
(`stratum/.gitignore:18`), so the `chmod` lives only in this machine's
checkout and will be lost by any future sync of `node_modules` from the
Windows checkout; the other 90 shim files (including `tsc`) are still mode
644. A lockfile-respecting `npm ci` on macOS would regenerate every `.bin`
entry as a symlink and fix this properly, but a reinstall was outside this
item's allowed fixes and was not run. Tracked as PB-51 in
`.workflow/state/polish-backlog.md` (T5).

**Update 2026-09-15 — PB-51 evidence for the human call.** The reinstall
was exercised for real, but in an isolated `git worktree` (a scratchpad
copy of this checkout; the working tree's `node_modules` was not touched):
`npm ci` in `stratum/` (npm 11.16.0, lockfile unchanged) completed in 12 s
and produced 31 symlinked, executable `.bin` entries (0 regular files,
0 non-executable), with `@rollup/rollup-darwin-arm64` present. There,
`npm run typecheck` exits 0 (no more exit 126) and `npm test` exits 0 with
`Test Files 101 passed (101)` / `Tests 823 passed | 2 skipped | 5 todo
(830)`. The two skipped tests are the "real dataset integrity" cases in
`test/evals/locomo.test.ts` and `test/evals/longmemeval.test.ts`, which skip
only because the gitignored datasets
(`stratum/evals/datasets/{locomo10,longmemeval_oracle}.json`) are absent
from a fresh worktree — in this checkout they are present and pass. npm
11's new `allow-scripts` gate reported the esbuild/workerd postinstalls as
pending approval, but their platform binaries were present and nothing
failed. So `npm ci` on macOS is the durable fix with no observed
regression; it stays a human call only because it replaces the whole
gitignored `node_modules`. The three proofs that fingerprinted the current
`node_modules` (claims 027/028/029) now branch on its state and were
verified against that worktree in both states, so running `npm ci` will
not break them.

**LAUNCH_READINESS.** The "246 pass + 5 todo" and "97 passing + 5 todo"
figures quoted in the original finding above are older in-document session
snapshots (both sit in that doc's line-3 "Last refined" history
paragraph), not its current claim. The doc's most recent headline figure —
"Suite **825 pass + 5 todo**" at `docs/LAUNCH_READINESS.md:169` —
**matches** the independently reproduced `npm test` run above (825 passed,
5 todo, 101 files). No `LAUNCH_READINESS.md` edit was made by this item
(the one-line "Last refined" date bump in the working tree predates this
cycle).

**(c) still open**: adding both suites to CI was not in this item's scope
and has not been done, so nothing yet prevents the Stratum suite from
silently regressing again.

### 1.4 Stratum's pruner — the single most defensible piece of differentiated IP in the whole project — fails its own real benchmark

Per ADR-0014, running the actual published, judged LoCoMo benchmark: at
λ=0.97 (the documented **shipping default**), evidence survival was **1.4%**
— the pruner discards 98.6% of the evidence needed to answer questions,
while the LLM plausibly "bluffs" an answer from recent context, nearly
fooling the original eval gate. ADR-0016 found the gate itself was measuring
the wrong thing and fixed it (degradation-dominant + evidence-survival
co-gate) — but **even after that fix, the calibrated config still fails
11/18 scenarios**. Next validation round is blocked on API credits
(`docs/MEMORY_AND_EVAL_COMMANDS.md:133` marks `eval:locomo` "NEEDS CREDITS").

This directly bears on the earlier conversation in this session where the
pruner was identified as the most legitimate unsolved-problem the project
addresses — that's still true of the *design*, but the *current calibrated
implementation does not yet meet its own bar*. Do not ship pruning live
(it's correctly still shadow-mode) until this is fixed and re-verified.

**Action**: fund and run the next judged validation round; do not represent
pruning as "validated" anywhere until it passes its own gate on the real
benchmark, not just the dev set.

### 1.5 Unpatched dependency vulnerabilities in Stratum — partially resolved 2026-09-14

**Update 2026-09-14**: the original "11 vulnerabilities, 1 critical, all in
`tar`" figure was stale by the time this was actually worked (dependency
drift since the initial audit) — the real count at fix time was **26
vulnerabilities (3 critical, 17 high, 6 moderate)** across many packages,
not just `tar`. Ran `npm audit fix` (no `--force`) via the graph-engineering
pipeline (sprint cycle `phase0-003-npm-audit`), independently re-verified by
the pipeline's own security and validator stages plus a human (me) re-running
`npm audit` directly: **resolved 26 → 14 (16 packages fixed), `package.json`
untouched, no silent `--force`.**

**3 critical vulnerabilities remain, deliberately not auto-fixed**: `tar`,
`vitest`, `@vitest/coverage-v8` — all require `npm audit fix --force`, which
would force a semver-major bump (`vitest` 5.0.0, `supabase` 2.117.0). The
pipeline correctly declined to apply this unattended and flagged it for
human review rather than silently accepting a breaking major-version
upgrade. 8 packages total need `--force` (also: `@vitest/mocker`, `esbuild`,
`vite`, `vite-node`, `supabase`); 2 (`@huggingface/transformers`, `sharp`)
have no fix available upstream at all yet.

**Action**: fix committed (partial). Remaining decision — whether to accept
the `vitest`/`supabase` major-version bumps via `--force` — needs an
explicit human call, not an autonomous one; the version bumps could carry
real breaking changes worth testing deliberately rather than forcing blind.

### 1.6 A stale signature was introduced *this session*

`goal-loop`'s `SKILL.md` was edited (removing the dead `researcher` subagent
reference) but `governance/skill-manifest.yml`'s `sha256`/signature for it
were never regenerated — spot-checking 5 manifest entries by computing
sha256 directly confirmed `proof-of-work`, `baton-handoff`,
`session-summary`, `spec-extraction` all match; `goal-loop` does not. Same
failure pattern as the already-documented PB-13, now recurring on a
different skill, introduced by this very session's work.

**Action**: dispatch `release-sign.yml` to re-sign the current skill set
(this will also need to happen after removing the 3 skills earlier this
session, since the manifest was hand-edited, not re-signed).

### 1.7 No lockfile at the DevOps-core repo root

No `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` and no
`node_modules` exist at all. Dependency versions aren't pinned, builds
aren't reproducible. (Stratum has its own lockfile situation covered
separately in 1.3/1.5.)

**Action**: run `npm install` and commit the resulting lockfile.

### 1.8 The deploy-gate/sealed-ref hooks were bypassable — found and fixed 2026-09-14

The graph-engineering pipeline's own security stage (cycle
`phase0-004-claim-validator-investigation`) found, and a human independently
reproduced before trusting it, a real bypass in the exact safety mechanism
this session's graph work was relying on all along:

- Both `hooks/universal/pre-tool/deploy-gate.sh` and
  `hooks/universal/pre-tool/block-sealed-refs.sh` anchored their detection
  regex to the *start* of the command (`^[[:space:]]*verb`). Anything where
  the verb wasn't the literal first token — `cd stratum && vercel deploy
  --prod`, `npx vercel deploy --prod`, `VERCEL_TOKEN=x vercel deploy
  --prod`, `cd . && git tag -d v0.2.0` — bypassed the gate entirely,
  exiting 0 before any gate logic ran. This applied to production-deploy
  detection, the billing-path four-eyes check (same gate), and sealed-ref
  protection.
- Separately, `.claude/settings.json`'s wrapper for both hooks used a
  single `read -r cmd`, which only captures one line of piped input — a
  multi-line command (e.g. a heredoc, or any script whose first line is
  benign) had every line after the first silently discarded before the
  hook ever saw it, defeating both gates generically regardless of the
  regex fix.
- Also fixed: the wrapper now fails *closed* (exit 2) if a hook script is
  missing or not executable, rather than silently exiting 127 (which
  Claude Code does not treat as a block) — a gate whose absence was
  previously indistinguishable from a pass.

**Fixed**: unanchored the regexes (word-boundary matching instead of
start-anchored), changed both wrapper commands to `cmd=$(cat)` (reads all
lines, not just the first), and added the fail-closed executable check.
Re-verified against all 4 originally-bypassing deploy commands, the
multi-line bypass, and the sealed-ref bypass — all now correctly blocked
(exit 2) — plus regression-tested the legitimate paths (safe commands,
valid approval markers, billing four-eyes with distinct approvers) to
confirm nothing over-blocks. See
`governance/graph/stability-dashboard.md` cycle
`phase0-004-claim-validator-investigation` for the full writeup.

**Why this matters beyond the immediate fix**: this was found through
exactly the process this project's constitution calls for — an independent
security review catching a real gap in a control everyone (including the
human) had been trusting — and it's worth remembering that "6 tests passed
earlier this session" (the original deploy-gate.sh build) tested only the
literal command shapes, not realistic variations. Test gates against
realistic invocation patterns (`cd x &&`, `npx`, env-var prefixes,
multi-line), not just the cleanest-case command string.

**Addendum 2026-09-15 — a second wrapper defect, the inverse failure
mode.** The `.claude/settings.json` wrappers resolved
`hooks/universal/pre-tool/*.sh` relative to the *current working
directory*. Claude Code's Bash working directory persists between calls, so
after one command ended in `cd stratum && …`, every subsequent Bash command
was refused with "HOOK MISSING/NOT EXECUTABLE … failing closed" — the
fail-closed check from the fix above working exactly as designed, on a false
premise (the hook existed; the cwd had moved). Failing closed was the right
default (the alternative, silently running unguarded from a subdirectory,
is the original bypass class), but a gate that locks the operator out of
`git status` from a subdirectory is not usable. **Fixed**: all three
wrappers (both PreToolUse and the PostToolUse one) now resolve the project
root from `CLAUDE_PROJECT_DIR`, falling back to `git rev-parse
--show-toplevel`, `cd` there before invoking the hook (so the hooks' own
root-relative paths — `.workflow/state/graph-halt`, `events.jsonl`,
`git diff --cached` — resolve correctly too), and still fail closed if the
root cannot be resolved or the script is missing. Verified: commands run
again from any subdirectory, and `git push --dry-run --tags` is still
blocked with no approval marker — on this checkout only, as it turned out;
see the next paragraph for why that verification was incomplete.

**What the third adversarial pass found in that addendum (2026-09-15).**
(1) The three hook scripts' executable bit had **never been committed**
(tracked mode `100644`; this checkout has `core.fileMode=false`, so the
local `chmod +x` was invisible to `git status`) — on any fresh checkout the
wrapper's own fail-closed check would have refused *every* Bash command,
so "verified: commands run again" was true only on this machine. Fixed
twice over: the mode bits are now committed (`git update-index
--chmod=+x hooks/universal/**/*.sh`), and the wrappers invoke the hooks
via `bash "$H"` after a `-f` existence check, so executability is no
longer a precondition. (2) With `CLAUDE_PROJECT_DIR` unset, the
`git rev-parse` fallback resolves whatever repo the cwd is in — a scratch
worktree with a forged approval marker flipped the gate to ALLOW when the
wrapper was invoked by hand. Claude Code always sets
`CLAUDE_PROJECT_DIR` for hook subprocesses (pinned to the session's
project root, independent of cwd) and, as observed, resets the Bash cwd
to the project root after every command, so the fallback is unreachable
from a CLI session; it is kept for out-of-band invocation but now prints a
`HOOK WARNING` line whenever it is used, so its use is observable. The
gate's safety in any other harness is contingent on that variable.
(3) `cd ""` is a silent no-op in sh, so the "cannot resolve the project
root" branch never fired; the wrapper now tests for an empty root
explicitly. (4) The PostToolUse wrapper could skip the LR-date sync with
no trace; it now says so on stderr. (5) Both hooks `unset GIT_DIR
GIT_WORK_TREE`, which would otherwise redirect their `git diff` calls to
another repository regardless of cwd. (6) Found while preparing the push,
by reading the gate rather than by a review lens: the original fix
unanchored the quick-exit filter and the deploy patterns but left the
**billing four-eyes trigger** start-anchored, so `cd x && git commit` of a
billing-path change skipped the two-approver check — the same bypass
class as the original finding, one regex further down. Unanchored to the
same word-boundary form and verified in a fresh worktree with a staged
`stratum/src/billing/` file: `cd . && git commit …` is now blocked with
"needs TWO approval markers".

---

## 2. Architecture-reality divergence

### 2.1 Stratum's production runtime doesn't match its own governing architecture decision

ADR-0005 chose **Cloudflare Workers + Durable Objects** as *the* production
runtime specifically for sub-50ms edge latency and stateful sessions —
Fastify was explicitly scoped as only the "Phase 1 local dev" fallback. But
the actual live deployment (confirmed earlier this session: real Vercel URL,
health-checked, real Supabase) **is Vercel**, and the Workers path's core
primitive — `SessionDurableObject` in `stratum/src/proxy/worker.ts:70` —
**literally returns `{"error":{"type":"not_implemented"}}`**. The
foundational infrastructure decision that the pruner and billing systems
were architected around was never realized in what's actually running.

**Action**: either finish the Workers/Durable Objects path for real, or
formally supersede ADR-0005 with a new ADR documenting Vercel as the actual
production choice and re-evaluating whether the latency/statefulness
properties it was chosen for still matter given what's actually deployed.
Leaving the architecture record contradicting the real deployment is itself
a "masterpiece" defect — it means nobody can trust the ADRs as ground truth.

### 2.2 `plan.md`'s Phase 3 tracking is wrong in both directions

The entire v0.5.x checklist in `plan.md:174-224` is unchecked `[ ]`,
including Tier-2 memory — which is actually **built and live**
(`stratum/src/memory/warm/tier2.ts`, confirmed earlier this session).
Correcting that undercount also surfaces genuinely missing scope that was
being obscured by the blanket "unbuilt" framing:
- `stratum/src/memory/cold/{pinecone,neo4j}.ts` are confirmed pure stubs (9
  and 12 lines, `// TODO: Implement`) — Tier-3 cold memory doesn't exist.
- DevOps-core's `hooks/universal/session-start/load-baton.sh` has **zero
  references** to Stratum facts/tier2 — the actual cross-repo integration
  that Phase 3 Option B was supposed to deliver (DevOps core querying
  Stratum's memory at session start) hasn't been started.
- The v0.5.x §4f knowledge-graph-view feature (~30h estimated) is entirely
  unbuilt.

**Action**: update `plan.md` to reflect what's actually built vs. actually
missing, so future planning isn't working from a false baseline.

---

## 3. Unproven in the real world

### 3.1 Stratum's commercial flow has never run end-to-end

`docs/COMMERCIAL_ONBOARDING.md`'s full 6-step pilot flow (deploy → org/key
provisioning → partner integrates → usage visible → invoice generated →
payment collected) is fully built in code but has never been exercised with
a real paying partner. Two literal blockers remain: a container-host account
(step 1) and a live Stripe key (step 5). Zero real-world proof the billing
math, invoice generation, and payment collection actually work together
under real conditions.

### 3.2 No re-verification of the Phase 2 sealed security posture since the CI regression

The Phase 2 closure (`governance/changelog/PHASE-2-CLOSURE.md`) sealed A.11
sec-review PASS for ASI02/ASI04 — but that sign-off predates the DeepTeam CI
gate breaking (see 1.2). Nothing has re-confirmed the sealed posture still
holds since the automated check meant to continuously verify it went dark.

**Action**: once 1.2 is fixed and CI is green again, do a manual
re-confirmation that nothing has drifted in the interim, since the automated
safety net was off for over a week.

---

## 4. Known, honestly-scoped future work

These are real gaps between "now" and "masterpiece," but they're correctly
labeled as not-yet-built rather than silently broken — lower urgency than
Sections 1–3.

- **Phases 4–6 of the 6-phase build** (design-phase skills, SRE/operate,
  self-improvement loop) — entirely unbuilt. This is roughly half the
  originally-scoped product.
- **Multi-tool adapters** (Codex, Cursor, Gemini CLI, Copilot, Windsurf) —
  zero references anywhere in `plan.md`, `blueprint.md`, or
  `governance/changelog/ROADMAP.md`. Confirmed **permanently aspirational**,
  not merely unscheduled. README's opening pitch still names all 8 tools
  (now with an honesty caveat added this session) — worth deciding whether
  to actually build the adapters or narrow the pitch to "Claude Code, with a
  path to more."
- **`librarian` subagent** — confirmed still a pure placeholder per its own
  file (`Status: CONTRACT placeholder... NOT active until Phase 3 ships`).
  Its dependency `facts.ts` is partially real; `pinecone.ts`/`neo4j.ts` are
  stubs (see 2.2).
- **`integrations-curator` subagent** — fully built but has zero test/eval
  coverage and no evidence it has ever actually been invoked (`.workflow/state/`
  shows no artifacts it would produce). Built-but-never-exercised is its own
  category of risk before calling it shippable.
- **Stratum Tier-3 cold memory** (Neo4j graph store, Pinecone semantic
  store) — stub-only, see 2.2.
- **Stratum Phase 4 TEE encryption path** (`src/proxy/tee/*`,
  `src/pruner/crypto.ts`) — deliberately unbuilt; the code throws rather
  than faking encryption, which is the *correct* honest behavior per its own
  ADR-0009 reasoning. Not a defect, just a real remaining gap.
- **Polish backlog** (DevOps-core items only — Stratum's own PB items are
  tracked separately): PB-13 (stale cosign signatures on
  `prompt-injection-defense`, blocked on GitHub Actions billing — worth
  re-checking whether this is still the real blocker given the CI findings
  above), PB-16 (git tags use `-a` not `-s`, unsigned — LOW severity), PB-21
  (coupled to PB-13, auto-closes with it).

---

## 5. Already fixed this session (for the record, not action items)

- Stale Zep reference left in `CLAUDE.md` after this session's own Zep
  removal — fixed.
- Leftover `"karpathy"` keyword in `package.json` after this session's own
  karpathy-guidelines removal — fixed.
- `.claude/settings.json` hooks wired and proven live (sealed-ref block,
  LAUNCH_READINESS date-sync).
- Phase-status docs reconciled (README/CHANGELOG were stuck describing
  Phase 1 as in-progress despite Phase 2 being shipped).
- 3 redundant process skills, the `researcher` subagent, and the Zep memory
  backend removed as genuinely redundant with existing tools/native
  platform features; all references updated or explicitly noted rather than
  silently deleted.

---

## Recommended order of attack

Given the "no shortcuts" bar, sequence matters — fix the instruments before
trusting what they report:

1. **Fix both CI gates** (1.2) — quick, mechanical, and until they're green
   nothing else can be trusted as continuously verified going forward.
2. **Fix both test suites** (1.3) — nothing can be honestly called "done"
   without a working test harness under it.
3. **Resolve the claim-validator SHA-loss problem** (1.1) — either recover
   history or change the policy; 97% silent failure is not an acceptable
   steady state for the project's flagship mechanism.
4. **`npm audit fix`** for the critical Stratum vulnerability (1.5).
5. **Re-sign skills** via `release-sign.yml` (1.6), covering both the
   `goal-loop` drift and this session's skill removals.
6. **Resolve the ADR-0005 vs. reality divergence** (2.1) — pick a real
   architecture and make the record match it.
7. **Fund and run the next pruner validation round** (1.4) — do not
   represent pruning as validated anywhere until it passes its own gate.
8. Correct `plan.md`'s Phase 3 tracking (2.2) so future planning isn't
   working from a false baseline.
9. Everything in Section 4 is legitimate roadmap work — sequence after the
   above, since building more on top of broken instrumentation just
   compounds the problem.
