# paper-notes.md — Notes on arXiv:2601.07994

> Choi, N. et al. *DYCP: Dynamic Context Pruning for Long-Form Dialogue with LLMs.*
> arXiv:2601.07994, January 2026.
> Full text: https://arxiv.org/abs/2601.07994

**Status:** READ THIS BEFORE IMPLEMENTING ANYTHING IN `src/pruner/`

---

## Summary

<!-- Fill this in after reading the paper -->

## KadaneDial — Key Details

<!-- Document the exact algorithm parameters from the paper -->
<!-- Note: the paper uses θ = 1.0 as default. Document why we chose our defaults. -->

## Benchmark Results (from paper)

### LoCoMo

| Method | Answer Quality | Latency |
|---|---|---|
| Full Context | (baseline) | (baseline) |
| DyCP | | |
| CQ-Extended (our target) | | |

### MT-Bench+

| Method | Answer Quality | Latency |
|---|---|---|
| Full Context | | |
| DyCP | | |

### SCM4LLMs

| Method | Answer Quality | Latency |
|---|---|---|
| Full Context | | |
| DyCP | | |

## Failure Cases / Limitations

<!-- What does the paper say DyCP does NOT handle well? -->
<!-- These are the scenarios we need to cover in our Tier B eval dataset. -->

## Key Quotes

<!-- Copy important sentences from the paper here for easy reference -->
<!-- Remember: these are for internal reference, not for reproduction -->

## Questions / Open Issues

<!-- Things the paper doesn't answer that we need to figure out ourselves -->

## Implementation Notes

<!-- Specific technical details from the paper that Claude Code will need -->
<!-- e.g. tokenizer choice, embedding model, hyperparameter sensitivity -->
