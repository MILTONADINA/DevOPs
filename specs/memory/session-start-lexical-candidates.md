# Project-scoped lexical candidates for SessionStart

**Scope:** `plan.md` §4 long-horizon warm recall. Before vector promotion,
SessionStart embeds only the newest 200 active warm facts. A task that names
an older runbook, route, command, or identifier can miss its matching fact.
The published evidence-rank diagnostic in
`.workflow/proofs/published-evidence-rank-floor-2026-09-24.md` rules out a
small fixed cosine shortlist as a general answer.

## REQ-1 — Search old active typed facts within the bound project

WHEN a trusted SessionStart task is present and the local warm encoder is
available, THE BRIDGE SHALL request at most 20 lexical candidates across all
five typed fact tables from the exact bound organization and project. The
database SHALL exclude suppressed facts and explicitly superseded decisions,
rank matching fact text, and return typed rows without crossing scope. The
bridge SHALL reject malformed or out-of-scope rows before using them.

## REQ-2 — Rank with existing semantic evidence

WHEN lexical candidates are returned, THE BRIDGE SHALL deduplicate them with
the existing recent warm candidates, encode their typed text with the same
local model as the task and promoted vectors, and keep the existing maximum of
three relevant facts. The recent-fact output SHALL remain newest-first and
bounded to three. A lexical lookup failure SHALL leave existing recent/vector
recall usable. Request forwarding and pruning defaults SHALL remain unchanged.

## Acceptance criteria

- A focused test fails before implementation and passes after an older active
  fact beyond the newest 200 is retrieved through the bounded lexical seam.
- Focused tests prove foreign, suppressed, malformed, and duplicate rows do
  not enter the output, and lexical failure preserves the existing path.
- A rolled-back local PostgreSQL fixture verifies exact organization/project,
  suppression, explicit supersession, typed table coverage, and RPC grants.
- Typecheck and the existing SessionStart tests pass. This is a memory-recall
  improvement, not a Tier-C or judged Tier-A pruning result.
