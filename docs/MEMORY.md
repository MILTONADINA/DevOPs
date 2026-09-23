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

Stratum's git-attestation cross-references stated facts against git history.
Conflicts go to `audit_conflicts` and surface on next session-start.

## See also

- `memory/README.md` — backend overview
- `memory/file-based/` — durable markdown
- `memory/stratum/` — structured facts
- `meta-memory/` — cross-project patterns (PII-scrubbed)
