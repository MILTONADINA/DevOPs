# Provenance-gated exchange selection

**Scope:** the `plan.md` §3c/§3e v0.4 pruning candidate. This spec adds a
default-off, shadow-only overlay that changes the unchanged KadaneDial
decision only through trusted provenance recorded for earlier exchanges:
reviewed TechDecision supersession, deterministic git audit status, server-minted
exchange identity and memory-write settlement. It is meant to fix three things:
losing a dormant fact that is still current, losing evidence split across
far-apart turns, and keeping a stale fact that a reviewed link marks obsolete.
It does not change `lambda`, `theta`, `gainShift`, fixed ranks or any
threshold. It does not read turn text to judge currentness. It does not
activate pruning in requests, and it does not run a judged or paid evaluation.

Relevance and currentness come from separate signals. Relevance comes from the
unchanged cosine/KadaneDial base and from the existing lexical
query-to-typed-fact match (`find_query_hot_fact_exchanges`, migration
`20260924235800`). Currentness comes only from reviewed links, git `CONFLICT`,
and exact identity-key contests. When two facts contest a key
and nothing trusted breaks the tie, the base decision (decay) keeps deciding,
exactly as it does today.

**Live-window caveat.** The live pruner input is the Tier-1 hot window
(`src/memory/hot/tier1.ts:55`, 2 h default; the observer also resets after 2 h
idle or 128 turns, `src/proxy/shadow-observer.ts:78-79`). Within 2 h,
λ=0.97/h decays a score by at most 6%. The 80–170 h dormant ages in Tier-C
therefore cannot occur in the live pruner. Recalling dormant facts older than
the hot window is a Tier-2 recall problem and is outside this spec. Offline
evaluations with long ages are labelled as such.

**Decision record:** ADR-0023 (new,
`stratum/docs/decisions/0023-provenance-gated-exchange-selection.md`, status
Proposed).

## Definitions

- **Window**: the in-scope history candidates after the existing REQ-4 scope
  filter in `prune()` (`specs/evals/offline-tierc-gate.md` REQ-4).
- **Exchange**: the in-window turns that share one server-minted `exchangeId`
  (`src/proxy/routes/messages.ts:377,480`; `HotTurn.exchangeId`,
  `src/memory/hot/tier1.ts:27-28`). A turn with no `exchangeId` is **unbound**.
- **Exchange time** `ts(x)`: the maximum server `timestamp` of x's turns. Fact
  `created_at` is extraction time and is never used for ordering.
- **Fact row**: one typed fact from any of the six tables that belongs to a
  requested exchange. It carries `exchangeId, factTable, factId, keyHashes[],
  active (not is_suppressed), reviewedObsolete, successorExchangeId,
  auditStatus, queryMatch`.
- **DEAD**: `reviewedObsolete` (a TechDecision with a reviewed, unsuppressed,
  later successor; the same `NOT EXISTS` predicate as migrations
  `20260924235700:18-26` and `20260924235800:35-41`), or `auditStatus =
  'CONFLICT'`.
- **LIVE**: active and not DEAD. **INERT**: suppressed without `CONFLICT` (a
  manual suppression is not evidence either way).
- **KEYED**: LIVE with at least one identity-key hash. The identity keys are
  FunctionChange `old_name` and `new_name`, VariableChange `var_name`,
  PolicyUpdate `policy_name`, OperationalReference `subject`, and TechDecision
  `domain`, with TechDecision contests query-dependent under REQ-6. Todo has no
  key.
- **Key hash**: `md5(lower(btrim(field)))`, computed in SQL so no fact text
  leaves the database. Matching is exact; there is no fuzzy or semantic matching.

## REQ-1 — Base preservation

THE SYSTEM SHALL compute the base decision with the unchanged `prune()` and
`DEFAULT_KADANEDIAL` (λ=0.97 per hour, gainShift 0, θ=1) before any
provenance step. WHEN no provenance snapshot is supplied, or no window turn
carries an `exchangeId`, THE SYSTEM SHALL return a decision deep-equal to
`prune()` on the same inputs: spans, selected, pruned and candidate indices,
decayed and normalized scores, and params. `kadanedial.ts`, `pruner.ts`
and `context-manager.ts` SHALL NOT change.

