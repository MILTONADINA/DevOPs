# Cost Controls

Mechanical, deterministic safety against runaway costs and infinite loops.

These are NOT advisory. Hooks read these files and halt the session when caps
are hit. The agent cannot override.

## Files

- `budget.yml` — USD caps per session / hour / day / month
- `model-routing.yml` — three-tier routing (Haiku / Sonnet / Opus)
- `loop-thresholds.yml` — same-call repetition and stasis thresholds

## How it works

```
LLM call requested
       │
       ▼
┌──────────────────┐
│ budget-brake.sh  │ ← reads budget.yml; reserves max cost; halts if cap exceeded
└──────────────────┘
       │ (pass)
       ▼
┌──────────────────┐
│ loop-detection.sh│ ← reads loop-thresholds.yml; halts on repetition or stasis
└──────────────────┘
       │ (pass)
       ▼
   call proceeds
       │
       ▼
┌──────────────────┐
│ Update ledger    │ ← actual cost committed to budget-ledger.jsonl
└──────────────────┘
```

## Reference incidents these prevent

- "$437 burned overnight in a single session" (2026) → budget brake
- "Claude Code subagent consumed 27M tokens in a 4.6h infinite loop" → loop detection
- "14,000 list_files calls in one Magicrails session" → same-call threshold
- "$6 burned in 30 seconds" → reserve-commit pattern

## Customizing

Project-level overrides go in `.workflow/state/budget.yml` (gitignored if it
contains client-specific caps; committed if shared with team).

## Documented savings

Three-tier routing benchmarks (multiple 2026 sources):
- KanseiLink mid-size SaaS scenario: 83% reduction ($54 → $9)
- Augment Code measurement: 51% reduction per session
- General range across studies: 50-80%

Add Batch API for additional 50% on non-real-time work.
