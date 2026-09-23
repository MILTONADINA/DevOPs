# ADR-0010: transformers.js for the ONNX Bi-Encoder

**Date:** 2026-05-28
**Status:** Accepted

## Context

`src/pruner/encoder.ts` needs the real text→embedding path: all-MiniLM-L6-v2,
INT8, L2-normalized 384-d vectors, run on ONNX Runtime client-side
(docs/ALGORITHM.md §ONNX Runtime; stratum CLAUDE.md "ONNX Runtime (Node.js)").
`onnxruntime-node` was already a dependency, but raw ONNX inference also needs
the matching **WordPiece tokenizer** (vocab + normalization + special tokens) —
which is not in the repo and is error-prone to hand-roll (a tokenizer mismatch
silently produces wrong embeddings that corrupt every pruning decision). The
model artifact itself is also not in the repo, and committing a ~23 MB binary is
undesirable (size/licensing).

## Decision

Implement `createOnnxEncoder` on top of **`@huggingface/transformers`**
(transformers.js v3). It runs the all-MiniLM ONNX export on ONNX Runtime (Node)
and ships the exact matching tokenizer, exposing a `feature-extraction` pipeline
with `{ pooling: "mean", normalize: true }` → a 384-d unit vector. The model is
**fetched on first use to a gitignored cache** (`models/`, default
`Xenova/all-MiniLM-L6-v2`, `dtype: "q8"` = INT8); nothing binary is committed.
Loading is **lazy** (first non-empty `encode()`), so constructing the encoder
and unit tests that inject embeddings never touch the network.

## Consequences

- Real, correct embeddings without vendoring a tokenizer or a model binary.
  Verified (`npm run verify-encoder`): 384-d, ‖v‖≈1.0000, semantically ordered
  (a paraphrase pair scores 0.696 vs. 0.006 for an unrelated pair).
- New dependency `@huggingface/transformers` (heavier; pulls its own ONNX Runtime
  bindings). `onnxruntime-node` remains for any future raw-inference path.
- The model downloads (~23 MB) on first use and is cached under gitignored
  `models/`. Offline/air-gapped runs must pre-populate that cache.
- The `OnnxEncoderOptions` shape changed from `{ modelPath }` (the old throwing
  stub) to `{ modelId?, cacheDir?, dtype? }`. The pruner orchestrator is
  unaffected — it consumes embeddings, not the encoder.
- Honors ADR-0009's "fail loud, never fake embeddings": the encoder either
  produces real vectors or surfaces the transformers.js error; it never returns
  placeholder data.

## Alternatives Considered

**Raw `onnxruntime-node` + a hand-rolled / vendored WordPiece tokenizer.**
Rejected: tokenizer correctness is the hard, high-risk part; a subtle mismatch
yields plausible-but-wrong embeddings. transformers.js ships the validated
tokenizer paired with the model.

**Commit the INT8 `.onnx` model to the repo (or Git LFS).** Rejected for now:
repo bloat + licensing. The gitignored on-demand fetch keeps the repo clean; a
future air-gapped/deployment story can vendor the model deliberately if needed.

**`@xenova/transformers` (the v2 package).** Superseded by
`@huggingface/transformers` (v3), the maintained line.
