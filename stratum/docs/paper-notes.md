# DyCP paper notes — arXiv:2601.07994

Source: Choi, Zhang, and Choi, [*DyCP: Dynamic Context Pruning for Long-Form Dialogue with LLMs*, version 5 (June 2026)](https://arxiv.org/html/2601.07994v5). Numbers below are from the authors' experiments, not Stratum measurements.

## 1. What the paper selects

Each historical unit is a **completed user–agent pair**: the user utterance and its answer are concatenated and embedded once. At query time, a bi-encoder embeds the new user utterance, scores it against the stored pair embeddings, and selects contiguous, chronologically ordered spans. It does not build offline LLM summaries or make an extra LLM call to refine retrieval. Stratum's current commercial shadow observer instead ingests user and assistant as two separate units; this is a method difference to evaluate, not evidence that either representation is better for our workload. See §3 and `src/proxy/shadow-observer.ts`.

## 2. KadaneDial and parameters

The paper z-normalizes cosine scores across the candidate history, then computes per-unit gain `z_i − τ`. It repeatedly finds the **global maximum-sum contiguous span**, masks that span, and stops when the next maximum is below `θ`; the chosen spans are output in time order. The authors use **τ = 0.6** and **θ = 1.0** across their datasets, chosen by preliminary qualitative inspection. Stratum currently defaults to `gainShift = 0.0`, `theta = 1.0`; its implementation emits eligible local runs rather than repeating the paper's global maximum search. These are explicit adaptation differences, and the paper's values must not be silently called Stratum defaults. See §3 and §4.4; compare `src/pruner/kadanedial.ts`.

## 3. Temporal decay is Stratum's addition

The paper has **no λ parameter or time decay**. Stratum's CQ-Extended variant multiplies each raw similarity by `λ^(age_hours)` before z-normalization, currently with default `λ = 0.97` (about 22.8-hour half-life), and has an optional, default-off span-relative horizon. The project measured catastrophic loss of weeks-old LoCoMo gold evidence under the per-hour default, so paper quality numbers cannot validate this extension. Long-horizon recall and recent hot context require separate evidence; see ADR-0015 and `docs/ALGORITHM.md`.

## 4. Published benchmark results and limits of comparison

The paper tests 500 sampled LoCoMo QA pairs from 10 dialogues, plus MT-Bench+ and SCM4LLMs. Its quality is GPT4Score (0–100); latency is streamed **time to first token**, not end-to-end response time. The table uses the GPT-4o agent from Table 5 so rows share an evaluation setting.

| Benchmark | Full-context quality / latency | DyCP quality / latency | Mean input tokens, full → DyCP |
|---|---:|---:|---:|
| LoCoMo | 75.13 / 2.32 s | 83.27 / 1.10 s | 25,750 → 4,982 |
| MT-Bench+ | 88.03 / 1.56 s | 89.02 / 0.95 s | 20,364 → 2,698 |
| SCM4LLMs | 85.51 / 2.06 s | 87.57 / 1.03 s | 24,006 → 4,042 |

These are the paper's DyCP results with its retriever (`facebook/contriever-msmarco` for answer generation), not a CQ-Extended result. Stratum uses an INT8 MiniLM encoder and a different decay and gain configuration. Its own unchanged Tier-C corpus and judged Tier-A gates decide release. The authors report that GPT-4.1 narrows DyCP's quality advantage over full context on LoCoMo (91.46 vs 92.06), while lowering first-token latency (0.97 vs 2.41 s). See §4.2–4.5, Tables 4–5.

## 5. Retrieval and continuity findings

On LoCoMo, the paper reports DyCP with Contriever-MSMARCO Hit@5 = 0.8849 and Recall@5 = 0.8179; these are turn-level retrieval metrics, not answer faithfulness. Its ablation shows small, consistent quality loss when low-relevance turns are removed from selected spans. Increasing recall helps answer quality until gains taper off, while latency rises. This cautions against a blanket rule that drops all locally weak turns or expands context without a stopping condition. See §4.5.3 and §5.2–5.3.

## 6. Failure cases and deployment limits

The authors attribute cases where full context wins mainly to **retrieval missing needed evidence**. Semantic similarity alone can miss relevant turns, so a stronger retriever or domain adaptation may help. Their small human check has one annotator on 50 QA pairs from one dialogue; it supports, but does not establish, the automatic judge's validity. First-token speedups assume stateless serving: stateful KV reuse or provider prompt caching can narrow or reverse speed and cost gains. Embedding storage and query scoring also add overhead. See §4.5.2, §5.1, and §8.

## 7. Stratum adaptation and next evaluation

- Preserve the current release gate: the default Tier-C result is 29/50, and no request-path pruning should activate until unchanged Tier-C and judged Tier-A pass.
- Compare paired-exchange embeddings with separate-message embeddings on published dialogue and trusted real shadow traffic before changing the unit of selection. The existing synthetic Tier-C turns cannot measure a pair representation without rewriting their fixtures.
- Compare paper-faithful `τ = 0.6` and iterative global spans against current `gainShift = 0.0` and local spans on fixed cases, recording evidence survival, stale-turn selection, retained tokens, and answer quality. Do not choose a default from a single dataset.
- Treat dormant facts as a memory-recall problem as well as a hot-context problem: the current two-hour hot window cannot show whether warm storage retrieves evidence from days earlier. Measure that separately from pruning.

## Open questions

How much do pair embeddings change retrieval on developer conversations? Do the authors' gain and span rules improve Stratum's gold evidence survival under its encoder? What is the net cost with the intended provider's cache policy? These require measurements; the paper does not answer them for this product.
