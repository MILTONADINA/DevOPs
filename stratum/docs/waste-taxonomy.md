# waste-taxonomy.md — Token Waste Categories

> **Phase 0 deliverable — FILLED from real session data (2026-05-28).**
> Source corpus: **2 real Claude Code sessions, 4,476 turns** from this DevOPs
> project, imported via `npm run import-sessions` (Claude Code transcripts →
> capture artifacts) and analyzed with `npm run analyze-waste`. Token counts are
> **exact** (API-reported `message.usage`, incl. cache). PII was redacted
> FAIL-CLOSED on import. This is a **bootstrap corpus** — see *Limitations* for
> what it can and cannot measure; live-proxy capture (`npm run dev`) will refine
> the request-envelope categories.

---

## Corpus

| Session | Turns | Reported input tok | Output tok | Cumulative input incl. cache | Peak single-turn input |
|---|---:|---:|---:|---:|---:|
| `24585330…` | 4,119 | 315,612 | 8,634,363 | ~2,062,880,363 | ~999,688 |
| `b57252ce…` | 357 | 30,936 | 3,685,412 | (folded into total) | — |
| **Total** | **4,476** | **346,548** | **12,319,775** | **~2.06 B** | — |

"Reported input" = the non-cached new input the API billed at full rate.
"Cumulative input incl. cache" = Σ per-turn `input_tokens + cache_read +
cache_creation` — the true volume of context the model processed across the
session. The gap between them is the story (see #1).

---

## Observed Waste Categories (ranked by measured re-sent/redundant tokens)

### #1 — Context Tax (conversation-history resend)  — **DOMINANT**

**Measured:** ~**2.24 billion** re-sent tokens across the corpus; ~**2.06 billion
in the 4,119-turn session alone** (cumulative processed input 2.06 B vs. a peak
single-turn context of ~999,688 → ~2.06 B is re-processing the growing history).

Every turn re-sends the entire accumulated conversation. By late in a long
session each turn carries ~1 M tokens of context, and that ~1 M is re-processed
on **every** subsequent turn. This is the structural cost the whole product
targets — and the corpus confirms it is the #1 waste by a factor of **~3,700×**
over the next category.

**Cost nuance (important, honest):** almost all of that 2.06 B is served via
Anthropic **prompt caching** (`cache_read`), billed at ~10% of base input — so
the *cost* is far below a naive `2.06 B × full-rate` figure. But at scale it is
still the **dominant cost driver** (≈ `2.06 B × $1.50/M ≈ $3 K` of cache-read on
this one session, vs. ~$5 of full-rate new input and ~$0.9 K of output), and it
is exactly the volume the Phase-2 pruner removes — cutting it reduces cache-read
spend *and* cache-storage pressure, and shrinks the context the model must
attend over.

### #2 — Duplicate Large Content Blocks

**Measured:** ~**600 K** tokens; **574 large blocks (≥200 chars)** recur across
multiple turns beyond the natural single resend (e.g. a big paste / file dump /
tool result echoed many times).

This is a subset of the context tax with a sharper signature: identical large
payloads repeated verbatim — high-value, low-risk pruning targets (exact-match
dedup before any semantic pruning).

### #3–#5 — Not separately quantifiable from the bootstrap corpus (see Limitations)

System-prompt repetition, tool-definition repetition, tool-output echo,
stale-file persistence, and redundant reasoning traces are all **plausible and
expected**, and detectors for system/tool repetition already exist
(`src/proxy/waste.ts`). But Claude Code **transcripts do not record the request
envelope** (system / tools / full per-turn message array) the way the live proxy
sees it, so these cannot be measured from imported data. They will be populated
from **live-proxy capture** (`npm run dev`), where the proxy sees the actual
`system` + `tools` + `messages` of each request.

---

## Summary Table

| Category | Measured re-sent tokens | Frequency | Priority | Source |
|---|---:|---|---|---|
| **Context tax (history resend)** | **~2.24 B** | every turn | **P0 — drives the pruner** | measured |
| Duplicate large content blocks | ~600 K | 574 blocks | P1 — exact-match dedup | measured |
| System-prompt repetition | — | (expected every turn) | P2 | needs live capture |
| Tool-definition repetition | — | (expected every turn) | P2 | needs live capture |
| Tool-output echo / stale files | — | (expected) | P3 | needs live capture + block analysis |
| Redundant reasoning traces | — | (expected) | P3 | needs live capture |

## #1 Waste Type

> **The single biggest source of token waste in Claude Code sessions is the
> CONTEXT TAX: the entire growing conversation history is re-sent and
> re-processed on every turn.** In this corpus it accounts for ~2.24 B re-sent
> tokens (~3,700× the next category). Prompt caching softens the per-token cost
> but does not remove the volume — which is precisely what the Phase-2
> CQ-Extended KadaneDial pruner reduces by keeping only relevance-selected,
> temporally-weighted spans of history.

---

## Limitations of this measurement

1. **Bootstrap provenance.** Counts come from imported Claude Code transcripts,
   not live-proxy capture. Token counts are exact (API-reported), but the
   *request envelope* (system / tools / full message array) is not in the
   transcript, so categories that need it (system/tool repetition, tool-output
   echo, stale-file persistence) are **not yet quantified**. Run `npm run dev`
   through real sessions to populate them.
2. **Request side = preceding user input only.** The importer reconstructs each
   turn's request as the immediately-preceding user message (the new input);
   duplicate-content detection therefore sees the user/tool-result side, not the
   assistant content (capture deliberately stores response *metadata* only).
3. **Context-tax volume is cache-heavy.** The 2.06 B is overwhelmingly
   `cache_read`; interpret it as *volume the pruner can remove*, not as
   full-rate billed tokens.
4. **n = 2 sessions.** Directionally decisive (the #1 ranking is unambiguous),
   but widen the corpus (more sessions, varied task types — quick fixes vs. long
   features) before tuning pruner *parameters* (λ / θ) against it.

---

## Implications for Phase 1 / Phase 2

The Phase-1 proxy already measures the top two (`src/proxy/waste.ts`:
`detectContextTax`, `detectDuplicateContent`). The empirical ranking sets the
Phase-2 pruner priorities:

1. **Context-tax reduction is the pruner's reason to exist** — KadaneDial selects
   the relevant, temporally-recent spans of history and drops the stale bulk that
   makes up most of the 2.06 B. This is the heuristic to validate first against
   the eval suite (`<5%` Faithfulness degradation).
2. **Exact-match dedup of large repeated blocks** is a cheap, safe pre-pass
   (no semantics needed) that can run ahead of / alongside KadaneDial.
3. **Populate the request-envelope categories** (system/tool repetition,
   tool-output echo) from live capture before deciding whether they warrant
   dedicated heuristics beyond the history pruner.
