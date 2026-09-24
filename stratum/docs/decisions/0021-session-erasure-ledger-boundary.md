# ADR-0021: Session erasure needs a separate financial retention boundary

**Date:** 2026-09-24
**Status:** Proposed; technical inventory complete, policy and implementation open
**Spec:** `specs/billing/session-erasure.md`

## Decision context

The v0.9 gate requires session erasure in under 30 seconds for a one-year
history. The current `billing_records` trigger rejects UPDATE, DELETE, and
TRUNCATE. Its signed inputs include `org_id` and `session_id`, and both are
foreign keys to `organizations` and `sessions`. The local ledger fixture proves
that deleting a referenced session fails. Therefore changing a billing
session ID in place would break both the database invariant and its HMAC.

The live project-local PostgreSQL catalog was inspected on 2026-09-24. It has
42 public foreign keys. Relevant NO ACTION links include billing to sessions,
organizations and pruning logs; facts, audit conflicts, vectors, graph rows,
and pruning logs to sessions; and invoices to organizations. Some graph and
source-link edges cascade, but `knowledge_entities` is unique by organization,
kind and name and `ensureEntity` can reuse an entity across sessions. Its
`session_id` is therefore not proof of exclusive ownership. A delete-by-
session filter could erase another session's graph node or leave its content
behind. `memory_vectors.source_ref` is text without a foreign key, so a fact
delete does not automatically remove the derived embedding.

## Decision

Do not present the current API as a GDPR erasure endpoint. Build the erasure
path around a scoped inventory and explicit retention decision first. A
service may delete content only after it can prove every dependent data class
is covered and shared graph rows are preserved. A billed session must remain
blocked until the financial record's retention basis and identity boundary
are documented. The financial ledger trigger remains enabled throughout.

Use a per-session tombstone to stop new writes before deleting stored content.
Record any incomplete external or backup deletion for retry. Return success
only after verification, with retained classes listed. This design keeps the
v0.9 ship gate open until a one-year fixture proves the full path in <30s.

## Policy boundary

[GDPR Article 17(3)](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679)
contains exceptions for processing necessary to comply with an applicable
legal obligation or for legal claims. It does not, by itself, establish that
this project's billing rows qualify. A specific jurisdiction, obligation,
purpose, minimum fields and retention period must be recorded before relying
on an exception. The
[EDPB distinguishes pseudonymisation from anonymisation](https://www.edpb.europa.eu/topics/ai-and-technology/anonymisation-pseudonymisation_en):
retaining a linkable org/session ID is not proof that the data is anonymous.
This ADR makes no compliance determination.

## Implementation order and checks

1. Add an org-scoped, read-only session inventory covering every public table,
   RAM, external stores, and backups; test it against the local catalog.
2. Define the lawful retention decision and move future financial records
   behind a separate identity boundary without rewriting existing HMACs.
   Specify how historic billed sessions are handled.
3. Add a transactionally locked tombstone and content deletion with explicit
   source/vector and shared-graph provenance handling.
4. Wire the authenticated endpoint, verify foreign-org isolation and no
   success on incomplete deletion, then benchmark a one-year fixture.

The first part of step 1 is implemented by the service-role-only
`inspect_session_erasure(org_id, session_id)` RPC in migration
`20260924000000_session_erasure_inventory.sql`. It reports counts for each
session-linked public table and explicitly marks organization-only classes,
graph ownership, RAM, backups, and external copies as unresolved. Its
rolled-back local fixture checks every current public table is classified,
derived vectors/links are counted, cross-organization calls return no row,
and public roles cannot invoke it. The RPC performs no deletion; step 1 is
still open for RAM, backup, and external-store inventory.

Migrations `20260924010000_graph_session_provenance.sql` and
`20260924020000_graph_provenance_update_guard.sql` record trusted session
links on graph entities and edges and keep incomplete provenance from being
upgraded by later writes. The promotion job carries each fact's database
session ID into graph and vector writes. Organization backup and restore now
preserve those links; a disposable two-session recovery check verifies that a
shared graph row remains shared. Historic graph rows and any untagged source
ingestion remain uncertain. These changes do not inventory deleted backups,
RAM or external copies, and do not authorize erasure of billing records.

## Rejected shortcut

Replacing the session ID in `billing_records` with a salted hash is impossible
under the existing trigger and signed payload. Even if it were possible, a
linkable hash would remain pseudonymous data and cannot be assumed erased.
