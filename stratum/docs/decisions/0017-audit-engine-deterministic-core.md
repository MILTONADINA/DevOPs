# ADR-0017: v0.6.x Git-Attestation Audit Engine — Storage-Decoupled Deterministic Core, Built Ahead of Gate

**Date:** 2026-05-29
**Status:** Accepted (Tier-1 runs free + adversarially hardened; Tier-2/3 real runs + request-path activation are gated)

## Context

The audit engine (docs/AUDIT_ENGINE.md) stops CQ's memory from becoming a
hallucination amplifier: a stored-then-injected FALSE fact makes the AI worse. It
is a 3-tier escalation — Tier-1 Git-Attestation ($0, deterministic), Tier-2 Llama
spot-check (~$0.001), Tier-3 Opus (~$0.01, rare). It was four `// TODO (Phase 5)`
stubs.

This was built **ahead of the v0.6.x phase gate**, as preparatory shadow code wired
NOWHERE in the request path — the same explicit-direction pattern as the v0.4.x
pruner (built ahead of its Tier-A gate). The spec (AUDIT_ENGINE.md) predates ADR-0013
and assumes a Neo4j commit graph + Cypher queries; ADR-0013 moved Tier-3 to Supabase
(no Neo4j account), so the spec's storage model no longer holds.

## Decision

1. **Tier-1 deterministic core is DECOUPLED from storage.** `attestFact(fact,
   CodeChange[])` (git-attestation.ts) operates on an in-memory list of code changes,
   not a live graph/DB — so it is PURE and fully unit-testable with no I/O. The git
   indexer (git-indexer.ts) produces that `CodeChange[]` from real `git log -p` output;
   persisting the changes into the Supabase graph is a deferred slice. This replaces
   the spec's Cypher-query coupling with a storage-agnostic seam.
2. **Rename inference via the diff signature.** The indexer is declaration-line
   heuristic and does NOT infer symbol-level renames; a rename surfaces as
   delete-old + add-new, which `attestFact` treats as rename confirmation. (Documented
   indexer limits + residuals: PB-45.)
3. **Conflict persistence + orchestration** (audit-engine.ts): `auditFacts` attests a
   fact set; `persistConflicts` writes CONFLICTs to `audit_conflicts` (suppressed,
   trusted org/session FKs per ADR-0012). The full deterministic path composes
   `indexRepository → auditFacts → persistConflicts`, all FREE (no LLM).
4. **Tier-2/3 escalation logic built behind an injectable completion seam**
   (`AuditCompletion`, the same pattern as the eval judge in evals/harness/metrics.ts):
   prompt-building, response parsing, sampling, and the escalation decision are pure +
   fake-tested; the real Llama/Opus calls are GATED on an API key + the audit cost
   budget. Tier-2 keeps a deterministic ~10% sample (`shouldSpotCheck`, FNV hash —
   reproducible, not RNG).
5. **Security hardening (from a 21-agent adversarial review, 12 confirmed defects
   fixed):** drift CONFLICT only against a confirmed change (no fabricated
   suppression of valid-but-unindexed facts); **NUL-delimited records (`git log -z`)** —
   a *structural* record boundary (a NUL byte cannot appear in a commit message or a
   text patch), so no crafted commit/file content can forge a record (this replaced the
   earlier `\x1e/\x1f` separator heuristic + re-attach, and also removed the field
   separator a subject could spoof); `sanitizeForFence` (strip fence tokens + length-cap)
   on every untrusted prompt block to stop the verdict-control prompt-injection that
   would defeat the engine's purpose.
6. **Runnable surface.** `npm run audit:repo` (scripts/audit-repo.ts) runs the full
   deterministic path on a real repo: index → report changes, and with `--facts <json>`
   attest claims (CONFIRMED / UNVERIFIED / CONFLICT), with `--persist` recording
   CONFLICTs. FREE; live-verified against this repo (CONFIRMED facts carry real commit
   evidence). `npm run audit:conflicts` (scripts/audit-conflicts.ts) is the spec's
   **alert** half ("CONFLICT ⇒ suppress + alert"): list the unacknowledged
   `audit_conflicts` queue + `--ack` to clear one — live-verified end-to-end on Supabase
   (seed → list → ack → re-read). The Tier-2/3 escalation of the UNVERIFIED residue, and
   the dashboard UI banner, stay gated/deferred.

## Consequences

- The deterministic Tier-1 audit runs end-to-end FREE + is adversarially hardened;
  the higher tiers (and any request-path wiring) are gated on Anthropic credits.
- The indexer's heuristic has documented limits (declaration-line detection, no
  similarity-100% rename, C-quoted paths) tracked in PB-45. The structural
  record-separator fix (`git log -z`, NUL-delimited) is **done** (closes the
  record-forgery class that the prior `\x1e` heuristic only mitigated); the remaining
  PB-45 residuals (similarity-100% renames, C-quoted paths) are lower-severity parsing
  fidelity, not integrity.
- Activation as a memory-injection gate is a future step gated on the same Tier-A
  validation discipline as the pruner (do not suppress/inject in the request path
  until validated). Constitution unchanged.

## Alternatives Considered

- **Neo4j commit graph + Cypher (as AUDIT_ENGINE.md specs).** Rejected — no Neo4j
  account (ADR-0013); and coupling the deterministic core to a graph query would make
  it un-unit-testable. The storage-decoupled `CodeChange[]` core is the seam a Neo4j
  (or Supabase) indexer feeds.
- **Persist CodeChanges into the Supabase graph first, attest by querying it.**
  Deferred — the pure core needs no storage; the graph-write is a later slice and
  would not change the attestation logic.
- **LLM-only audit (skip Tier-1).** Rejected — Tier-1 is the $0 deterministic ground
  truth that catches the cheap cases before any paid model call (docs/AUDIT_ENGINE.md
  cost model); building it free, ahead of the gate, is exactly the high-leverage move.
- **Ship the stubs as-is / implement crypto-style placeholders.** Rejected — same
  reason crypto.ts stays a throwing stub: no fabricated behavior.
