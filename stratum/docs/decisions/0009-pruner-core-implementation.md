# ADR-0009: v0.4.x Pruner Core — Implementation Decisions

**Date:** 2026-05-28
**Status:** Accepted

## Context

Phase 2 (`src/pruner/`) implements the CQ-Extended KadaneDial pruner specified
in `docs/ALGORITHM.md`. The core module file-set (kadanedial + encoder + pruner
+ crypto-stub) was built ahead of the phase gate at explicit direction, while
the model artifact, the §2b capture corpus, and the Tier-A eval datasets that
the accuracy eval depends on do not yet exist. Several implementation decisions
deviate from, or go beyond, the prose spec and need a record.

## Decision

**1. Fix two transcription bugs in the `docs/ALGORITHM.md` KadaneDial pseudocode.**
The spec's Step-5 pseudocode (a) appends `(span_start, span_end)` but never
assigns `span_start` (it is initialized to `None` and left untouched — every
emitted span would start at `None`), and (b) does not seed `max_sum`/`span_end`
when a span *opens* (only the `elif` continuation branch updates them), so a
span that opens and closes on a single element — or one still open at end of
input — carries `max_sum = 0` and an undefined `span_end`, and is silently
dropped or mis-bounded. `kadaneDialSpans()` fixes both: on open it sets
`currentStart = i`, `maxSum = adjusted`, `spanEnd = i`. The algorithm's intent
(emit every contiguous span whose peak cumulative gain reaches θ) is preserved;
only the bookkeeping is corrected. Documented inline in `kadanedial.ts` and
cross-referenced from `docs/ALGORITHM.md` (this ADR is the authority).

**2. Gate the single-turn edge case on `g`, not `θ`.** Spec §Edge Cases says
"single turn → return that turn if its decayed similarity exceeds the gain
threshold." With one turn, z-score normalization is undefined (σ = 0) and a span
needs cumulative gain ≥ θ ≥ a single element can express meaningfully, so
`selectRelevantTurns()` handles `length === 1` explicitly: select iff
`(decayed − g) > 0`. This matches the prose ("gain threshold" = `g`) rather than
forcing the single element through the θ span-gate.

**3. The pruner operates on stored embeddings, not text.** `pruner.ts`'s
`prune(queryEmbedding, history: HistoryEmbedding[], params)` consumes
already-encoded, L2-normalized embeddings (computed once per turn at ingestion,
per spec §Incremental Encoding) rather than calling the encoder itself. This
makes the orchestrator encoder-agnostic and fully unit-testable with injected
synthetic embeddings — no model artifact required to prove the
decay→normalize→Kadane→decision wiring is correct.

**4. `createOnnxEncoder()` fails loud; it never returns fake embeddings.** The
real text→embedding path is gated on `all-MiniLM-L6-v2-int8.onnx` + a matching
tokenizer, neither of which is in the repo. The factory throws a clear,
actionable error rather than returning zero/random vectors. Silent fake
embeddings would corrupt every downstream pruning decision while looking
healthy — the worse failure mode. The pure similarity math (`l2Normalize`,
`cosineSimilarity`) is implemented and unit-tested independently of the model.

**5. `crypto.ts` is a typed interface stub that rejects.** The Phase-4
client-side AES-256-GCM encryption (`deriveSessionKey`, `encryptSpans`) is a
forward-declaration so the pruner has stable hook-points; both functions reject
with "Phase 4, not implemented." No placeholder crypto is shipped. Real
implementation is gated on the v0.7.x TEE work and requires its own ADR +
security review (see `docs/SECURITY.md`).

**6. The pruner is shadow-mode: implemented, wired nowhere.** Pruning is not
invoked from the proxy request path and is enabled in no code path. Per the
stratum constitution ("the eval suite is the definition of correct") it stays
that way until the eval suite runs and shows <5% Faithfulness degradation —
which is blocked on the §2b corpus + the Tier-A datasets.

## Consequences

- The implementation is provably correct on synthetic, hand-computed inputs
  (27 unit tests across kadanedial / encoder / pruner / crypto), but its
  *quality-preservation* is **unproven** until the accuracy eval runs. The
  shadow-mode posture makes that explicit rather than implied.
- `docs/ALGORITHM.md`'s pseudocode and the shipped code now differ by the two
  fixes above. The code is authoritative for the bookkeeping; the spec remains
  authoritative for the math. A future doc pass may fold the fixes back into the
  pseudocode and cite this ADR.
- Anyone wiring real embeddings must supply the ONNX model + tokenizer and
  implement `createOnnxEncoder`; the throw is the contract boundary.
- Enabling pruning anywhere before the eval gate passes would violate this ADR
  and the constitution.

## Alternatives Considered

**Implement `createOnnxEncoder` against a downloaded model now.** Rejected: the
model artifact is not in the repo and pinning/licensing/quantization-verification
is its own task; a stubbed encoder that throws is honest and unblocks the
fully-testable orchestrator immediately.

**Defer the whole pruner until the corpus exists.** Rejected at explicit
direction to build ahead of the gate — but bounded to the parts whose
correctness is verifiable without external inputs (algorithm, math, wiring),
with the un-verifiable parts (real embeddings, eval) clearly gated.

**"Correct" the spec pseudocode in `ALGORITHM.md` instead of in code.** Deferred:
the spec is a published artifact referenced by other docs; changing it is a
separate documentation decision. The code fix is needed now and is recorded here.
