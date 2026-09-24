# Tier-A benchmark inventory and executable gate guidance

**Scope:** `plan.md` §3c and `stratum/docs/EVAL_FRAMEWORK.md`. LoCoMo and
LongMemEval loaders and separate judged runners already exist. The older
MT-Bench+/SCM4LLMs checklist and example commands contradict the current
evaluation design and runnable CLI. This is a documentation correction; it
does not change selection, thresholds, data, or release status.

## REQ-1 — Name the actual long-horizon datasets

WHEN the v0.4 plan or current evaluation guidance names Tier-A datasets, IT
SHALL identify LoCoMo and LongMemEval as the implemented long-horizon loaders.
IT SHALL describe MT-Bench-101 as a short multi-turn response-quality
benchmark, and SCM4LLMs as a memory framework that has no integrated dataset
in this project. It SHALL distinguish an implemented loader from a completed
judged release run.

## REQ-2 — Name runnable gates and their current status

WHEN guidance instructs an operator to verify pruning, IT SHALL name supported
commands: `eval:tierc`, `eval:locomo`, `eval:longmemeval`, and `test:eval`
without an unsupported `--suite` flag. IT SHALL state that Tier-C remains
29/50, full Tier-A judged runs and orchestration are open, and pruning is
disabled. IT SHALL not describe a red or missing gate as running on every
build or as a shipped quality guarantee.

## Acceptance

- A source inspection confirms both loaders and their runner commands exist.
- A focused documentation check finds no active current-gate guidance that
  asks for MT-Bench+/SCM4LLMs loaders or unsupported `--suite` flags.
- No runtime source, benchmark corpus, or pruning default changes.

Sources: [MT-Bench-101 repository](https://github.com/mtbench101/mt-bench-101),
[SCM4LLMs repository](https://github.com/wbbeyourself/SCM4LLMs), and
[LongMemEval dataset guide](https://github.com/xiaowu0162/LongMemEval/blob/main/README.md).
