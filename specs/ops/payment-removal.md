# Payment removal

**Status**: approved (owner, 2026-09-26, spec batch 1; recorded in .workflow/state/approvals.jsonl as human_approved_spec)
**Spec ID**: ops/payment-removal

**Scope:** the owner decision of 2026-09-26 (ADR-0025: open source, no payment,
local-first). Stratum still contains a payment layer: Stripe invoice sending
and webhook handling, a 20% fee calculator, invoice tables, a CFO page, and an
HMAC-signed, append-only `billing_records` ledger. This spec holds the removal
requirements for four graph cycles, C1 to C4, so that their claims have a
`spec_ref` under `specs/`. It keeps what is not payment: exact token
measurement, the usage ledger's token counts, token and USD estimates shown as
information, organizations and API keys, and the multi-provider gateway.

Cycle order: **C1** removes the payment HTTP surface and re-homes the plan
reader. **C2** moves usage measurement off the billing modules and applies
migration M1. **C3** deletes the payment modules. **C4** removes the invoice
schema (migration M2) and simplifies session erasure. C3 touches paths under
the billing four-eyes gate; the gate's retirement is a separate graph cycle
that lands before C3. That cycle also adds the declared-lowering mechanism of
REQ-12, which must be on `main` before C1 lowers any test floor.

## REQ-1 — The payment HTTP surface is absent (C1)

WHEN C1 lands, THE PROXY SHALL NOT register `GET /billing`,
`GET /v1/billing/invoice`, `GET /v1/billing/audit.csv`,
`GET /v1/billing/invoices` or `POST /stripe/webhook`, in personal or team
mode. THE OPENAPI DOCUMENT (`stratum/src/proxy/openapi.ts`) SHALL drop the
same paths, the `Invoice` schema and the fee description in the same commit
as the route removal, so that its paths remain a subset of the registered
routes. No response, webhook payload or OpenAPI schema SHALL carry a
`cq_fee_usd` field. The `invoice.ready` and `tee.attestation_failed` webhook
event types (`stratum/src/webhooks/events.ts:11`; sample payloads at lines
83 and 92) SHALL be removed together with their sample payloads;
`tee.attestation_failed` goes because the TEE is dropped (ADR-0025). Tests
that used either event SHALL switch to a surviving event type so that they do
not pass on an unknown-event 400. `stratum/api/index.js` is not a committed
file: it is a gitignored local build output of `npm run build:vercel`
(`stratum/.gitignore:9-11`), and the project has no deployment. C1 therefore
has no bundle to commit; WHEN a developer regenerates the bundle locally after
C1, IT SHALL NOT serve the removed routes. Removing the Vercel adapter is a
separate cleanup (Out of scope).

## REQ-2 — The plan reader moves before the billing routes go (C1)

WHEN C1 rewrites or deletes `stratum/src/proxy/routes/billing.ts`, THE
SYSTEM SHALL read an organization's plan for per-plan rate limits and the
token budget from the sessions dependencies, not from the billing
dependencies. Per-plan request limits, concurrent-session caps and token
budgets SHALL behave as they did before the change. Removing only the
billing dependency object, so that plan lookups fall through to the
fail-open default, SHALL NOT satisfy this requirement.

## REQ-3 — A token-only usage read API (C1)

WHERE the usage read API is kept (the default), THE SYSTEM SHALL serve an
organization's monthly usage summary and paginated usage records with token
totals and effectiveness, and no fee, plan minimum or amount due. It SHALL
compute these without importing any module under `stratum/src/billing/`, and
a project-bound API key SHALL receive 403, as it does for the current billing
read paths. Reads of `cq_fee_usd` and `signed_hash`, here and in
`stratum/src/proxy/routes/sessions.ts`, SHALL be gone before migration M1
drops those columns.

## REQ-4 — The usage ledger is unsigned (C2, migration M1)

THE SYSTEM SHALL write one usage row per request with the organization,
session, original and quarantined token counts, the optional pruning log and
the usage event ID, and SHALL NOT compute an HMAC signature or a fee for it.
Migration M1 SHALL drop, in this order: the three `billing_records`
immutability triggers, the `billing_records_immutable()` function, the
generated `cq_fee_usd` column, and the `signed_hash` column. The unsigned
writer and M1 SHALL land in the same commit, because `signed_hash` is
`NOT NULL` until M1 runs. WHEN the same usage event is written twice, THE
WRITER SHALL detect the replay by comparing its inputs (organization,
session, original tokens, quarantined tokens, usage event ID), not a
signature, and the unique index on the usage event ID SHALL be kept. The
table SHALL keep the name `billing_records` in this pass; renaming it is a
separate decision.

