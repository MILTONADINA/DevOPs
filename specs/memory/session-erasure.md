# Scoped session erasure

**Status**: approved

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` REQ-8/9.
C4-A moves this spec out of `specs/billing/`, retires the invoice schema and
financial preflight blocker, and supersedes ADR-0021. The deletion endpoint and
its initial managed explicit-session class passed controlled authenticated HTTP
verification on 2026-10-03. Broader coverage and the one-year performance
acceptance remain unfinished; this specification remains approved.

**C4-B amendment:** 2026-10-03, approved implementation scope under
payment-removal REQ-8/AC-8: initial managed erasure for newly enrolled explicit
sessions only. Requirements below are delivery obligations, not a claim that
all session classes, operating lifecycles or acceptance gates are complete.

**Scope:** `plan.md` §8 and `runtime/docs/SECURITY.md` §GDPR Erasure. A
customer may request deletion of one session's content. Unsigned usage rows
remain ordinary session-linked data with organization/session foreign keys.
ADR-0025 and payment-removal REQ-8 supersede the former financial premise;
the inventory, ownership and deletion gates below remain required.

**Initial managed boundary:** deployed application processes, retained caches
and pending work, the database, application-controlled local captures,
exports/backups, and configured external adapters/copies. Client-held response
copies, privileged host/database snapshots and physical heap/OS remnants are
outside the reported guarantee; excluded does not mean absent, erased or
anonymous. Unknown relevant application consumers or generations remain
blocked. Broader historical/conversation/managed-copy support and the one-year
benchmark remain open until separately proved.

The first positive proof uses a fresh isolated project-local Compose instance,
new volume, distinct generated credentials and a bound application/storage
generation. Trusted operator activation is privileged and disabled by default;
the existing operator stack and its organizations remain unknown/ineligible.
The initial session class is freshly minted organizations and normal capped
API-created explicit sessions with complete provenance and managed coverage.
Generic inserts, imports, restores and existing sessions cannot obtain that
coverage from their data or caller flags.

## REQ-1 — Scoped, complete session inventory

WHEN a session erasure is requested, THE SYSTEM SHALL resolve the session by
both authenticated organization ID and session ID. It SHALL inventory every
persisted row tied to the session, including typed facts, audit evidence,
pruning logs, vectors, graph entities and edges, source links, billing records,
and any external copy or backup. It SHALL distinguish session-owned graph rows
from graph rows reused by another session. A missing or ambiguous owner SHALL
fail closed rather than silently leave or delete content.

### REQ-1a — Graph provenance across reuse

WHEN a graph entity or edge is created with a trusted session ID, THE DATABASE
SHALL record that session as a source in the same transaction. WHEN the graph
adapter reuses an existing entity or edge for another trusted session, IT
SHALL record the second session before reporting success. Provenance links
SHALL enforce same-organization entity/edge/session references. Existing rows
whose complete source history cannot be proved SHALL remain marked uncertain;
adding a new link SHALL NOT retroactively make them exclusive. The session
promoter SHALL pass each database-loaded fact's trusted session ID to graph
and vector promotion, including when a batch spans several sessions. The
inventory SHALL include entities and edges linked through provenance even
when their original `session_id` differs, and SHALL distinguish uncertain,
shared and exclusive graph ownership without deleting any row.
An organization backup and restore SHALL preserve all recorded session links
so a recovered inventory cannot misclassify a shared graph row.

### REQ-1b — Source-link recovery fidelity

WHEN an organization with indexed File-to-fact links is backed up and restored
to a clean target, THE SYSTEM SHALL export every scoped source link and restore
its original ID and timestamp. It SHALL replace links recreated by File/fact
insert triggers with the backed-up rows, so the recovered inventory and source
view reflect the original snapshot.

### REQ-1c — Read-only customer preflight

WHEN an organization-level authenticated key requests an explicit session's
erasure preflight, THE API SHALL return the scoped database inventory and
factual readiness or blocked reasons without preparing erasure or changing
coverage. Blocked reasons SHALL distinguish ambiguous graph ownership,
uninventoried stores and unavailable execution as applicable. It SHALL NOT report a financial
retention blocker because usage rows exist. It SHALL return 404 for a foreign,
missing, or internal usage session and deny project-bound keys. It SHALL NOT
delete data or claim erasure is ready while external copies, backups, or RAM
remain uninventoried or erasure execution is unavailable.

## REQ-2 — Usage is ordinary session-linked data

WHEN an authorized session erasure executes, THE SYSTEM SHALL delete that
session's usage rows in `billing_records` as ordinary session-linked data
within the transaction required by REQ-3. The inventory SHALL continue to
report a numeric `billing_records` count, including zero. Usage rows SHALL NOT
create a billing-retention blocker. Any data retained for another applicable
reason SHALL be identified in the response and excluded from ordinary memory
recall; replacing a linkable identifier SHALL NOT be described as anonymization.

## REQ-3 — Atomic content deletion and reuse safety

WHEN an authorized, policy-cleared session erasure executes, THE SYSTEM SHALL
delete all session-owned content and its vector/source/audit derivatives within
one database transaction. It SHALL invalidate in-memory session content and
prevent new writes for that session before reporting success. It SHALL preserve
other organizations' rows and shared graph entities still referenced by other
sessions. IF any required store fails, THEN it SHALL report an incomplete
erasure and retain a retryable record; it SHALL NOT return a success response.

## REQ-4 — Verifiable completion and performance

WHEN an erasure reports success, THE SYSTEM SHALL return a timestamp and a
machine-checkable inventory of deleted and legally retained data classes. A
local integration check SHALL prove a foreign-organization request cannot
erase the target, session-linked usage is deleted without a financial blocker,
a shared graph entity survives, and all session-owned content is gone. The
check SHALL invoke an actual authenticated erasure API and verify the database
afterward. A read-only preflight or end-session response SHALL NOT satisfy
this requirement or payment-removal AC-8. The v0.9 release gate SHALL
measure end-to-end erasure of a representative one-year session history in
under 30 seconds and record the fixture size, command, elapsed time, and
remaining rows. A small fixture alone SHALL NOT satisfy that gate.

## REQ-5 — Privileged activation

WHILE trusted operator activation has not established the fresh isolated
instance and deployed coverage generation, THE SYSTEM SHALL keep erasure
disabled under an authority boundary unavailable to ordinary service-role
fields, SQL session settings or RPC parameters.

## REQ-6 — Fresh organization authority

WHEN the shipped operator creates an eligible organization, THE DATABASE SHALL
mint its identity and trusted coverage atomically without accepting a supplied
identity or upgrading an existing, generic, imported or restored organization.

## REQ-7 — Normal capped session enrollment

WHEN the existing capped operation creates an explicit session for a covered
organization, THE DATABASE SHALL enroll it in that same serialized transaction
while preserving cap, project scope and response behavior; all other session
creation paths remain ineligible.

## REQ-8 — Monotonic uncertainty before copying

WHEN an operation can create an untracked protected application copy, THE
SYSTEM SHALL durably mark organization-wide coverage uncertain before its
first protected read/copy, refusing all protected I/O on a failed transition
or erasure conflict and retaining uncertainty for current and future sessions
across update, export completion, restore, timeout and retry.

## REQ-9 — Honest managed-store classification

WHEN eligibility is computed, THE SYSTEM SHALL classify every relevant managed
store and consumer as covered, excluded by an enforced identity boundary, or
unknown, blocking unknown/stale generations and disclosing the excluded
client/privileged-host/physical-memory classes without calling them erased.

## REQ-10 — Durable fence and stable retry

WHEN preparation succeeds, THE DATABASE SHALL retain a scoped erasing fence
through failure or transport loss until completion, after which its stable
receipt/tombstone survives session deletion and rejects ordinary identity
resurrection or restore.

## REQ-11 — Serialized writes and references

WHEN a writer changes covered, fenced or tombstoned target-associated data,
THE DATABASE SHALL serialize prior and resulting ownership and generic
references against erasure, rejecting cross-organization, nonexistent or
ambiguous ownership and late resurrection without weakening current identity,
RLS, audit or provenance safeguards. Unrelated otherwise-valid legacy orphan
vectors in unknown organizations remain unknown; that exception cannot confer
coverage or bypass erased-source tombstones.

## REQ-12 — Private deletion and safe shared survivors

WHEN eligible erasure executes, THE DATABASE SHALL recompute dependencies and
delete private usage, pruning, facts and source/vector/audit derivatives in
one transaction, preserving valid shared survivors and blocking unsupported
incoming or shared-origin dependencies before any content deletion.

## REQ-13 — Managed memory and copy completion

WHEN target content exists in retained application RAM, pending work or a
managed local/external copy, THE SYSTEM SHALL drain/invalidate/remove it
through trusted ownership before successful completion, without eviction
callbacks that can repersist content or applying explicit-session exclusions
to legacy/conversation data.

## REQ-14 — Legacy restore without reenrollment

WHEN a historical backup is restored, THE SYSTEM SHALL preserve existing
retired-table/column compatibility, source/provenance/key safeguards and known
tombstones while treating imported or missing erasure metadata as unknown
coverage rather than rejecting old formats or authorizing reenrollment.

## REQ-15 — Authenticated execution contract

WHEN `POST /v1/sessions/:id/erasure` is requested, THE API SHALL apply the
organization-only authentication and outcome contract below using trusted
request scope and a fresh serialized eligibility check, without changing
existing DELETE-as-end behavior.

## REQ-16 — Factual scoped receipt

WHEN all required managed-store work and database deletion complete, THE API
SHALL return a stable scoped receipt recorded atomically with database
deletion, including completion time, actual deleted and retained class counts,
identified linkable retry metadata and declared exclusions, never inferring
erasure solely from a missing session or exposing raw content, foreign
identifiers, credentials or SQL errors.

## C4-B API outcome contract

| Operation or condition | Required outcome |
| --- | --- |
| Preflight for a known explicit session | HTTP 200 scoped inventory with ready/blocked status; no state change. Readiness never authorizes the later POST without rechecking. |
| Personal or project-bound preflight/execution | 403. |
| Foreign/missing session or internal session kind, absent an authenticated completed receipt | 404; no foreign receipt/identity disclosure. |
| Organization or coverage override supplied to execution | 400; no query/body scope fallback or trusted client clearing flag. |
| Known explicit session with unsupported/unknown/stale coverage or unsafe dependency | Execution 409 with safe nonfinancial reasons before content mutation. |
| Required store unavailable or prepared execution incomplete | 503 with retryable/incomplete status; no completion receipt. A possibly committed prepare is resolved by scoped state lookup on retry. |
| Successful execution or retry after a lost committed response | 200 with the same stored scoped receipt. Ordinary session GET after erasure returns 404. |
| Existing `DELETE /v1/sessions/:id` | End-session behavior only; never proof of erasure. |

A receipt identifies retained metadata and dispositions, not an invented legal
retention basis. Unknown stores cannot be relabeled empty because a fixture is
synthetic. Privileged activation cannot be achieved by an environment boolean
or any request or ordinary service-role override. Direct enrollment writes and
uncertainty resets are outside normal application privileges.

## C4-B acceptance criteria

Each case below is a delivery gate, not completed evidence. All positive
fixture writes use ordinary production ownership and write guards.

### AC-B1 — Default-disabled activation (REQ-5, REQ-9)

**Given** the original operator stack or an unactivated instance, **when** any
ordinary service-role field, SQL setting, RPC parameter or client/environment
flag attempts activation, **then** execution remains disabled. The real
positive check uses a fresh isolated Compose volume, distinct generated
credentials and privileged operator activation bound to the deployed
generation; it does not activate or mutate the original stack.

### AC-B2 — Fresh authority and capped enrollment (REQ-6, REQ-7)

**Given** an activated isolated instance, **when** the shipped organization
operation and normal authenticated session API are used, **then** the fresh
server-minted org and explicit session enroll atomically. Existing/supplied
org IDs, generic/name-reused/imported/restored identities and other session
kinds cannot enroll; cap races, project scope and response shape are preserved.

### AC-B3 — Copy failures stop I/O (REQ-8)

**Given** each bound protected read/export seam, including direct helpers and
fallbacks, **when** the uncertainty transition fails, **then** no protected
query, fallback, return or file write occurs. Successful and failed copying
leave uncertainty permanent for that organization and its future sessions.

### AC-B4 — Complete source and generation boundary (REQ-9, REQ-13)

**Given** every relevant store/consumer classified at the deployed generation,
**when** a generation is stale or a consumer is unknown, **then** execution
blocks. Enforced excluded paths are distinguishable from unknown paths;
metadata-only auth/plan/preflight does not silently authorize content reads.

### AC-B5 — Real concurrency (REQ-7, REQ-8, REQ-10, REQ-11)

**Given** two actual database connections coordinated by explicit barriers,
**when** enrollment, copy marking, preparation and pending writes race,
**then** only safe serialized outcomes occur and no post-completion orphan is
created, including a write whose transaction began before preparation. Covered
operations require READ COMMITTED isolation and fresh reads after acquiring
the shared organization lock; unsupported isolation is rejected before work,
and a stale pre-lock snapshot cannot authorize a write.

### AC-B6 — Association and generic-reference guards (REQ-11)

**Given** covered, fenced or tombstoned target ownership across facts, usage,
pruning, audits, vectors and graph/source references, **when** OLD/NEW
reparenting, cross-org association, missing generic sources or post-fence
writes are attempted, **then** the write fails without resurrection.
Otherwise-valid unrelated legacy orphan vectors in unknown organizations
retain existing behavior without granting coverage; global erased-source
tombstones still reject late references even from unknown organizations.
Unknown/missing ownership remains an eligibility blocker. Existing audit,
provenance, caps, RLS, replay and outbox behavior remains verified.

### AC-B7 — Real substantive API deletion (REQ-2, REQ-3, REQ-4, REQ-12)

**Given** two normal API-created explicit sessions in a fresh covered org and
a target with nonzero usage, pruning, all six fact kinds, exclusive graph rows
and generic audit/vector/source derivatives, **when** the actual authenticated
erasure API completes, **then** an independent database connection proves
private rows absent by captured identities and usage gone without a financial
blocker. Derivatives with a different or null session pointer are included by
their actual source ownership.

### AC-B8 — Shared survival and unsafe dependency refusal (REQ-1a, REQ-12)

**Given** a shared entity/edge anchored to the surviving session, **when** the
target is erased, **then** the survivor and valid remaining provenance/derived
rows remain usable. Target-origin shared rows, unsafe incoming source/edge
links and external decision/pruning dependencies block before deletion until
a separately proved safe handling exists.

### AC-B9 — Rollback and stable retry (REQ-3, REQ-10, REQ-16)

**Given** durable preparation, **when** a real intermediate SQL failure occurs,
**then** all content changes roll back while the fence remains retryable.
Retry completes normally; retry after a lost committed response returns the
same scoped receipt. A required-store failure never returns success.

### AC-B10 — Authentication and HTTP outcomes (REQ-1c, REQ-15, REQ-16)

**Given** personal/project/foreign/missing/spoofed, ineligible, unavailable and
completed requests, **when** preflight or execution is called, **then** every
status and privacy rule in the API outcome table holds. Preflight stays
read-only; DELETE stays end-only; foreign completed receipts cannot leak.

### AC-B11 — Memory/capture exclusion (REQ-9, REQ-13)

**Given** an enrolled explicit session, **when** its identity is supplied to
streaming or nonstreaming conversation requests, **then** rejection occurs
before upstream/capture/shadow/outbox work. Deployed source proves initial
explicit data cannot enter retained capture/hot/pending paths; a new reachable
unsupported path invalidates coverage before intake.

### AC-B12 — Legacy recovery and tombstones (REQ-1a, REQ-1b, REQ-14)

**Given** a synthetic pre-C2 backup, **when** restored after these migrations,
**then** active content restores with retired-table skip and column-strip
reports, absent new metadata is accepted, imported coverage cannot enroll,
and known tombstones reject resurrection. Source IDs, provenance and inactive
key defaults survive; absence of tombstone history is not proof of no prior
erasure.

### AC-B13 — Normal production writers, no fixture bypass (REQ-6–REQ-12)

**Given** ordinary shipped creation and writer seams, **when** the substantive
shared fixture is populated, **then** it remains constructible without direct
enrollment, uncertainty resets, fake readiness or guard exceptions. Warm/graph
reuse that exports protected content must mark uncertainty or use a genuine
transaction-contained production write path. Mocked erasure, empty fixtures
and preflight/end-session responses cannot satisfy payment-removal AC-8.

### AC-B14 — Limited completion and separate benchmark (REQ-4, REQ-9)

**Given** the initial class passes the real API and SQL inventory checks,
**when** acceptance is recorded, **then** the proof distinguishes that class
from unsupported historical/conversation/managed-copy cases and the separate
representative one-year/<30-second release gate. No general erasure or project
completion claim follows from the small fixture.

The six fact kinds in AC-B7 are `function_changes`, `tech_decisions`,
`policy_updates`, `todos`, `variable_changes`, `operational_references`.

## Acceptance status

- C4-A/M2 retires both invoice RPCs and both invoice tables, removes their
  organization-only inventory entries, and removes the financial preflight
  blocker. `billing_records` and its numeric count remain; C4-A alone did not
  implement erasure or satisfy the actual-API part of payment-removal AC-8.
- On 2026-10-03, the initial `managed_explicit_session_v1` class passed actual
  authenticated HTTP verification with normal constructors/writers and the
  shipped proxy entry. Evidence:
  `.workflow/proofs/c4b-2026-10-03/erasure-api-a1f74062-1674-44f2-90f1-4425f7d57180.json`,
  manifest digest
  `9bdacccab02dcc3257703b82341dc011d9a3c7f682798fbf33bba56c89976e35`.
  The proof checks private-data deletion, shared/foreign-data survival,
  unknown-coverage refusal, rollback and a stable receipt after a lost response.
  The matching activation was then disabled and its consumers stopped.
- With the executor configured, preflight reports `ready` or `blocked` for
  the supported class and its applicable ownership/store reasons; readiness
  alone does not mean deletion. Unknown managed stores remain blocked.
  `DELETE /v1/sessions/:id` only sets `ended_at`; it does not erase data.
- The initial source/process/store boundary excludes explicit-session content
  from unsupported memory/capture paths and refuses unknown application copies.
  It does not establish erasure of arbitrary RAM, external copies or backups.
  Receipts retain the declared client-held-response, privileged-snapshot and
  physical-remnant exclusions; excluded does not mean absent or erased.
- Historical/conversation sessions, broader managed-copy support, general
  managed onboarding/restart operations and the representative
  one-year/<30-second benchmark remain unfinished. The small HTTP fixture is
  not that benchmark, and the original operator stack remains ineligible.
