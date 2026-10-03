# Handoff: C4-A local verification and remaining erasure work (2026-10-03)

Read [`AGENTS.md`](../../AGENTS.md) and the local `.workflow/state/baton.md` first. This page records the C4-A local verification snapshot before merge and the dated snapshots below. Git and the PR checks determine the current merge state; the verification below does not declare the whole project finished.

## Branches and provenance

The repository uses only `main`, `dev`, and `feature`. Changes reach protected `main` through a squash-merged PR with `validate`, `runtime-test`, `setup-linux`, `gitleaks`, `semgrep`, and `dependency-audit` green. Keep `dev` synchronized after landing.

- C1 base: `3ac20df17ebfc8e7f1614c23a1bbeecbaff7084e` (S1, PR #219; includes #220's undici fix).
- Claude's stopped checkpoint: `7565ca4`, followed by handoff `1e5f2a8`, both preserved on `feature`.
- Codex resumed that checkpoint on 2026-10-03, finished T4–T7, and added a regression test for auth-enabled requests without an organization. This was a cross-tool continuation with independent review and validation agents, not a replay of Claude Workflow `wf_51c12945-ff7`. The old Workflow record remains historical/indeterminate.
- Do not apply the old baton's `git reset --soft HEAD~1`: it no longer identifies the WIP code boundary.

## Current C4-A delivery and remaining C4-B

C3 merged in [PR #223](https://github.com/MILTONADINA/DevOPs/pull/223) at
`28ea1aac8117722613e8a483894421fc4c5e481e` on 2026-10-03. All six required checks,
Node24/26 and the title check passed on tested head `2c53798`. The merge tree
matches that tested tree; main/dev/feature were synchronized before C4-A. The
C3/C2/C1 sections below preserve their historical pre-merge snapshots.

C4-A coordinates M2 `20261003010000_retire_invoice_schema.sql` with the recovery
code. It drops the two invoice RPCs before the two invoice tables, then replaces
the latest inventory function with only those organization-only classes removed.
Every historical migration remains unchanged. New backups omit the retired
tables. Legacy restore validates their arrays and organization identities, skips
and reports them (including present empty arrays), and continues to strip/report
retired usage columns without logging their values. Active keys, facts, graph
provenance, source-link identities and generated token/USD fields retain their
existing recovery rules.

The preflight loses only its financial reason. Numeric usage counts, authenticated
organization scope and all nonfinancial blocks remain. The erasure specification
moves to `specs/memory/session-erasure.md`; ADR-0021 is superseded with its original
body preserved as history. Final source review, required CI on the exact PR head
and merge remain gates. Evidence is in `.workflow/proofs/c4a-2026-10-03/`.

| C4-A local gate | Result |
|---|---|
| Focused red/green | Recovery: 13 expected old-contract failures, then 43 pass; preflight: 2 expected financial-reason failures, then 25 pass with independent store guards |
| Typecheck and source lint | Pass |
| Independent runtime suite, clean locked installation | 1,403 passed; 5 skipped; 5 todo; run once |
| Root, isolated Linux/Node24 | 473 passed; 17 skipped |
| Database migration and SQL | M2 applied once; all 14 SQL fixtures pass; 63 migration records, 21 public tables, retired tables/RPCs absent; original container/volume preserved |
| Recovery | Synthetic legacy dry/real skip+strip and current backup recovery pass; retained usage, keys, shared graph, source links, decisions and audit assertions stay |
| Real system | Setup applies zero additional migrations; actual no-secret npm-dev usage/replay and project-scoped session/preflight/cap checks pass |

The measured runtime floor rises from 1,388 to 1,403 (+10 recovery cases and
+5 preflight cases); root stays 473 and no lowering entry is needed. The runbook
was corrected before the full runtime run to describe retained synthetic files
on failure. Two optional checks recorded unchanged baseline diagnostics: the
backup pagination's `while (true)` under broader script lint, and a test's
`decisions[0]` under expanded strict test compilation. Required source lint and
typecheck pass; neither unrelated line was changed or hidden. These checks do
not establish model quality, cross-platform clean installs or real-user recovery.

**C4 is incomplete.** C4-B must implement actual API erasure with trusted store
coverage, a write fence, atomic private-data deletion, preserved shared data and
retryable failures. Current DELETE merely ends the session; current preflight
cannot authorize erasure. Unknown external copies, backups, RAM and graph
ownership remain blockers. The one-year/<30-second benchmark is an additional
v0.9 gate; a small real erasure fixture will not satisfy it. Payment-removal AC-8
and whole-project completion are not claimed by this schema delivery.

## C3 implementation and verification — snapshot before merge

C2 merged in [PR #222](https://github.com/MILTONADINA/DevOPs/pull/222) at
`4ac4784856e68efc150b67c55ae449839e30c479`, with all six required checks and
Node24/26 checks passing. The corrected PR title check passed; the earlier
failure affected only the title. Main/dev/feature were synchronized before C3.
The C2/C1 sections below preserve their historical pre-merge snapshots.

C3 implements payment-removal REQ-7. Its one atomic change deletes ten legacy
billing modules, three CLIs, the CLI-only read factory and twelve old test files.
It removes only payment types, keeps PruningLog exactly, and removes only the
invoice/verify-billing/verify-stripe npm scripts. No dependency changes are needed.
The optional source-summary sample now reads usage pricing instead of the deleted
calculator, preserving all eleven sample/sentence checks; no real model was run.

Independent disposition covered every removed assertion. Two nonpayment gaps
were preserved in usage summary tests before retirement: negative token/USD
changes and raw-cost aggregation before final rounding. Fee/signature/payment
assertions are retired; usage, plan limits, tenancy, provenance, durability and
generic outbound webhook protection remain.

| C3 local gate | Result |
|---|---|
| Importer check | No imports through billing directories; expected grep exit 1 |
| Typecheck and source lint | Pass |
| Focused retained usage/startup/session APIs | Pass; final summary guards 7 passed |
| Independent runtime suite, clean locked installation | 1,388 passed; 5 skipped; 5 todo |
| Root, isolated Linux/Node24 | 473 passed; 17 skipped |
| SQL, setup, actual no-secret npm dev message/replay | All 14 SQL fixtures pass; setup applies zero migrations; actual entry-point proof passes |
| Scope | 26 exact deletions; all 75 provider/migration/frozen hashes unchanged; PruningLog unchanged |

The new lowering records runtime **1,521→1,388**, citing ADR-0025 and REQ-7/12:
135 old cases retired and two preservation cases added. It uses the executed
count, not a planned subtraction. Root stays473. Source/command/exit evidence,
independent disposition and review live in `.workflow/proofs/c3-2026-10-03/`.
The initial container dependency install refused missing project-local mount
directories before testing; those prerequisites were corrected, then the install
and root suite passed. No acceptance test was relaxed for that failure.

At this snapshot final required GitHub checks and squash merge still gate C3.
Invoice tables/functions, backup export/restore and financial erasure blocker stay
until C4. The full payment-removal spec stays approved and incomplete. No payment
module remains as an optional product feature. No provider, historical migration,
frozen fixture, hosted service or paid model changed.

## C2 implementation and verification — snapshot before merge

C1 and its compatible dependency remediation merged in [PR #221](https://github.com/MILTONADINA/DevOPs/pull/221)
at `18ba62ba854a77eddc10d1b3175e7be35c779603`. C2 starts from that exact baseline.
All six required C1 checks passed; main/dev/feature were synchronized before C2.
The C1 tables below are historical evidence for that cycle.

C2 implements payment-removal REQ-4/5/6 and REQ-9's column boundary:

- New `runtime/src/usage/` writer, recorder, outbox and pricing modules. Legacy
  billing modules remain untouched until C3. The outbox bytes and price table
  retain their prior behavior.
- M1 `20261003000000_unsigned_usage_ledger.sql` removes only the three mutation
  triggers, their function, fee and signature columns in the required order.
  It preserves RLS, constraints, event uniqueness and generated token/USD values.
- Team messages always wire the private durable journal without a signing
  secret. Database, network, persistent-storage and Vercel guards remain.
  Invalid memory/audit settings fail before journal allocation.
- Replay compares org/session/tokens/event/pruning provenance and pinned price
  at PostgreSQL NUMERIC precision; malformed/missing confirmation is failure.
- Old backups strip/report retired columns without their values. Invoice tables
  still export/restore until C4. Invoice and signature-verification CLIs remain
  as legacy source until C3 and are incompatible with M1; do not run them.
- Four local message harnesses isolate journals, distinguish conversation/usage
  sessions and clean only fixture usage before sessions. Real-model behavior
  was not evaluated in this cycle.

| C2 local gate | Result |
|---|---|
| Focused writer/outbox/pricing, restore and startup tests | Pass; red/green logs retained |
| Typecheck, source lint, expanded Vercel typecheck | Pass |
| Runtime, clean locked installation without optional datasets | 1,521 passed; 5 skipped; 5 todo |
| Root, isolated Linux/Node 24 with clean home | 473 passed; 17 skipped |
| All SQL integration files | 14 passed with rollback |
| M1 on existing local Compose | Exactly one migration; same database container/storage |
| Root setup | Healthy proxy/database; zero additional migrations |
| Synthetic legacy restore | Retired fields removed, identities/estimates/invoice data retained |
| Conversation memory, Git audit, 50-turn survival | Pass; 51 conversation sessions and usage events retained in survival proof |
| Actual `npm run dev` twice, no signing secret | Health/auth/removed-route guards; 23-input-token message; same-ID replay and six mismatch refusals; scoped UPDATE and USD stats; old pending/already-committed journal replay |
| Numeric round-trip integration | 0.000001005→0.00000101 replay; original project/day/price retained on restart |

The runtime floor rises 1,433→1,521 without deleting tests; root stays 473.
Local evidence is under `.workflow/proofs/c2-2026-10-03/`, with command/exit
records, source manifests, disposition and independent review. The isolated
root suite exposes only project-local files and a clean container home.
No hosted Supabase, paid model, deployment, operator journal or real dotenv
was used. M1 is already applied locally; do not reapply/reset the database.

At this snapshot C2 still needs its final-head required GitHub checks and
squash merge. Writer, migration, startup and restore compatibility must land
atomically. The approved payment-removal spec is not fully implemented until
C3/C4 and all applicable gates finish. These checks establish no model quality,
clean-machine multi-platform release or complete project readiness.

## C1 implementation and verification

Spec: [`specs/ops/payment-removal.md`](../../specs/ops/payment-removal.md), REQ-1, REQ-2, REQ-3, REQ-6 and the applicable every-cycle REQ-10–15. The spec stays **approved** because C2–C4 remain open.

- Removed the CFO page, payment HTTP reads, inbound Stripe route, payment OpenAPI schema and two retired webhook event types.
- Retained `/v1/billing/summary` and `/v1/billing/records` as usage reads, with token totals and estimated USD values. Project-bound keys still receive 403. Session stats have no `feeUsd`.
- Plan lookup now uses the sessions dependencies; request limits, token budgets and session caps retain their behavior.
- The invoice CLI's two-method billing factory remains until C3. Signed usage writes, the signing secret, billing modules and invoice tables remain for C2–C4.
- Updated the API/operator docs, both affected billing specs and the spec-status baseline. The added missing-org regression guard fails when the auth fallback guard is deliberately removed from an isolated copy.

Local C1 verification results before the supplemental dependency remediation
(implementation gates independently reproduced; baseline measured once).
These results remain bound to the dependency tree used for those runs:

| Gate | Result |
|---|---|
| Runtime suite, clean locked install without optional real datasets | 1,433 passed; 5 skipped; 5 todo |
| Base runtime suite at `3ac20df` | 1,415 passed; 5 skipped; 5 todo |
| Root suite, isolated Linux / Node 24 | 473 passed; 17 skipped; 0 failures |
| Typecheck, source lint and expanded Vercel-adapter typecheck | Pass |
| SQL integration | All 14 files passed and rolled back |
| Root setup smoke | Pass; 0 migrations applied; database volume preserved |
| Real team-mode `npm run dev` | Health 200 with database healthy; Stripe/CFO 404; usage read 401 without key |
| Floors, spec status/baseline, repository hygiene, added-test assertions | Pass |

The runtime floor rises from 1,415 to 1,433; no lowering entry is needed. Root remains 473. The adapter's pre-existing TS2322 is fixed as authorized in the original planner answers. The initial root test environment failed because its temporary fixtures require independent Git roots and POSIX executable permissions; the passing environment uses a cached Node Linux image, isolated tracked-file clone, project-backed temporary/home directories and tmpfs for permission-sensitive state. No acceptance assertion was relaxed.

Detailed commands, exits, source manifests, test disposition and independent reports are local under `.workflow/proofs/c1-resume-2026-10-03/`. Named-file Gitleaks scans are clean. The limited local Semgrep scan has one unchanged INFO finding in a webhook unit test, reviewed as non-blocking; the full required CI Semgrep packs still gate the PR. Local proof is not a substitute for those required GitHub checks.

## Supplemental dependency remediation — local verification snapshot before merge

[PR #221](https://github.com/MILTONADINA/DevOPs/pull/221) carries the C1 change
and dependency remediation; consult it for current checks and merge state. Its
initial required dependency audit found 10 high-severity and 2 moderate package
findings in the runtime dependency tree. The remediation follows
[`specs/security/stratum-dependency-alerts.md`](../../specs/security/stratum-dependency-alerts.md).

An initial parser/plugin upgrade candidate cleared the audit and passed the
existing lint configuration, but independent review found a transitive
dependency requiring Node 22.13 while the project supports Node 22.12.
That candidate was rejected. The replacement selects both
`@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` at 8.55.0,
using `~8.55.0` manifest ranges: this supports the existing ESLint 8.57 and
TypeScript 5.9 versions without pulling the newer transitive Node requirement
introduced on the 8.56+ line. It removes the vulnerable `braces` dependency
chain. The lockfile also resolves `brace-expansion` 2.1.7 and nested 1.1.21,
Fastify 5.12.5, and `fast-uri` 3.1.8 / nested 4.2.1.

The selected dependency set is now locally verified:

| Gate on the replacement dependency tree | Result |
|---|---|
| Dependency audit | Zero vulnerabilities |
| Existing source lint configuration | Pass; rules unchanged |
| Independent typecheck and expanded Vercel-adapter typecheck | Pass |
| Independent full runtime suite | 1,433 passed; 5 skipped; 5 todo |
| Proof binding | Validated manifest and lockfile hashes match the selected files |
| Real team-mode boot after a fresh locked install | Health 200 with database healthy; Stripe/CFO 404; usage read 401 without key; no model requests |

Evidence is recorded under `.workflow/proofs/c1-resume-2026-10-03/`, including
`dependency-compatible-audit.json`, `dependency-compatible-lint.json`, the
independent validation reports, and `dependency-team-boot.json`. The earlier
473 root tests and 14 SQL integration results remain evidence for their
unchanged source binding; they were not rerun for the runtime dependency
change. The earlier table is retained with its original dependency binding.
No Node support promise or lint rule was changed. At this local verification
snapshot, required GitHub checks on the new PR head and merge were not yet
verified; the PR records their current state.

## Next action

Finish C4-A's final source review, claims and required checks on
its PR head; merge under standing owner authorization and synchronize
main/dev/feature. Consult Git/PR state and the local baton before repeating work.
The source-grounded plan is `.workflow/state/c4-plan.md`; C4-B design prerequisites
are recorded separately in `.workflow/state/c4-erasure-design.md`.

Then deliver C4-B's actual safe API erasure under the moved memory spec.
**AC-8 requires a session actually erased through the API.** Do not weaken it,
substitute end-session, or treat a mocked ready response as proof. Preserve all
unknown-store and shared-data safeguards. The one-year/<30-second benchmark is
also a remaining v0.9 gate, separate from the small real erasure fixture.

After C4: historical claim retirement, MR-3, remaining approved roadmap and
security/hygiene work; naming aliases/current prose; v0.4 pruner cycles1b/2 and
quality gates; clean-machine macOS/Linux/WSL2 and real-use release gates. The
mission is still the whole remaining roadmap, not only payment removal. Do not
resume old Claude Workflow `wf_51c12945-ff7` or reset its preserved C1 checkpoint.

The detailed original [C1 backlog](c1-payment-surface-backlog.md) remains historical planning context. Its five planner answers were: fix the adapter type error; move the developer breakdown test; use “USD figures are estimates, for information only”; allow test-only webhook-secret fixtures and preserve C2's two billing imports; invert retired fee/signature assertions while retaining non-fee assertions. The recorded implementation and proof reflect those answers.

## Owner decisions on record

- **Open source, no payment, no deployment.** MIT and public. DevOps runs on the user's own machine (ADR-0025). Token and USD estimates stay, labelled as estimates.
- **One platform named DevOps** (ADR-0026). The runtime lives in `runtime/`. The old `MILTONADINA/Stratum` repository was deleted. New settings use the `DEVOPS_` prefix.
- **Gates.** The production-deploy gate (one human approval) and the graph-halt kill switch stay. The billing four-eyes gate is retired.
- **Specs.** Spec-driven work: every feature has a spec, ACs and tests. Specs are approved in batches. A spec's Status is one of `draft`, `approved`, `implemented` or `superseded`.
- **Dependencies.** Updates are reported through one GitHub issue, never bot branches or PRs. Security fixes go through normal PRs.
- **Node.** Node 22.12 or later. The required CI jobs use Node 22; a non-required job also runs 24 and 26.
- **Quality bar.** Best practice, a clean repository, usably secure. Review every change independently before it merges.

## Safety rules that bit before

- Never read, print or scan any `.env` file: `runtime/.env` holds real keys. Every gitleaks run passes `--redact` and scans named files or the diff, never a directory.
- Stage explicit paths, not `git add -A`, after running tests: tests leave generated files.
- History stays as written: ADRs, released CHANGELOG sections and dated records keep the paths and names they were written with.
