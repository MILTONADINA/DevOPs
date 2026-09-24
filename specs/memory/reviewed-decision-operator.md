# Operator workflow for reviewed decision supersession

**Scope:** `plan.md` §3c/§4 and
`specs/memory/reviewed-decision-supersession.md` REQ-1. The database already
has a service-only immutable review RPC, but there is no local operator entry
point to inspect the exact pair and call it. This workflow creates reviewed
links only when an operator supplies concrete evidence; it does not infer a
replacement from model text or change pruning defaults.

## REQ-1 — Inspect the exact pair before a write

WHEN an operator supplies an organization UUID, an exact project slug or an
explicit unbound scope, and two distinct decision UUIDs, THE COMMAND SHALL
read only the two decisions in that binding. It SHALL display bounded current
decision text, timestamps, and link state for review. IF either decision is
missing, suppressed, out of scope, ordered incorrectly, or already linked,
THEN it SHALL exit nonzero without calling the write RPC. The default command
SHALL be a read-only preview.

## REQ-2 — Record only explicit reviewed evidence

WHEN `--apply` is supplied, THE COMMAND SHALL require a reviewer identity and
at least 20 characters of evidence read from standard input. It SHALL call
the existing service-only `review_tech_decision_supersession` RPC with exact
organization, scope, and pair IDs. It SHALL report only the linked IDs and
review time, not echo the evidence or credentials. IF the RPC rejects the
write, THEN the command SHALL exit nonzero. It SHALL NOT retry or infer a
different pair.

## REQ-3 — Local credential boundary

WHEN the command starts, IT SHALL accept only the project-local loopback
Supabase API origin and an explicitly supplied service key. It SHALL not load
secrets from files, accept a remote API origin, or emit the key. Input
validation SHALL run before a database client is created.

## Acceptance

- Focused tests prove validation and dry-run before any RPC, exact binding,
  explicit evidence, and fail-closed RPC behavior.
- A disposable local Compose fixture proves a reviewed pair is linked,
  immutable, and excluded from current SessionStart recall; fixture rows are
  removed afterward.
- Request forwarding, runtime pruning, and benchmark data remain unchanged.
