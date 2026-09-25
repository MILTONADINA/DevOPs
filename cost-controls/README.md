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

## Reference incidents these guard against

- A library author's launch post describes an overnight LangChain agent that
  called `list_files` 14,000 times and cost $437. It is an unverified anecdote
  ([dev.to/magicrails, Apr 2026](https://dev.to/magicrails/i-let-my-ai-agent-run-overnight-it-cost-437-dd7)). → budget brake, same-call threshold
- A Claude Code subagent retried one failing command 300+ times over ~4.6h,
  using ~27M tokens (user report, [anthropics/claude-code#15909](https://github.com/anthropics/claude-code/issues/15909)).
  → loop detection

Illustration, not an incident: in a simulated vendor demo, a looping bot
spends ~$5.95 in 30 seconds ([Cycles, Mar 2026](https://runcycles.io/blog/runaway-demo-agent-cost-blowup-walkthrough)). → reserve-commit
pattern

## Customizing

Project-level overrides go in `.workflow/state/budget.yml` (gitignored if it
contains client-specific caps; committed if shared with team).

## Documented savings

Three-tier routing benchmarks (multiple 2026 sources):
- KanseiLink mid-size SaaS scenario: 83% reduction ($54 → $9)
- Augment Code measurement: 51% reduction per session
- General range across studies: 50-80%

Add Batch API for additional 50% on non-real-time work.