## REQ-5 — Team-mode usage persistence needs no signing secret (C2)

WHEN Stratum starts in team mode (`CQ_COMMERCIAL=true`) with a database URL
and service key, THE SYSTEM SHALL wire usage persistence without
`CQ_BILLING_SIGNING_SECRET`, and the startup assertion SHALL stop requiring
that secret and nothing else. IF usage persistence would be turned off by
the change (no usage rows, zero session stats), THEN the cycle SHALL NOT
land. The existing guard that refuses a non-persistent journal location
SHALL stay while the durable outbox exists. The usage modules SHALL be copied
out of `stratum/src/billing/` into a new location; C2 SHALL NOT stage any
path under `stratum/src/billing/`, and no cycle SHALL move files out of it
with `git mv`.

## REQ-6 — USD estimates are kept as information (C1 to C4)

THE SYSTEM SHALL keep exact token counts and SHALL keep its USD estimates:
the per-model price table, the pinned price per token and the generated cost
difference on usage rows, the session statistics' estimated savings, and the
personal dashboard's estimated cost. Each USD figure SHALL be labelled as an
estimate. No USD figure SHALL be presented as a fee, a charge, a plan minimum
or an amount due.

## REQ-7 — The payment modules are deleted (C3)

WHEN C3 lands, every file under `stratum/src/billing/` and
`stratum/scripts/invoice.ts` SHALL be deleted in one commit, together with
the payment-only tests, the `invoice`, `verify-billing` and `verify-stripe`
npm scripts that remain, and the payment types in
`stratum/src/types/billing.ts`. After C3, no module SHALL import from
`stratum/src/billing/`: the importer check
`git grep -nE "['\"](\.\.?/)+([^'\"]*/)?billing/" -- stratum/src stratum/scripts stratum/test stratum/vercel-src`
SHALL print nothing, and `npm run typecheck` SHALL pass. The check matches
relative module specifiers that pass through a `billing/` directory (static
imports, dynamic imports and `vi.mock` paths), so it does not match the kept
usage read API's URL strings. C3 SHALL land only after the cycle that retires
the billing four-eyes gate has landed on `main`.

## REQ-8 — Session erasure works without a financial ledger (C4, migration M2)

Migration M2 SHALL drop `reconcile_claimed_invoice`, then
`record_invoice_payment`, then the `invoice_send_claims` and `invoices`
tables, and SHALL redefine `inspect_session_erasure` in the same file so that
its organization-only classes no longer list the dropped tables. WHEN a
session is erased, THE SYSTEM SHALL treat that session's usage rows as
ordinary session-linked data and SHALL NOT report a billing-retention
blocker. The erasure inventory SHALL still report a numeric
`billing_records` count. ADR-0021 SHALL be marked superseded in the same
cycle, and the session-erasure spec SHALL move out of `specs/billing/`
without its billing-retention requirement.

## REQ-9 — Backups from before the removal still restore (C2 and C4)

THE ORGANIZATION BACKUP SHALL stop exporting `invoices` and
`invoice_send_claims` in the same commit as M2, because export fails loudly on
a missing table. WHEN a backup taken before the removal is restored, THE
RESTORE SHALL skip the retired tables (`invoices`, `invoice_send_claims`),
SHALL strip the retired columns (`cq_fee_usd`, `signed_hash`) from the rows it
inserts, and SHALL report what it skipped and stripped. IF a backup carries
retired tables or columns, THEN THE RESTORE SHALL NOT refuse it for that
reason.

## REQ-10 — Migration history is append-only

No cycle SHALL edit or delete an existing migration, including the invoice
migrations: a fresh replay depends on them. New migration file names SHALL
sort after every migration present on `main` when the cycle starts.

## REQ-11 — The gateway is untouched

No cycle under this spec SHALL stage a path under
`stratum/src/proxy/providers/`, including comment-only rewording. The
multi-provider gateway is not payment code.

## REQ-12 — Test floors fall only through declared lowerings

