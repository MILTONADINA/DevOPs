# Memory

See `memory/README.md` for the full two-tier architecture (file-based +
Stratum; a third, Zep, was removed 2026-09-14 as unwired dead weight). This
doc covers usage patterns.

## Default behavior

Both backends can be active simultaneously. The agent picks based on
query shape:

- "What was the auth decision?" → file-based
- "Show audit trail for client X" → Stratum
- "What did the user say about retry policy 3 weeks ago?" → unsupported (no current backend)

## Memory poisoning defense

Stratum's git-attestation audit cross-references stated facts against git
history when it runs (`audit:repo` with `--persist`, or the proxy's memory
recorder when `CQ_AUDIT_REPO_ROOT` is set). A conflicting fact is suppressed,
so session-start recall no longer returns it, and the conflict is written to
`audit_conflicts`;
`npm --prefix runtime run audit:conflicts -- --org-id <uuid>` lists the
unacknowledged ones. Acknowledging one (`-- --ack <id> --org-id <org-uuid>`)
takes it off that list; the fact stays suppressed.

## Session erasure and copied memory

The C4-B candidate adds managed erasure for newly enrolled explicit sessions,
disabled by default. A fresh isolated local instance, an operator-bound source
manifest and restricted process/store configuration are prerequisites; ordinary
environment flags, service credentials, imports or restored data cannot grant
coverage. The existing operator stack remains ineligible.

Protected recall, audit, graph, usage/statistics and backup reads can create
untracked application copies. Their guards durably mark the organization's
coverage unknown before the protected read; a failed marker stops the read and
its fallbacks. Uncertainty remains for that organization and future sessions,
even after an export finishes. Metadata-only authentication and erasure
preflight do not themselves mark coverage unknown.

`POST /v1/sessions/:id/erasure` is distinct from the existing DELETE operation,
which only ends a session. The initial managed explicit-session class passed
authenticated HTTP verification on 2026-10-03, including private-data deletion,
shared/foreign-data survival, rollback and stable retry. The initial launcher
supports one controlled proxy/API proof run;
general managed onboarding and restart operations remain unproved. Historical
and conversation-session erasure, broader managed-copy support and the one-year
performance gate remain open. See the [local operations runbook](runbooks/LOCAL_STRATUM.md#limited-managed-erasure-candidate)
and [session erasure requirements](../specs/memory/session-erasure.md).

## See also

- `memory/README.md` — backend overview
- `memory/file-based/` — starter files for file-based memory
  (`.workflow/memory/` in a project)
- `memory/runtime/` — structured facts
- `meta-memory/` — cross-project patterns (PII-scrubbed)
