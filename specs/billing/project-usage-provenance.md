# Trusted project provenance for usage

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` C2: REQ-4/5 remove signatures and fees while retaining trusted project scope and usage-session identity. Payment HTTP routes were removed in C1.

**Scope:** Team message usage is recorded at organization scope and references
a usage session. Preserve the authenticated project on that session so usage
inspection and session inventory can identify its source. Existing unbound
buckets remain unbound. The retained usage read API is organization-wide and
denies project-bound keys.

## REQ-1 — Pass trusted project identity to the recorder

WHEN a successful commercial `/v1/messages` request records usage, THE SYSTEM
SHALL pass the authenticated API key's organization-qualified project ID to
the recorder for both normal and streaming responses. Headers, query values,
and request body fields SHALL NOT supply or override that identity. Unbound
keys SHALL pass no project identity. Database replay SHALL remain off the
response path after durable journaling; failed upstream responses SHALL NOT
produce usage events.

## REQ-2 — One immutable bucket per project

WHEN the recorder receives a project-bound usage event, THE SYSTEM SHALL
validate that its organization-qualified ID contains the same organization
and a valid project slug before any database write. THE SYSTEM SHALL create a
usage session with that project slug. Same-day, same-model usage for different
projects and for the unbound scope SHALL use distinct sessions; requests in
the same scope SHALL converge on one session across processes. The database
SHALL enforce this uniqueness with NULL treated as one unbound scope and keep
the existing immutability of a session's project identity. A conflict re-read
SHALL filter by the exact project identity before assigning a usage record
to the winning session.

## Acceptance criteria

- **AC-1:** Red/green route tests prove normal and streaming usage events use
  only the authenticated key's project ID, including spoofed inputs.
- **AC-2:** Red/green recorder tests prove separate scoped buckets, same-scope
  reuse, fail-closed invalid IDs, and project-filtered conflict re-read.
- **AC-3:** A disposable local database check proves the new unique index
  accepts distinct projects and one unbound bucket, rejects same-scope
  duplicates, preserves a NULL unbound scope, and writes no billing rows.