The cycle that retires the billing four-eyes gate SHALL add a declared-lowering
mechanism to `scripts/check-test-floor.mjs`, and the mechanism SHALL be on
`main` before cycle C1 lowers any floor. `governance/test-floors.json` SHALL
carry a `lowerings` array whose entries have the form
`{"suite", "from", "to", "reason", "decision"}`. WHEN a head floor is below
`main`'s floor for the same suite, `checkRatchet` SHALL accept it only if the
head file's `lowerings` holds a new entry (one that `main`'s `lowerings` does
not already contain) whose `suite` names that suite, whose `from` equals
`main`'s floor, whose `to` equals the head floor, and whose `reason` and
`decision` are non-empty; otherwise it SHALL refuse the lowering as it does
today. An entry already on `main` SHALL NOT authorize a lowering again. For
every lowering it accepts, the check SHALL print
`test floors: LOWERED <suite> <from> -> <to>: <reason>`. A floor that rises or
stays the same needs no entry. Consecutive lowerings chain: each cycle's `from`
is `main`'s floor when that cycle lands.

WHEN a cycle removes tests, it SHALL lower the Stratum floor only through such
an entry, whose `decision` cites the owner decision of 2026-09-26 (ADR-0025)
and whose `to` is the passing count of the post-change `vitest run`, not a
figure from a plan. The root floor SHALL stay unchanged unless a root test is
removed, which this spec does not plan.

## REQ-13 — Frozen fixture files are not edited

No cycle SHALL edit these tracked files, even where they mention billing,
invoices or the signing secret:

- `stratum/evals/datasets/golden/tier-c.jsonl`
- `stratum/evals/datasets/provenance/pges-fixture.dev.jsonl`
- `stratum/evals/datasets/provenance/pges-fixture.dev.jsonl.sha256`
- `stratum/evals/datasets/provenance/pges-fixture.sealed.jsonl`
- `stratum/evals/datasets/provenance/pges-fixture.sealed.jsonl.sha256`

A repository-wide search-and-replace SHALL exclude them. No imported session
transcript is tracked (`git ls-files stratum/data` printed nothing on
2026-09-26, and `stratum/data/sessions/` is gitignored), so none is listed.

## REQ-14 — Each cycle is verified on the running system

Before a cycle lands, THE CYCLE SHALL run the typecheck, the full Stratum
vitest suite, the root `npm test`, and every `stratum/test/integration/*.sql`
file against the local stack, and SHALL boot the real proxy: root
`npm run setup` (which includes the smoke boot) and a team-mode `npm run dev`
answered by `GET /health`. A green unit suite alone SHALL NOT count as
evidence that the entry point boots.

## REQ-15 — Documents change with the code they describe

Each cycle SHALL update the documents that describe the behavior it changes
(the API reference, architecture, telemetry, webhooks, monitoring and the
runbooks). A document SHALL NOT describe a payment component as removed
before the cycle that removes it has landed.

## Out of scope

Retiring the billing four-eyes gate (its own graph cycle). Renaming
`billing_records`, `CQ_COMMERCIAL` or the plan tier names. Changing the
fail-closed usage journal or its client-visible `billing_unavailable` error.
Removing the Vercel adapter. Dropping the USD estimates (the owner kept them).
Retiring the proof claims that the removal breaks, which is a ledger action
after C4.

## Acceptance criteria

### AC-1 (REQ-1)
**Given** C1 has landed **When** the proxy boots in team mode **Then**
`GET /billing`, the three `/v1/billing/*` payment paths and
`POST /stripe/webhook` return 404, `/openapi.json` lists none of them, and the
OpenAPI parity test passes.

**Verified by:** C1, a Stratum route test plus the existing OpenAPI parity test (stratum/test/proxy/openapi.test.ts). Test titles name `specs/ops/payment-removal.md#AC-1`.

### AC-2 (REQ-2)
**Given** C1 has landed **When** a starter-plan organization sends its 21st
request in a minute **Then** it receives 429, as before C1.

**Verified by:** C1, a rate-limit test in stratum/test/proxy/ that reads the plan through the re-homed reader. Test titles name `specs/ops/payment-removal.md#AC-2`.

### AC-3 (REQ-3)
**Given** the usage read API is kept **When** an organization key reads its
monthly summary **Then** the response has token totals and no fee field, and a
project-bound key receives 403.

