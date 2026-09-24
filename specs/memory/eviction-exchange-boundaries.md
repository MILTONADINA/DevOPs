# Keep exchange boundaries during hot-memory eviction

**Scope:** `plan.md` §4 fact survival. A hot-memory sweep can evict several
unrelated turns at once. Passing the whole sweep to one model call can cause
durable facts in older turns to be omitted; the 2026-09-24 local Qwen
diagnostic observed this on route, command, and port facts.

## REQ-1 — Bound extraction to one exchange

WHEN a hot-memory sweep evicts turns, THE MEMORY MANAGER SHALL extract adjacent
turns carrying the same trusted exchange ID together and SHALL NOT include a
turn from another exchange in that extraction call. An evicted turn without an
exchange ID SHALL be extracted on its own. The manager SHALL preserve the
evicted turn order and session binding, and SHALL pass no raw exchange ID to
the model. It SHALL NOT infer exchange identity from text or role alone.

## REQ-2 — Preserve lossless retry

WHEN extraction of any bounded group fails, THE MANAGER SHALL retain the full
unpersisted evicted batch for retry. WHEN persistence fails after extraction,
THE MANAGER SHALL retry the same extracted fact IDs without re-extracting.
Successful groups SHALL be persisted together only after every group has been
extracted. No request-forwarding or pruning behavior SHALL change.

## Acceptance criteria

- A red-before-green focused test proves one two-turn exchange stays together
  while two unbound turns receive separate extractor calls in one sweep.
- Focused retry tests prove an extraction failure loses no later group and a
  persist failure retains original fact IDs.
- The existing 50-turn fact-survival test remains green; typecheck passes.
