# Project-bound warm fact relevance at session start

**Scope:** `plan.md` §3c and §3e, §4 memory recall. The local SessionStart
bridge currently returns three recent facts and up to three promoted vector
hits; facts not yet promoted and older than the recent three are missed.

## REQ-1 — Rank active warm facts in the bound project

WHEN a trusted SessionStart task is present and the local encoder is available,
THE BRIDGE SHALL rank a bounded set of active typed warm facts from the exact
authenticated organization and project by semantic relevance to the task,
including facts not promoted to vectors. It SHALL encode only fact content
fields, never identifiers, credentials, or system metadata. It SHALL combine
warm and existing promoted vector matches by comparable similarity, deduplicate
fact IDs, and emit at most three bounded typed facts. A failed warm ranking
SHALL leave usable vector matches available, and a failed vector search SHALL
leave usable warm matches available with an explicit partial status.

## REQ-2 — Preserve scope and default request behavior

WHEN the project binding is absent or invalid, THE BRIDGE SHALL retain its
existing fail-closed binding behavior. WHEN a project binding is valid, warm
and vector reads SHALL both enforce that exact project; null SHALL mean only
legacy unbound facts. Suppressed and foreign facts SHALL never appear. The
bridge output SHALL remain explicitly untrusted data. This recall SHALL NOT
change proxy forwarding or enable request pruning.

## Acceptance criteria

- A focused red-before-green test retrieves two older, independently relevant
  warm facts beyond the recent three without promoted vectors, excluding
  another project and suppressed facts.
- Focused tests cover warm/vector merge, deduplication, bounded output, and
  one-source failure while preserving the other source.
- A disposable project-local Compose fixture verifies the bridge emits an
  older active warm fact under the correct project and cleans up its rows.
