# Shadow provenance after memory persistence

**Scope:** `plan.md` §3c/§3d shadow evaluation. The commercial route starts typed-fact persistence and shadow observation after a completed response. The observer's active-fact and supersession lookups require those facts to have finished writing. This change affects diagnostics only; forwarding, billing, and pruning stay unchanged.

## REQ-1 — Preserve exchange order without delaying the response

WHEN a completed authenticated exchange starts both memory persistence and shadow observation, THE ROUTE SHALL enqueue its observation in conversation order with the result of that exchange's memory write. THE OBSERVER SHALL wait for each enqueued write to settle before selecting and querying prior exchanges. The client response SHALL NOT wait for this diagnostic or the memory write.

## REQ-2 — Mark incomplete provenance

WHEN an exchange's memory write fails, THE OBSERVER SHALL retain its hot turn but mark later metrics whose hot window contains that exchange as provenance-incomplete. It SHALL omit fact-coverage counts for those metrics rather than report a misleading zero. The incomplete state SHALL clear when the exchange leaves the bounded hot window. No user or assistant text, model output, or error detail SHALL enter the metric.

## Acceptance

- A focused route test delays the first memory write across two successful requests, is red before implementation, then proves responses finish and the second metric sees the persisted first exchange in order.
- A focused observer test proves a failed write marks later coverage unavailable while preserving turn history and count-only output.
- Streaming and non-streaming proxy tests, typecheck, and unchanged release gates pass. This does not activate pruning.
