# Session-neighbor retrieval candidate

**Scope:** `plan.md` §3c and §3e. The current request pruner remains disabled.
This spec records an exploratory long-horizon retrieval candidate; it does
not approve activation or change the fixed Tier-C and judged Tier-A gates.

## REQ-1 — Keep conversational context within its session

WHEN a raw-turn retrieval candidate expands an initially selected dialogue
turn for context, THE CANDIDATE SHALL use trusted session metadata and SHALL
add only adjacent turns from that same session. It SHALL NOT treat a turn in
another session as a neighbor merely because it has the next global index.

## REQ-2 — Measure on questions outside the development sample

WHEN this candidate is evaluated against published evidence labels, THE
DIAGNOSTIC SHALL exclude questions used to inspect the failure pattern,
report complete-question evidence coverage, gold turns retained, and context
reduction for base retrieval and expanded retrieval, and consult gold labels
only after selecting turns. It SHALL identify the fixed candidate rule and
the excluded sample so a later run can reproduce the comparison.

## REQ-3 — Preserve release gates

IF a neighborhood experiment improves aggregate evidence retention, THEN the
release decision SHALL still require the unchanged Tier-C critical cases,
per-question published evidence floor, full judged quality comparison, and
one week of real-use validation. Aggregate evidence retention or a sampled
diagnostic SHALL NOT enable request-path pruning.

## Exploratory result, 2026-09-24

The fixed dense-top-64 plus BM25-top-64 union missed 40 gold turns among the
previous 120 LoCoMo questions; 39 had no lexical overlap with their query.
After excluding those questions, one same-session neighbor raised complete
LoCoMo evidence from 1,045/1,407 to 1,265/1,407 at 62.1% context reduction.
On 120 separate LongMemEval questions, complete evidence rose from 114 to
116 at 62.8% reduction. Two LoCoMo neighbors retained 1,308/1,407 complete
but lowered reduction to 48.7%. Exact scripts, commands, logs, and limitations
are in `.workflow/proofs/neighborhood-evidence-transfer-2026-09-24.md`.

The candidate remains exploratory. Tier-C is 29/50, published per-question
evidence and judged quality have not passed, and pruning stays disabled.