**Verified by:** C1, the usage read API route test in stratum/test/proxy/. Test titles name `specs/ops/payment-removal.md#AC-3`.

### AC-4 (REQ-4)
**Given** M1 has been applied to the local stack **When** the same usage event
is written twice **Then** one row exists, it has no `signed_hash` or
`cq_fee_usd` column, and an UPDATE on it is no longer rejected by a trigger.

**Verified by:** C2, the SQL integration test that replaces stratum/test/integration/local-billing-ledger.sql, run in CI by setup-linux. Test titles name `specs/ops/payment-removal.md#AC-4`.

### AC-5 (REQ-5)
**Given** team mode with a database and service key and no
`CQ_BILLING_SIGNING_SECRET` **When** the proxy starts and a message is sent
**Then** it boots, and a usage row for that request appears in the local
database.

**Verified by:** C2, a start-options test plus the local team-mode boot recorded under AC-12. Test titles name `specs/ops/payment-removal.md#AC-5`.

### AC-6 (REQ-6)
**Given** any cycle has landed **When** the dashboard, session statistics or
usage API are read **Then** token counts and USD estimates are present, and no
figure is labelled as a fee, charge or amount due.

**Verified by:** C1 and C2, route and dashboard tests in stratum/test/proxy/ that assert USD estimates are present and no fee field exists. Test titles name `specs/ops/payment-removal.md#AC-6`.

### AC-7 (REQ-7)
**Given** C3 has landed **When** the importer check runs **Then**
`git grep -nE "['\"](\.\.?/)+([^'\"]*/)?billing/" -- stratum/src stratum/scripts stratum/test stratum/vercel-src`
prints nothing and the typecheck passes.

**Verified by:** C3, the importer grep plus `npm run typecheck`, recorded in the cycle proof (an ops check, verified by the committed claim). Test titles name `specs/ops/payment-removal.md#AC-7`.

### AC-8 (REQ-8)
**Given** M2 has been applied **When** the SQL erasure-inventory test runs and
a session is erased through the API **Then** the coverage guard passes, and the
erasure preflight reports no billing-retention blocker.

**Verified by:** C4, stratum/test/integration/local-session-erasure-inventory.sql plus the sessions-route test. Test titles name `specs/ops/payment-removal.md#AC-8`.

### AC-9 (REQ-9)
**Given** a backup exported before C2 that contains `invoices`,
`invoice_send_claims` and rows with `signed_hash` **When** it is restored after
C4 **Then** the restore succeeds, the other tables' rows are present, and its
output names the skipped tables and stripped columns.

**Verified by:** C4, stratum/test/audit/restore-org.test.ts with a legacy backup fixture. Test titles name `specs/ops/payment-removal.md#AC-9`.

### AC-10 (REQ-10, REQ-11, REQ-13)
**Given** any cycle's diff **When** it is reviewed **Then** it modifies no
existing migration, no path under `stratum/src/proxy/providers/`, and none of
the files listed in REQ-13.

**Verified by:** every cycle: the reviewer checks the diff (an ops check, verified by the committed claim). Test titles name `specs/ops/payment-removal.md#AC-10`.

### AC-11 (REQ-12)
**Given** the declared-lowering mechanism is on `main` and a cycle that removes
tests adds a new `lowerings` entry whose `from` is `main`'s Stratum floor, whose
`to` is the cycle's passing count, and whose `reason` and `decision` are
non-empty **When** CI runs the ratchet check **Then** it passes and prints
`test floors: LOWERED stratum <from> -> <to>: <reason>`. The same lowered floor
with no entry, with only an entry already on `main`, or with an entry whose
`suite`, `from` or `to` does not match, is refused.

**Verified by:** the billing-gate retirement cycle: tests/graph/test-floors.test.mjs. Test titles name `specs/ops/payment-removal.md#AC-11`.

### AC-12 (REQ-14, REQ-15)
**Given** a cycle is ready to land **When** its evidence is read **Then** it
records the typecheck, both test suites, the SQL loop, the setup smoke boot
and a team-mode `/health` response, and every document it changed describes
the code as of that cycle.

**Verified by:** every cycle: the cycle proof (an ops check, verified by the committed claim). Test titles name `specs/ops/payment-removal.md#AC-12`.

