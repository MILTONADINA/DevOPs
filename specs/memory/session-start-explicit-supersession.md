# Explicit decision supersession in SessionStart recall

**Scope:** `plan.md` §3c/§3e quality and §4 memory recall. The bounded
SessionStart bridge can currently emit a stale TechDecision beside its newer
replacement. The database already has a server-controlled `supersedes_id` FK;
no automatic cross-fact decision resolution is assumed.

## REQ-1 — Omit an explicitly superseded decision

WHEN active TechDecision B in the exact bound organization/project has a
server-recorded `supersedes_id` referencing active TechDecision A in that same
bounded candidate set, and B was created later than A, THE BRIDGE SHALL omit A
from both recent and relevant output. It SHALL refill recent output from the
remaining bounded candidates up to its existing limit. A self-reference,
equal/older B, suppressed B, foreign-project B, or absent B SHALL NOT suppress
A. The bridge SHALL NOT infer supersession from shared domains, lexical
similarity, or model output.

## REQ-2 — Comparable warm/vector ranking

WHEN warm facts are encoded for SessionStart ranking, THE BRIDGE SHALL use the
same typed-fact text representation used by vector promotion, so cosine
similarities from both sources can be compared. It SHALL preserve the exact
project and active-fact filters, bounded output, and fail-open source fallback
of the current bridge. Request forwarding and pruning defaults SHALL remain
unchanged.

## Acceptance criteria

- Focused tests are red before implementation for stale recent and relevant
  output, then green for an explicit newer link and conservative exclusions.
- Focused tests prove warm encoding receives the promoted-vector text form.
- A disposable project-local Compose fixture verifies the explicit link and
  exact-project behavior, then cleans up all rows.
