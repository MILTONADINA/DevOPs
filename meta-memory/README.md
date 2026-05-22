# Meta-memory (cross-project patterns)

The DevOPs workflow learns across projects. This directory stores
PII-scrubbed patterns that cross client boundaries.

## What lives here

### `personal-preferences.yml`
Per-user preferences inferred from many projects. Things like:
- "User prefers Sonnet for code review"
- "User asks for tests before implementation"
- "User wants tight diffs, no drive-by refactors"

These are HINTS, not commands. The constitution still overrides.

### `patterns/`
Reusable patterns discovered across projects:
- Auth patterns (the user's preferred auth library, OAuth flow choices)
- Database patterns (the user's preferred migration tool, ORM)
- Deploy patterns (the user's preferred provider)

### `starters/`
Starter stacks the analyzer can offer:
- Next.js + Supabase + Stripe
- Rust + Axum + Postgres
- Python + FastAPI + Polars

### `recommendations-history.jsonl`
Append-only log of the analyzer's recommendations and whether they were
accepted. Lets the analyzer improve over time.

### `skill-telemetry.jsonl`
How each skill performed: invocation count, success rate, user-flagged issues.
Feeds the self-improvement loop in Phase 6.

## PII scrubbing requirement

Nothing in this directory should contain client-identifying information,
secrets, or specific code from any project. Patterns must be abstracted.

The `scripts/scrub-meta-memory.sh` runs nightly to validate.
