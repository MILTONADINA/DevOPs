# Handoff: C2 local verification and next steps (2026-10-03)

Read [`AGENTS.md`](../../AGENTS.md) and the local `.workflow/state/baton.md` first. This page records the 2026-10-03 local verification snapshot before merge and the remaining roadmap. Git and the PR checks determine the current merge state; the verification below does not declare the whole project finished.

## Branches and provenance

The repository uses only `main`, `dev`, and `feature`. Changes reach protected `main` through a squash-merged PR with `validate`, `runtime-test`, `setup-linux`, `gitleaks`, `semgrep`, and `dependency-audit` green. Keep `dev` synchronized after landing.

- C1 base: `3ac20df17ebfc8e7f1614c23a1bbeecbaff7084e` (S1, PR #219; includes #220's undici fix).
- Claude's stopped checkpoint: `7565ca4`, followed by handoff `1e5f2a8`, both preserved on `feature`.
- Codex resumed that checkpoint on 2026-10-03, finished T4–T7, and added a regression test for auth-enabled requests without an organization. This was a cross-tool continuation with independent review and validation agents, not a replay of Claude Workflow `wf_51c12945-ff7`. The old Workflow record remains historical/indeterminate.
- Do not apply the old baton's `git reset --soft HEAD~1`: it no longer identifies the WIP code boundary.

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

Finish C2's independent review, source-bound claims and required checks on its
final PR head, then merge under standing owner authorization and synchronize
main/dev/feature. Consult Git/PR state and the local baton before repeating any
work. Once C2 is merged, continue **C3**, using `.workflow/state/c3-plan.md` if
present and the approved payment-removal spec. Do not resume old Claude Workflow
`wf_51c12945-ff7` or reset the preserved C1 checkpoint.

Then:

1. **C3:** delete payment modules/types, `runtime/scripts/invoice.ts`, `runtime/src/proxy/routes/billing.ts`, related scripts and payment-only tests. PB-122 records the CLI-only factory/test deletion.
2. **C4:** migration M2, invoice-table removal, session-erasure simplification, old-backup restore handling and ADR-0021 retirement.
3. Claim retirement, MR-3, remaining spec approvals and security/hygiene cycles in the local roadmap.
4. Naming aliases (`DEVOPS_*`) and remaining capitalized Stratum prose; v0.4 pruner cycles 1b and 2. No pruning quality gate is declared passed by C1.

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