## REQ-2 — Fail closed

IF any in-window exchange has a failed memory write, the provenance lookup
rejects or times out, a row names an exchange outside the requested set or a
foreign organization, session or project, a `factId` repeats, or a row is
malformed, THEN THE SYSTEM SHALL return the base decision exactly. It SHALL
record exactly one reason code: `NO_SNAPSHOT`, `NO_EXCHANGE_IDS`,
`WRITE_FAILED`, `LOOKUP_ERROR`, `LOOKUP_INVALID` or `ADAPTER_BOUND`.

The pure selection function SHALL impose no exchange-count bound. The 1–128
bound belongs to the RPC and its TypeScript adapter, which SHALL fail closed
with `ADAPTER_BOUND` above 128. Offline harnesses inject snapshots directly and
SHALL NOT pass through that bound.

## REQ-3 — Unbound turns

WHILE a turn has no trusted `exchangeId`, THE SYSTEM SHALL NOT rescue, exclude
or complete it, and SHALL keep the base decision for it.

## REQ-4 — Scope first

THE SYSTEM SHALL apply the trusted query-scope filter before any provenance
step. It SHALL request provenance only for the exact organization,
conversation session and project. A fact from another conversation or
project SHALL NOT rescue, contest, exclude or receive a successor transfer.

## REQ-5 — Fact classification

THE SYSTEM SHALL classify every fact row as DEAD, LIVE (and KEYED when it has a
key) or INERT, as defined above. Unreviewed model-extracted content
(FunctionChange rename pairs, Tier-3 `SUPERSEDES` edges, `is_verified`) SHALL
NOT mark a fact DEAD.

## REQ-6 — Contest

WHEN two KEYED facts in different exchanges come from the same fact table and
share a key hash, THE SYSTEM SHALL treat both as contested. For TechDecision,
the shared `domain` hash contests only when both facts have `queryMatch = true`,
so decisions in the same domain that are not about this query do not block
each other.

A contested fact stays CONTESTED: THE SYSTEM SHALL NOT resolve a contest, and
SHALL NOT use exchange recency, fact `created_at`, turn text, embedding
similarity or git audit status to do so. (A git `CONFIRMED` status means a
commit touched the symbol, not that the fact is current; see Decisions.) Two facts in the same exchange SHALL NOT contest each
other.

## REQ-7 — Reviewed or attested exclusion

WHEN every fact row of an in-window exchange (at least one row) is DEAD, THE
SYSTEM SHALL remove all of that exchange's turns from the selection, including
turns the base span carried. IF an exchange holds any LIVE or INERT fact, or no
fact at all, THEN THE SYSTEM SHALL NOT exclude it. This spec authorizes dropping
a turn only on reviewed-supersession or git-`CONFLICT` content. It narrows,
and does not contradict, `specs/pruner/fresh-exchange-supersession.md` REQ-2:
an unreviewed candidate count still authorizes no drop.

## REQ-8 — Successor transfer

WHEN an excluded exchange was base-selected or holds a DEAD fact with
`queryMatch = true`, THE SYSTEM SHALL follow `successorExchangeId` from its
reviewed-obsolete facts. It SHALL use a visited set and make at most one hop
per in-window exchange, stopping at the first exchange s that is in the
window, not excluded, and has no failed write. It SHALL add all of s's turns.
IF no such exchange exists (for example the successor is in another
conversation or has left the window), THEN THE SYSTEM SHALL keep the exclusion
and count `droppedWithoutSuccessor`.

## REQ-9 — Query-dependent rescue

WHEN an in-window exchange that the base did not fully select meets all of
these conditions, THE SYSTEM SHALL add all of its turns:
- it holds no DEAD fact;
- at least one of its KEYED facts has `queryMatch = true`;
- every one of its KEYED facts is uncontested.

