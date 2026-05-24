# ALGORITHM.md — CQ-Extended KadaneDial Specification

## Background

This document specifies the CQ-Extended KadaneDial algorithm — the mathematical core of Startum's pruning engine.

The base DyCP algorithm and KadaneDial are described in:

> Choi, N. et al. *DYCP: Dynamic Context Pruning for Long-Form Dialogue with LLMs.* arXiv:2601.07994, January 2026.

CQ extends the base algorithm with a **temporal decay factor λ** that penalizes semantically relevant but temporally stale context. This extension is our proprietary contribution and is not present in the original paper.

---

## Base Algorithm (DyCP / KadaneDial)

### Setup

Given:
- A current user query `q_n`
- A dialogue history `H = [h_1, h_2, ..., h_{n-1}]` where each `h_k = [q_k; a_k]` (a concatenated question-answer pair)
- A bi-encoder `B` that maps text to a `d`-dimensional embedding vector

### Step 1 — Encode history

Encode each turn independently (this is done incrementally as turns arrive, not on-demand):

```
H_emb = [B(h_1), B(h_2), ..., B(h_{n-1})]  ∈ ℝ^{(n-1) × d}
```

Embeddings are computed once and stored. On each new turn, only the new turn is encoded. This is O(1) per turn, not O(n).

### Step 2 — Encode query

```
q_emb = B(q_n)  ∈ ℝ^{1 × d}
```

### Step 3 — Compute raw relevance scores

```
S_raw = H_emb · q_emb^T  ∈ ℝ^{(n-1) × 1}
```

This is a dot-product similarity (cosine similarity if embeddings are L2-normalized, which they should be).

### Step 4 — Z-score normalization

```
μ = mean(S_raw)
σ = std(S_raw)
S = (S_raw - μ) / σ
```

Z-score normalization ensures the gain threshold `g` operates on a standardized scale regardless of the absolute magnitude of relevance scores. This makes the algorithm stable across heterogeneous dialogue types.

### Step 5 — KadaneDial span selection (base)

KadaneDial is Kadane's maximum subarray algorithm adapted to allow multiple spans:

```
Parameters:
  g: float   # gain shift (threshold for a turn to contribute positively)
  θ: float   # minimum cumulative gain for a span to be included (default: 1.0)

Algorithm:
  spans = []
  current_start = None
  current_sum = 0
  max_sum = 0
  span_start = None

  for i in range(n-1):
    adjusted = S[i] - g

    if current_start is None and adjusted > 0:
      current_start = i
      current_sum = adjusted
    elif current_start is not None:
      current_sum += adjusted
      if current_sum > max_sum:
        max_sum = current_sum
        span_end = i
      if current_sum <= 0:
        if max_sum >= θ:
          spans.append((span_start, span_end))
        current_start = None
        current_sum = 0
        max_sum = 0

  # Don't forget the last open span
  if current_start is not None and max_sum >= θ:
    spans.append((span_start, span_end))

  return spans
```

The result is a list of `(start, end)` index pairs into `H` representing contiguous blocks of high relevance.

---

## CQ Extension — Temporal Decay Factor λ

### The Problem with Base KadaneDial

Base KadaneDial scores relevance only on semantic similarity. A turn from 8 months ago can score identically to a turn from 5 minutes ago if they're semantically similar to the query. For developer workloads where APIs deprecate, decisions reverse, and codebases evolve, this is dangerous. Stale-but-similar context is a hallucination vector.

### The CQ-Extended Score

We modify Step 4 to incorporate a temporal decay before z-score normalization:

```
R_i = S_raw_i × λ^((now_seconds - timestamp_i) / 3600)
```

Where:
- `S_raw_i` is the raw cosine similarity for turn `i`
- `λ` is the temporal decay factor (`0 < λ ≤ 1`, default: `0.97`)
- `now_seconds` is the current Unix timestamp in seconds
- `timestamp_i` is the Unix timestamp when turn `i` was recorded
- The exponent `(now_seconds - timestamp_i) / 3600` is elapsed time in hours

**Important:** The decay is applied to the raw scores `S_raw` before z-score normalization, not to the normalized scores `S`. This ensures normalization still operates correctly across the decayed distribution.

The full modified pipeline:

```
1. R_i = S_raw_i × λ^((now - timestamp_i) / 3600)   [decay applied]
2. μ = mean(R), σ = std(R)
3. S_normalized = (R - μ) / σ                         [z-score of decayed scores]
4. KadaneDial(S_normalized, g, θ)                     [span selection as before]
```

### Choosing λ

| λ value | Half-life | Behavior |
|---|---|---|
| 1.00 | ∞ (no decay) | Base DyCP — pure semantic similarity |
| 0.99 | ~69 hours | Gentle decay — suitable for week-scale projects |
| 0.97 | ~23 hours | Default — suitable for day-scale dev sessions |
| 0.90 | ~6.6 hours | Aggressive — suitable for fast-moving environments |
| 0.50 | ~1 hour | Very aggressive — context older than a few hours rarely surfaces |

λ is configurable per-organization. The default is `0.97`.

**Formula for half-life:** `half_life_hours = -1 / log2(λ)`

### Why hours, not turns?

Turn-count-based decay (`λ^(n-i)`) is broken for developer workloads. A 10-turn conversation can span 5 minutes or 5 days depending on context. Using elapsed time in hours makes the decay meaningful and consistent across session lengths.

---

## Parameter Reference

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `λ` (lambda) | float | 0.97 | (0, 1] | Temporal decay factor per hour |
| `g` | float | 0.0 | any | Gain shift (KadaneDial threshold) |
| `θ` | float | 1.0 | > 0 | Minimum cumulative gain for span inclusion |
| `model` | string | `all-MiniLM-L6-v2` | — | ONNX bi-encoder model |
| `embedding_dim` | int | 384 | — | Output dimension of the encoder |
| `normalize_embeddings` | bool | true | — | L2-normalize before dot product |

All parameters are stored per-organization in Supabase `org_config` and may be tuned by the customer. Changes trigger an automatic re-run of the org's eval suite.

---

## Implementation Notes

### ONNX Runtime

The bi-encoder runs client-side via ONNX Runtime (Node.js or browser). Key requirements:

- Model must be INT8 quantized for <10ms inference on CPU
- Tokenizer must match the model's vocabulary exactly
- Embeddings must be L2-normalized before storage
- New turn embeddings are computed immediately on receipt, stored in Tier 1

### Incremental Encoding

Do not re-encode the entire history on each turn. The embedding for each turn is computed once when the turn is received and stored in Tier 1 memory. On each new query, only the query is encoded fresh. The relevance scores are computed as a batch dot product against the stored history embeddings.

### Edge Cases

- **Empty history:** Return no spans. Do not crash.
- **Single turn:** Return that turn if its decayed similarity exceeds the gain threshold.
- **All negative scores after decay:** Return no spans. The query has no relevant history. This is correct behavior — inject nothing rather than inject stale noise.
- **σ = 0 (all identical scores):** Skip normalization, use raw decayed scores directly.

---

## Validation

Before shipping any change to the algorithm, run the eval suite:

```bash
npm run test:eval -- --suite kadanedial
```

The suite tests against three dialogue benchmarks (LoCoMo, MT-Bench+, SCM4LLMs) with the CQ-specific developer workload additions. Acceptable thresholds:

- Faithfulness score: > 0.90 (< 5% degradation from full-context baseline)
- Answer Relevancy: > 0.88
- Latency (ONNX encode + KadaneDial): < 15ms p99 on a MacBook M2

See `docs/EVAL_FRAMEWORK.md` for full methodology.
