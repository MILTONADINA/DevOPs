# Offline Tier-C golden gate

**Scope:** `plan.md` §3c and §3e v0.4 pruning release gate. Tier-C checks
whether query-critical facts survive the actual encoder and pruning decision.
The authored fixture is synthetic developer work; it is not a substitute for
published Tier-A judged evaluation or one week of real use.

## REQ-1 — Nonvacuous critical corpus

WHEN the Tier-C gate loads its project-local dataset, THE GATE SHALL require at
least 50 distinct critical queries with explicit expected and forbidden
substrings, at least three timestamped turns each, and a nonempty query.
EVERY expected substring SHALL occur in the source turns, and EVERY forbidden
substring SHALL occur in the source turns so the keep-all and keep-none
baselines both fail. IF a case is malformed or the count falls below 50,
THEN the gate SHALL exit nonzero before reporting a pass.

## REQ-2 — Real deterministic pruning

WHEN Tier-C runs, THE GATE SHALL encode each case with the cached local ONNX
encoder and apply the actual KadaneDial pruner at the documented default
configuration. It SHALL check each selected context against the golden
substrings and exit nonzero on any failed critical query. It SHALL report the
number of cases passed, failed IDs, and the active decay parameters. It SHALL
report each failed case's missing or leaked anchors so the failure can be
diagnosed without changing the corpus. It SHALL
NOT call a paid answerer or judge, and SHALL NOT silently replace the pruner
with an unpruned context.

## REQ-3 — Main eval command is honest

WHEN `npm run test:eval` is invoked, THE RUNNER SHALL run Tier-C first and
report its verdict. IF Tier-C fails, the Tier-B dataset is absent, or no judged
provider is configured, THEN the command SHALL exit nonzero and SHALL NOT
report the full eval suite as passed. Its `--fast` option SHALL still include
Tier-C. The default full command SHALL remain nonzero until judged Tier-A is
integrated into that command; `--fast` SHALL report only Tier-B plus Tier-C.
Unsupported flags SHALL fail before a benchmark runs rather than be printed
and silently ignored.

## REQ-4 — Trusted project scope before relevance scoring

WHEN the caller supplies a trusted project scope for a query, THE PRUNER SHALL
consider only turns with the same trusted scope before calculating similarity,
normalization, and contiguous spans. Turns with a different or missing scope
SHALL be excluded, and the returned selected/pruned indices SHALL refer to the
original history. The shadow context manager SHALL carry caller-supplied scope
through hot memory to this selection. WHEN no query scope is supplied, existing
unscoped behavior SHALL remain unchanged.
WHEN a scoped decision is persisted, excluded turns SHALL have null score
entries at their original positions, so the logged score array remains aligned
with the original history.

The Tier-C `project_scope` cases SHALL declare query and turn scope metadata
without changing their text, ages, or golden anchors. The gate SHALL reject a
project-scope case with missing query scope or turn scope; its real pruner call
SHALL use this metadata. Scope SHALL NOT be inferred from turn or query text.

## Acceptance criteria

- Focused tests prove the corpus cardinality, unique IDs and queries, source anchors, and
  keep-all/keep-none failure guards.
- A fake encoder test proves the gate uses selected indices from the pruner,
  rather than checking the full input.
- Running the command against the real cached encoder records the actual
  pass/fail result without modifying the dataset to force a pass.
- The main eval command returns nonzero when a provider is absent.
- A focused test gives a foreign turn stronger semantic similarity than a
  target turn and verifies that only the target can survive a scoped query.
- The fixed 50-case corpus remains red until every critical case passes; a
  scope improvement SHALL NOT be reported as a green release gate by itself.

## Current result

The cached local encoder with the default λ=0.97 passes 29/50 cases after
trusted scope filtering, including all 10 project-scope cases. Twenty-one
critical cases still fail. The production request path does not yet supply a
trusted project binding, so Tier-C and the v0.4 release gate remain red.
