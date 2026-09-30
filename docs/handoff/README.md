# Handoff: current state (2026-09-30)

This page is for the next coding agent (Codex or another tool) that picks up this repository. The operating rules are in [`AGENTS.md`](../../AGENTS.md); read it first. This page gives the state of the work, the open branches, the next steps and the owner decisions recorded so far. It holds no secrets.

## Branches and PRs

| Ref | Commit | State |
|---|---|---|
| `main` | `3ac20df` | Protected. Required checks: `validate`, `runtime-test`, `setup-linux`, `gitleaks`, `semgrep`, `dependency-audit` (strict, with admins enforced). |
| `dev` | `3ac20df` | Same as `main`. |
| `feature` | this handoff, on top of the WIP commit `7565ca4` | **Not for merge as-is**: it carries unfinished cycle C1. |

No PRs are open. The repository uses three branches only (`main`, `dev`, `feature`). Changes reach `main` by squash-merged PRs with every required check green.

## Merged recently (newest first)

| PR | What |
|---|---|
| #220 | `undici` 7.29.1 through `wrangler` 4.144.0 (a high advisory), lockfile only. |
| #219 | Security cycle S1: the local proxy is locked to loopback by default (`specs/security/stratum-local-network.md`). It adds CORS rules, a Host allow-list, a 400 for duplicate Host headers, and startup refusals for unsafe settings. `runtime/Dockerfile` is removed. |
| #218 | The repository hygiene check tolerates unstaged deletions. |
| #216 | The repository hygiene check (`specs/ops/repo-hygiene.md`). Scripts with a shebang are executable, the version is 0.3.0 everywhere, and the root tests run by glob. |
| #215 | CI lint gate for `runtime/src`, with zero warnings allowed (`specs/ops/ci-product-suites.md` REQ-3). |
| #213, #214 | `stratum/` moved to `runtime/`; the package is `@miltonadina/devops-runtime` (ADR-0026). |

Test floors in `governance/test-floors.json` are root 473 and runtime 1415. CI fails a suite whose passing count drops below its floor. A floor may fall only through a declared `lowerings` entry.

## Work in progress: payment removal, cycle C1

- **Spec:** [`specs/ops/payment-removal.md`](../../specs/ops/payment-removal.md), approved by the owner in spec batch 1. C1 implements REQ-1, REQ-2, REQ-3 and REQ-6, plus the every-cycle rules REQ-10 to REQ-15.
- **Build plan:** [`c1-payment-surface-backlog.md`](c1-payment-surface-backlog.md). It holds the decisions (D1 to D9), the tasks (T1 to T7) and the proof rules. Five planner questions were answered after it was written; they are listed below.
- **State on `feature` (WIP commit `7565ca4`):**
  - Done and tester-verified: T2 (the plan reader reads from the sessions deps); T1a and T1b (the payment routes, the Stripe webhook, the OpenAPI payment paths and the two webhook event types are removed); T3a to T3c (`routes/usage.ts`, `usage/summary.ts`, `routes/org-scope.ts`, the fee-free session stats, and their tests).
  - Written but not verified: T4 (`routes/billing.ts` trimmed to the factory that `scripts/invoice.ts` still uses).
  - Not started: T5 (spec amendments and docs), T6 (the floor lowering entry), T7 (the proof on the running system), and an independent review, security scan and validation.
- **Answers to the planner's five questions:**
  1. Fix the pre-existing type error in `runtime/vercel-src/entry.ts` (`let ready` must accept what `app.ready()` returns) as part of that file's edit, so the adapter typecheck exits 0.
  2. The `developerBreakdown` case leaves `runtime/test/billing/billing-deps-read.test.ts` and moves to `runtime/test/proxy/usage-deps-read.test.ts` without its fee field.
  3. The OpenAPI 200 descriptions on the usage paths say "USD figures are estimates, for information only". The no-fee regex check on the whole document stays as written.
  4. The `STRIPE_WEBHOOK_SECRET` grep covers `runtime/src/proxy` and `runtime/vercel-src` only; test fixtures that prove the variable is ignored may name it. For `index.ts`, the no-billing-import check excludes its two `../billing/usage-recorder` and `../billing/durable-usage-outbox` imports, which belong to C2.
  5. Relocated tests keep their non-fee assertions. Assertions on `cq_fee_usd`, `signed_hash` and `total_cq_fee_usd` become absence checks.
- **To continue:**
  1. Check out `feature`. Leave the WIP commit or reset it; either way, the next commit must describe the whole C1 change.
  2. Finish T4 to T7 as the backlog says.
  3. Have the result reviewed and validated independently before the PR: nothing certifies itself.
  4. T7 needs the local Supabase-compatible Compose stack (Docker) for the SQL tests, `npm run setup` and a team-mode boot.

## After C1

Per the spec:
- **C2:** unsigned usage ledger (migration M1), and the usage modules move out of `runtime/src/billing/`.
- **C3:** delete `runtime/src/billing/`, `runtime/scripts/invoice.ts`, `runtime/src/proxy/routes/billing.ts` and the payment types.
- **C4:** migration M2, simpler session erasure, and backup restore of old backups.

Then:
- claim retirement;
- the naming cycle (`specs/ops/one-platform-naming.md`): `DEVOPS_*` settings aliases and capitalised "Stratum" prose;
- v0.4 pruner cycles 1b and 2.

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
