# Memory

See `memory/README.md` for the full three-tier architecture (file-based +
Stratum + Zep). This doc covers usage patterns.

## Default behavior

All three backends can be active simultaneously. The agent picks based on
query shape:

- "What was the auth decision?" → file-based
- "Show audit trail for client X" → Stratum
- "What did the user say about retry policy 3 weeks ago?" → Zep

## Memory poisoning defense

Stratum's git-attestation cross-references stated facts against git history.
Conflicts go to `audit_conflicts` and surface on next session-start.

## See also

- `memory/README.md` — backend overview
- `memory/file-based/` — durable markdown
- `memory/stratum/` — structured facts
- `memory/zep/` — semantic temporal
- `meta-memory/` — cross-project patterns (PII-scrubbed)
