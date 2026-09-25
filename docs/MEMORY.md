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
`audit_conflicts`; `npm --prefix stratum run audit:conflicts` lists the
unacknowledged ones. Acknowledging one (`-- --ack <id> --org-id <org-uuid>`)
takes it off that list; the fact stays suppressed.

## See also

- `memory/README.md` — backend overview
- `memory/file-based/` — starter files for file-based memory
  (`.workflow/memory/` in a project)
- `memory/stratum/` — structured facts
- `meta-memory/` — cross-project patterns (PII-scrubbed)