Rescue SHALL be set-based: THE SYSTEM SHALL NOT add a turn only because it lies
between two selected exchanges. A Todo or INERT fact SHALL NOT make an exchange
eligible. Rescue SHALL NOT read decayed or normalized scores.

## REQ-10 — Exchange completion

WHEN any turn of a trusted exchange is in the merged selection, THE SYSTEM
SHALL include every in-window turn of that exchange, unless the exchange is
excluded under REQ-7.

## REQ-11 — Output and decision log

THE SYSTEM SHALL return the selected indices in ascending order, mapped to the
original history. Pruned indices SHALL be the complement. Spans SHALL be
recomputed as maximal runs of consecutive indices, as `pruner.ts` already
does for scoped results. Decayed and normalized scores SHALL be passed through
from the base. A `provenance` record SHALL carry:
`applied`, `reason`, `baseSelectedIndices`, `rescuedExchangeCount`,
`rescuedTurnCount`, `excludedExchangeCount`, `excludedTurnCount`,
`successorAddedCount`, `droppedWithoutSuccessor`, `completedTurnCount`,
`contestedFactCount`, and the λ/g/θ used.

## REQ-12 — Provenance lookup RPC

WHEN a service caller supplies an organization, a conversation session, a
project scope, 1 to 128 exchange IDs and a search text, THE DATABASE
function `find_hot_exchange_provenance` SHALL return one row per typed fact of
those exchanges, including suppressed facts, with these columns:
- exchange ID, fact table and fact ID;
- the identity-key MD5 hashes;
- `active`;
- `reviewedObsolete`, by the predicate above;
- `successorExchangeId`, only when the successor is in the same session;
- the audit status, by `LEFT JOIN audit_statuses` (null for
  `operational_references`, which that table's CHECK excludes);
- `queryMatch`, computed with the tokenizer and fact documents of
  `20260924235800:9-72`, copied verbatim.

It SHALL return no rows unless the session is a `conversation` in that
organization and project. It SHALL be executable only by `service_role`, and it
SHALL NOT return fact text. Existing RPCs and migrations SHALL NOT change.

## REQ-13 — Shadow observation boundary

WHILE the `provenanceSelection` option of `createShadowObserver` is set (it
defaults to off), THE OBSERVER SHALL compute the candidate next to the base
decision, using its existing `failedExchanges` set as the settlement signal and
calling the lookup only while `incompleteExchangeCount === 0`. It SHALL emit a
`provenanceSelection` metric made of the REQ-11 counts and reason code only,
with no fact text, key, hash or fact ID. The forwarded request, the base
decision and every existing metric SHALL be byte-identical with the option on
or off. Pruning SHALL remain disabled in requests, and no `prune_enabled` flag
SHALL be added.

## REQ-14 — Tier-C no-regression

(ADR-0023: the pruner's architectural input is the 2 h hot window, so this
candidate cannot move Tier-C's long-history cases. Zero Tier-C failures stays a
gate, but for request-path pruning of history longer than the hot window.)

WHEN the 50 unchanged Tier-C cases (`stratum/evals/datasets/golden/tier-c.jsonl`)
are run through the candidate path, THE RESULT SHALL be a selection identical to
the base for all 50 cases. That means exactly 29/50 with the 21 failed IDs
recorded today: 10 `tc-dormant-*`, 5 `tc-repo-*`, 5 `tc-multi-*` and
`tc-negation-runtime`. At minimum, none of today's 29 passing cases may fail.
`npm run eval:tierc`, `evals/harness/tierc.ts`, `runner.ts` and the corpus
SHALL NOT change. The identity check SHALL run through a separate script.

## REQ-15 — Separately authored provenance fixture

WHEN `npm run eval:provenance` runs, THE HARNESS SHALL load
`stratum/evals/datasets/provenance/pges-fixture.dev.jsonl` and, only at gate
G1, `pges-fixture.sealed.jsonl`. It SHALL verify both files against their
committed SHA-256 files and run three layers:
- (a) injected similarities and lookups;
- (b) the real cached MiniLM encoder with a database-free in-memory adapter
  that reads declared `matchesQuery` and key-hash values;
- (c) a separate local Compose check that the real RPC returns exactly the
  declared `queryMatch`, key-hash equality, reviewed-obsolete and audit values.

It SHALL score every case against its declared expectations and report results
per family, base versus candidate, and hits and misses against the
pre-registered predictions. A wrong prediction SHALL be reported as a finding
and SHALL NOT be fixed by editing the fixture.

The loader SHALL reject a case that:
- shares any 5-gram with `tier-c.jsonl` or any Tier-B dataset;
- declares a derivation-free expectation;
- declares a reviewed link with an older successor that is not tagged
  `db_rejects`;
- has an invalid table;
- declares production-reachable ages beyond `windowMs` = 7,200,000.

## REQ-16 — Published holdout discipline

WHEN the candidate is scored on a published holdout, THE HARNESS SHALL use only
the committed LongMemEval pool of 142 unobserved, evidence-bearing,
non-abstention IDs, together with its sorted-ID SHA-256, salt and tranche
split. The pool is the conservative exclusion of every sample earlier runs
could have seen; LoCoMo is fully observed and may serve only as a regression
check.

THE HARNESS SHALL write and hash the selected indices and REQ-11 counts
before reading any gold label, and SHALL refuse to read labels without that
hash. IF no question in the tranche differs from the base, THEN it SHALL stop
without reading labels, and the tranche SHALL NOT count as burned. Any code
change after scoring SHALL burn the tranche.

## REQ-17 — Latency

THE SYSTEM SHALL keep the in-process selection stage (base plus provenance
merge) at p99 of 5 ms or less at n = 128, 491, 700 and 2000 turns, with up to
6 fact rows per exchange. The encoder SHALL stay below p99 10 ms. Both SHALL
be measured by a committed standalone benchmark. The RPC SHALL be measured
separately on local Compose at 64 and 128 exchanges with selective and broad
queries. Those RPC figures are development numbers only; they are compared with
the Tier-2 <50 ms p95 figure in `plan.md` §4 and are not counted in the 5 ms
budget.

## REQ-18 — PB-62 characterization

THE SYSTEM SHALL pin, with a fixed clock, a test showing that the absolute
`1e-9` spread guard (`kadanedial.ts` `zScoreNormalize`) changes the base
selection when raw similarities are identical. The overlay SHALL NOT rescale
scores. Any change to the guard SHALL be a separate owner-approved change that
passes REQ-14 and REQ-15 unchanged.

## Gate order

Each gate must pass before the next runs. Everything is free, local and
deterministic.

1. **G0 Spec and ADR** committed. The fixture SHA-256 files are committed before
   any candidate code.
2. **G1 Fixture.** The dev half passes, then the sealed half is opened once. A
   code change after opening burns the sealed half.
3. **G2 Tier-C identity** (REQ-14).
4. **G3 Published holdout.** LongMemEval tranche 1 under REQ-16 with the
   surrogate mapping: a user turn plus the immediately following assistant
   turn in the same session is one exchange, and a user turn with no following
   assistant turn is its own exchange. All exchanges are settled `ok`, and
   there are no fact rows, so only completion acts. Pass requires all of:
   - no question that is complete under the base becomes incomplete;
   - the complete count and mean evidence survival are at least the base's;
   - mean context reduction is at least 30%.

   Report results by type, with knowledge-update and multi-session separate.
5. **G4 Latency** (REQ-17).
6. **G5 Regression.** Run the frozen rule on all 1,527 labelled LoCoMo
   questions (labelled "observed, regression only") and all 479 labelled
   LongMemEval questions. Every question below evidence survival 0.80
   (`evals/harness/types.ts` `evidenceSurvivalMin`) is listed as a blocker of
   the judged run. This is a pre-existing property of the base at the default
   decay, not a pass criterion of the candidate.

**Terminal state:** "ready for the judged run" requires G1–G5 to pass, the
G5 blocker list to be empty, and the owner decisions below to be settled.
Otherwise the proof records the exact blockers. No DeepEval, Tier-A, Tier-B or
paid run is part of this work.

## Files

**New:**
- `specs/pruner/provenance-gated-selection.md` (this file) and
  `specs/pruner/provenance-fixture-brief.md` (the fixture author's brief)
- `stratum/docs/decisions/0023-provenance-gated-exchange-selection.md`
- `stratum/src/pruner/provenance-select.ts`
- `stratum/test/pruner/provenance-select.test.ts`
- `stratum/supabase/migrations/<UTC timestamp>_hot_exchange_provenance.sql`
- `stratum/test/integration/hot-exchange-provenance.sql`
- `stratum/src/memory/warm/exchange-provenance.ts`
- `stratum/test/memory/exchange-provenance.test.ts`
- `stratum/evals/datasets/provenance/{pges-fixture.dev.jsonl, pges-fixture.sealed.jsonl, *.sha256, AUTHORING.md}`
- `stratum/evals/harness/provenance-fixture.ts`
- `stratum/test/evals/provenance-fixture.test.ts`
- `stratum/scripts/eval-provenance.ts`
- `stratum/scripts/eval-tierc-provenance-identity.ts`
- `stratum/scripts/bench-provenance-select.ts`
- `stratum/evals/harness/holdout.ts`
- `stratum/scripts/eval-lme-holdout.ts`
- `stratum/evals/holdout/lme-h0.json`
- proofs under `.workflow/proofs/`

**Changed (additive only):**
- `stratum/src/proxy/shadow-observer.ts`: default-off option and metric
- `stratum/test/proxy/trusted-conversation.test.ts`, or a new
  `stratum/test/proxy/shadow-provenance-selection.test.ts`
- `stratum/package.json`: `eval:provenance`, `eval:tierc:identity`,
  `bench:provenance`, `eval:lme:holdout`
- `stratum/docs/ALGORITHM.md`: a Proposed overlay section. Decay-then-normalize
  is unchanged.
- `plan.md` §3c: a pointer
- `.workflow/state/polish-backlog.md`: PB-62 update

## Out of scope

- Any change to λ, θ, gainShift, fixed ranks, thresholds,
  `decayHorizonSeconds`/`decayHorizonFraction` (ADR-0015) or
  `trimCarriedTurns`, and any tuning to Tier-C, LoCoMo or LongMemEval labels.
  The rejected variants remain rejected: iterative maximum span, paper gain
  0.6, paper θ 0.6, raw top-k, dense+BM25, raw-top-1 rescue, and embedding
  geometry grouping.
- Text heuristics: matching currentness words, grouping by turn text, or
  grouping by embedding similarity between turns.
- Request-path pruning or forwarding changes, and a request-path settlement
  ledger. Exchange N has no ID, and the facts of exchange N-1 may still be
  extracting; both need their own spec and threat model.
- Tier-2 recall of dormant facts older than the 2 h hot window.
- Judged DeepEval Tier-A/B runs, and any paid API call beyond optional,
  owner-approved offline Jev judging.
- Jev in any request path (`specs/graph/J-jev-judgments.md` "Out of scope").
  Jev may only be used offline: one judgment per fixture case ("does the
  selected context contain the evidence for the query?"), recorded and not
  gating, on synthetic fixture text only, never on LoCoMo (CC BY-NC) text.
- A reviewed "authoritative/retracted" operator record for the case of an older
  authoritative fact with a newer draft, and a reviewed link for PolicyUpdate,
  VariableChange or OperationalReference.

## Acceptance criteria

- A property test over randomized histories, scoped and unscoped, with a fixed
  clock shows the output deep-equals `prune()` when there is no snapshot or no
  `exchangeId`.
- Red-first unit tests cover each of the following, and each is shown failing
  first against a named stub:
  - each fail-closed reason;
  - DEAD/LIVE/INERT/KEYED classification;
  - the contest rule, including the query-dependent TechDecision domain, and
    that neither git `CONFIRMED`, `created_at` nor recency ever breaks a
    contest;
  - exclusion of carried turns;
  - mixed and INERT exchanges are protected;
  - a successor chain with a visited set, and `droppedWithoutSuccessor`;
  - set-based rescue with no carried middle turn;
  - Todo-only exchanges are ineligible;
  - completion;
  - unbound turns are untouched.
- `npm run eval:tierc:identity` reports 50/50 identical selections, 29/50, and
  the identical 21 failed IDs. `npm run eval:tierc` output is unchanged.
- `npm run eval:provenance` passes the dev half, then the sealed half once. A
  proof records per-family results and prediction misses.
- The rolled-back Compose SQL fixture proves:
  - reviewed-obsolete parity with the existing predicate;
  - nulling of cross-session successors;
  - isolation across projects, organizations and conversations;
  - an ignored suppressed successor;
  - the CONFLICT join, and that a `CONFIRMED` status changes nothing;
  - null audit for OperationalReference;
  - the 1–128 bound;
  - anon and authenticated roles are denied.

  The declared `matchesQuery` and key-hash equalities of every fixture case
  equal the real RPC output.
- Observer tests prove:
  - counts only;
  - the forwarded request and base metrics are byte-identical with the option
    on and off;
  - a failed in-window write yields `WRITE_FAILED`;
  - a lookup rejection yields `LOOKUP_ERROR`.
- A benchmark proof records the selection stage at p99 ≤ 5 ms for n = 128, 491,
  700 and 2000, the encoder at p99 < 10 ms, and the RPC p50/p99 separately.
- The holdout proof records the H0 manifest hashes, the tranche used, blinded
  selection hashes, per-type survival, complete counts and reduction, and the
  G5 list of questions below 0.80.
- A PB-62 characterization test is committed with a fixed clock, and the guard
  is unchanged.
- Pruning remains disabled in requests.

## Delivery

Two graph cycles:
1. REQ-1 to REQ-13 and REQ-15. The fixture (REQ-15) is written first, by a
   separate author given only `specs/pruner/provenance-fixture-brief.md`, and
   committed with its SHA-256 files before any candidate code. The property
   test for REQ-1 guards base identity in this cycle.
2. REQ-14 and REQ-16 to REQ-18, and the gate run G1-G5.

## Decisions recorded 2026-09-25

The owner delegated these to the orchestrator's recommendation ("i will go
with your recommendations"); each can be overridden, and ADR-0023 records the
reasoning.

1. **Tier-C gate.** Zero Tier-C failures remains required before request-path
   pruning of any history longer than the 2 h Tier-1 window. For this
   candidate, Tier-C is the REQ-14 identity check. `plan.md` §3c says so.
2. **The 0.80 evidence-survival floor at the default decay** is a blocker of
   the judged run, not of this candidate. Activating ADR-0015 scale-invariant
   decay is evaluated as its own, separately gated candidate.
3. **Relevance signal for rescue.** The existing lexical query-to-fact match
   (migration `20260924235800`) is used as is. Dense fact matching needs fact
   embeddings at extraction time and is out of scope.
4. **Git `CONFIRMED` does not break a contest.** It records that a commit
   touched the symbol, not that the fact is current. `CONFLICT` still marks a
   fact DEAD.
5. **Published text.** Rescue and exclusion are proven on the fixture only. A
   local-extraction replay of a LongMemEval tranche is backlog, after
   extractor throughput and determinism are measured.
6. **Holdouts.** The committed 142-question LongMemEval pool is used as
   specified. Acquiring a new evidence-labelled benchmark is backlog.
7. **Dormant facts older than the hot window** are a Tier-2 recall follow-on
   (backlog, own spec), which must make Tier-C's long-history cases pass.
8. **PB-62** is characterized only (REQ-18); any change is a separate,
   separately gated change.
9. **Jev** may judge fixture cases offline (synthetic text, non-gating; the
   cost is negligible). No LoCoMo text (CC BY-NC) is sent to TypeSafe.
10. **Missing trusted signals** (a reviewed "authoritative/retracted" record;
    reviewed supersession for PolicyUpdate, VariableChange and
    OperationalReference) are backlog, each with its own spec, threat model
    and migration.
