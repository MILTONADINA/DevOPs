# waste-taxonomy.md — Token Waste Categories

> **Phase 0 deliverable — FILLED from real session data (2026-05-29).**
> Source corpus: **2 real Claude Code sessions, 2,091 API responses** from this
> DevOPs project, imported via `npm run import-sessions` and analyzed with
> `npm run analyze-waste`. Per-response token counts are exact (API-reported
> `message.usage`, incl. cache); **aggregates are de-duplicated by `message.id`**
> (Claude Code emits one logical response as several records — see *Correction*).
> PII was redacted FAIL-CLOSED on import. This is a **bootstrap corpus** — see
> *Limitations*; live-proxy capture (`npm run dev`) will refine the
> request-envelope categories.
>
> **Correction (2026-05-29, post adversarial review):** an earlier draft reported
> ~2.24 B context-tax tokens / 4,476 "turns" / ~600 K duplicate. That over-counted
> ~2–4×: the importer treated each of Claude Code's per-content-block `assistant`
> records (which repeat the same `message.id` + `usage`) as a separate turn. Fixed
> by de-duplicating on `message.id`. All figures below are post-fix.

---

## Corpus (deduped by message.id)

| Session | API responses | Reported input tok | Output tok |
|---|---:|---:|---:|
| `24585330…` | 2,005 | 124,499 | 2,740,218 |
| `b57252ce…` | 86 | 14,668 | 710,645 |
| **Total** | **2,091** | **139,167** | **3,450,863** |

"Reported input" = the non-cached new input the API billed at full rate. The
*true* per-response processed context (reported + `cache_read` + `cache_creation`)
is far larger — that gap is the context tax (#1).

---

## Observed Waste Categories (ranked by measured re-sent/redundant tokens)

### #1 — Context Tax (conversation-history resend)  — **DOMINANT**

**Measured:** ~**1.03 billion** re-sent tokens across the corpus
(`detectContextTax` = Σ per-response processed-input − peak single response).
Every turn re-sends the entire accumulated conversation; late in a long session
each response carries ~1 M tokens of context, re-processed on **every**
subsequent turn. The corpus confirms it is the #1 waste by a factor of
**~38,000×** over the next category.

**Cost nuance (important, honest):** almost all of that ~1.03 B is served via
Anthropic **prompt caching** (`cache_read`), billed at ~10% of base input. So the
naive-full-rate figure overstates cost — but at scale it is still the **dominant
cost driver** (≈ `1.03 B × $1.50/M ≈ $1.5 K` of cache-read across these 2
sessions, vs. ~$2 of full-rate new input and ~$259 of output; the dashboard's
`estimated_cost_usd ≈ $261` counts only reported-input + output, NOT cache_read).
It is exactly the volume the Phase-2 pruner removes — cutting it reduces
cache-read spend, cache-storage pressure, and the context the model attends over.

### #2 — Duplicate Large Content Blocks

**Measured:** ~**27 K** tokens; **15 large blocks (≥200 chars)** recur across
multiple turns beyond the natural single resend (e.g. a re-pasted stack trace /
file dump). (Pre-dedup this read ~600 K / 574 blocks — almost entirely the
duplicate-record artifact, now corrected.) High-value, low-risk pruning target:
exact-match dedup before any semantic pruning.

### #3–#5 — Not separately quantifiable from the bootstrap corpus (see Limitations)

System-prompt repetition, tool-definition repetition, tool-output echo,
stale-file persistence, and redundant reasoning traces are all **plausible and
expected**, and detectors for system/tool repetition exist (`src/proxy/waste.ts`).
But Claude Code **transcripts do not record the request envelope** (system /
tools / full per-turn message array) the way the live proxy does, so these can't
be measured from imported data — they'll be populated from **live-proxy capture**
(`npm run dev`).

---

## Summary Table

| Category | Measured re-sent tokens | Frequency | Priority | Source |
|---|---:|---|---|---|
| **Context tax (history resend)** | **~1.03 B** | every turn | **P0 — drives the pruner** | measured (deduped) |
| Duplicate large content blocks | ~27 K | 15 blocks | P1 — exact-match dedup | measured (deduped) |
| System-prompt repetition | — | (expected every turn) | P2 | needs live capture |
| Tool-definition repetition | — | (expected every turn) | P2 | needs live capture |
| Tool-output echo / stale files | — | (expected) | P3 | needs live capture + block analysis |
| Redundant reasoning traces | — | (expected) | P3 | needs live capture |

## #1 Waste Type

> **The single biggest source of token waste in Claude Code sessions is the
> CONTEXT TAX: the entire growing conversation history is re-sent and
> re-processed on every turn.** In this corpus it is ~1.03 B re-sent tokens
> (~38,000× the next category). Prompt caching softens the per-token cost but not
> the volume — which is precisely what the Phase-2 CQ-Extended KadaneDial pruner
> reduces by keeping only relevance-selected, temporally-weighted spans of history.
> The Tier-B eval (`npm run eval:tierb`) confirms the pruner cuts ~60% of context
> with 0% measured quality degradation on the dev set (published Tier-A benchmarks
> still required before shipping pruning into the request path).

---

## Limitations of this measurement

1. **Bootstrap provenance.** Counts come from imported Claude Code transcripts,
   not live-proxy capture. The request envelope (system / tools / full message
   array) is not in the transcript, so categories that need it (system/tool
   repetition, tool-output echo) are **not yet quantified**. Run `npm run dev`.
2. **Request side = preceding user input only.** The importer reconstructs each
   turn's request as the immediately-preceding user message; duplicate-content
   detection sees the user/tool-result side, not the assistant content (capture
   stores response *metadata* only).
3. **Context-tax volume is cache-heavy.** The ~1.03 B is overwhelmingly
   `cache_read`; read it as *volume the pruner can remove*, not full-rate tokens.
4. **n = 2 sessions.** Directionally decisive (the #1 ranking is unambiguous —
   ~38,000× margin), but widen the corpus (more sessions, varied task types)
   before tuning pruner *parameters* (λ / θ) against it.

---

## Implications for Phase 1 / Phase 2

The Phase-1 proxy already measures the top two (`src/proxy/waste.ts`:
`detectContextTax`, `detectDuplicateContent`). The ranking sets Phase-2 priorities:

1. **Context-tax reduction is the pruner's reason to exist** — KadaneDial keeps
   the relevant, temporally-recent spans and drops the stale bulk that makes up
   most of the ~1.03 B. Validate first against the eval suite (`<5%` Faithfulness
   degradation); Tier-B already passes on the dev set.
2. **Exact-match dedup of large repeated blocks** — a cheap, safe pre-pass
   (no semantics) that can run ahead of / alongside KadaneDial.
3. **Populate the request-envelope categories** (system/tool repetition,
   tool-output echo) from live capture before deciding on dedicated heuristics.
