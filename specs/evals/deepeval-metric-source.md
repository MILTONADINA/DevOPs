# DeepEval metric source for judged release gates

**Scope:** `plan.md` §3c and `stratum/docs/EVAL_FRAMEWORK.md`. The current
TypeScript scalar judge is useful for exploratory runs but does not implement
the named DeepEval Faithfulness and Answer Relevancy metrics. The TypeScript
DeepEval beta currently brings a critical dependency advisory, so the release
gate uses the pinned Python DeepEval package and its Anthropic model integration.

## REQ-1 — Score Claude release runs with named metrics

WHEN a judged Tier-B or published Tier-A release run uses Claude, THE EVAL
SHALL score each generated answer with pinned Python DeepEval
`FaithfulnessMetric` and `AnswerRelevancyMetric`, using the same query, answer,
and selected context as the existing comparison in explicit LLM evaluation
mode. It SHALL preserve the project's existing thresholds and
pruned-versus-baseline comparison. A missing
metric dependency, key, bridge failure, or metric error SHALL fail the run; it
SHALL NOT fall back to the custom scalar judge or fabricate a score. The run
SHALL describe answer-and-judge cycles without claiming they bound
underlying model requests, because DeepEval may make multiple requests per metric.

## REQ-2 — Keep exploratory results separate

WHEN a local-model exploratory run is selected, THE EVAL MAY continue to use
the existing custom scalar judge but SHALL label it exploratory and return
nonzero for release gates. Standalone sampled commands SHALL remain sampled by
default. The output SHALL identify the metric source so scores from the old
custom judge and the pinned DeepEval Python package cannot be conflated.

## REQ-3 — Prove the integration offline

WHEN the metric adapter is tested without a paid provider, THE TESTS SHALL use
deterministic metric injection to verify the exact query, answer, retrieval
context, both metric invocations, score range, and fail-closed errors. The
Python bridge SHALL disable DeepEval dotenv loading and SHALL use a project-local
virtual environment. The tests SHALL exercise release-provider selection in
Tier-B and both published runners without making an external model call.
Typecheck and the existing
focused eval tests SHALL pass. Full judged benchmark quality remains open
until the unchanged Tier-C gate and real Claude run pass.

## REQ-4 — Permit only required hosts

WHEN the local operator installs the pinned evaluator and runs Claude judged
metrics, THE PROJECT SHALL allow only the PyPI package hosts and Anthropic API
host required by those actions.

## REQ-5 — Bound a silent metric worker

WHEN a DeepEval worker stops replying to a score request, THE JUDGE SHALL
reject the request within a bounded time, terminate the worker, reject any
queued scores, and refuse later scores from that judge. A silent worker SHALL
NOT hang a full benchmark or produce a fabricated score. Focused offline tests
SHALL prove timeout and worker cleanup without an external model call.
