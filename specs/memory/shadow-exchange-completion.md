# Trusted exchange completion in shadow selection

**Scope:** `plan.md` §3c/§4 and
`specs/evals/session-neighbor-retrieval.md#req-1`. Published LoCoMo has
no commercial exchange IDs; its even/odd turn pairing is only a surrogate.
The commercial proxy mints one exchange ID for each user/assistant pair.

## REQ-1 — Propose complete selected exchanges

WHEN shadow selection keeps any in-window turn with a server-minted exchange
ID, THE OBSERVER SHALL count the missing turns from that same exchange and
trusted conversation/project only. It SHALL report selected exchange count,
partially selected exchange count, added turn count, and proposed selected
turn count. It SHALL NOT add an unrelated, unbound, or unselected exchange.
WHEN all turns of a selected exchange are already kept, added turn count
SHALL be zero.

## REQ-2 — Preserve observation boundary

WHEN the proposal is emitted, IT SHALL contain counts only: no turn text,
exchange ID, or fact value. THE OBSERVER SHALL leave the base KadaneDial
decision, forwarded request, and pruning defaults unchanged. Tier-C,
per-question published evidence, full judged quality, and real-use gates
remain mandatory before any request-path change.

## Acceptance criteria

- A failing-first focused test shows one selected turn of a two-turn exchange
  proposes its missing partner, while a separate unselected exchange is not
  added.
- A fully selected exchange proposes zero extra turns; a turn lacking trusted
  exchange ID does not create a completion proposal.
- Typecheck and targeted lint/format pass. The LoCoMo pairing surrogate
  remains exploratory evidence only, not a release claim.
