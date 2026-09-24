# Trusted project provenance for usage billing

**Scope:** Commercial message usage is charged at the organization level, but
each append-only record references a usage session. Preserve the authenticated
project on that session so future financial audit and lawful erasure can tell
which project generated a record. Existing unbound buckets remain unbound;
invoices and financial APIs remain organization-wide.

## REQ-1 — Pass trusted project identity to the recorder

WHEN a successful commercial `/v1/messages` request records usage, THE SYSTEM
SHALL pass the authenticated API key's organization-qualified project ID to
the recorder for both normal and streaming responses. Headers, query values,
and request body fields SHALL NOT supply or override that identity. Unbound
keys SHALL pass no project identity. Billing shall remain off the response
path and shall not run for failed upstream responses.

## REQ-2 — One immutable bucket per project

WHEN the recorder receives a project-bound usage event, THE SYSTEM SHALL
validate that its organization-qualified ID contains the same organization
and a valid project slug before any database write. THE SYSTEM SHALL create a
usage session with that project slug. Same-day, same-model usage for different
projects and for the unbound scope SHALL use distinct sessions; requests in
the same scope SHALL converge on one session across processes. The database
SHALL enforce this uniqueness with NULL treated as one unbound scope and keep
the existing immutability of a session's project identity. A conflict re-read
SHALL filter by the exact project identity before assigning a billing record
to the winning session.

## Acceptance criteria

- **AC-1:** Red/green route tests prove normal and streaming usage events use
  only the authenticated key's project ID, including spoofed inputs.
- **AC-2:** Red/green recorder tests prove separate scoped buckets, same-scope
  reuse, fail-closed invalid IDs, and project-filtered conflict re-read.
- **AC-3:** A disposable local database check proves the new unique index
  accepts distinct projects and one unbound bucket, rejects same-scope
  duplicates, preserves a NULL unbound scope, and writes no billing rows.
