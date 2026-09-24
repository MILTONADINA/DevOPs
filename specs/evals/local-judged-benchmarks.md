# Local judged benchmark option

**Scope:** `plan.md` §3 v0.4 Tier-A evaluation. This option allows bounded
exploratory judged runs when no paid Claude key is available. It does not
replace the documented Claude Haiku release gate or benchmark coverage.

## REQ-1 — Explicit model provenance

WHEN LoCoMo or LongMemEval judged evaluation runs, THE RUNNER SHALL use
explicit Claude credentials or an explicitly selected local model endpoint.
WHEN local evaluation is selected, THE RUNNER SHALL report the model and label
the result exploratory. IF neither provider is configured, THEN it SHALL exit
nonzero before encoding and SHALL NOT report a passing benchmark.

## REQ-2 — Local endpoint boundary

WHEN a local model is selected, THE COMPLETION CLIENT SHALL accept only a
literal loopback HTTP `/v1` endpoint and a `local/<model>` identifier. It SHALL
send the prompt to the OpenAI-compatible chat endpoint without redirects, and
fail on HTTP errors, truncated output, invalid responses, or oversized replies.

## Acceptance criteria

- Focused tests reject remote endpoints, malformed model IDs, non-text and
  truncated replies, and prove the bounded request shape.
- Both runners share the same provider selection and surface an exploratory
  label for local judged results.
- A bounded local model run on a published dataset reports a real result,
  including a failure if the score gate fails.
- An evidence-only failure names dropped gold evidence in the action hint.
