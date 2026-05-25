# Injection-probe Fixtures (C.10)

Phase 2 Area C / REQ-C1 + REQ-C6 — deterministic fixtures exercising the
boundary layer's detection + approval-workflow ACs.

## Contents

- `canonical-probe.txt` — the canonical IGNORE-PREVIOUS-INSTRUCTIONS
  injection payload. Exercises AC-C1.1: rebuff returns confidence ≥ 0.6.
- `block-then-approve.md` — scenario script for AC-C6.1 + AC-C6.2:
  high-confidence trigger payload, followed by `devops approve` flow.
- `double-consumption-probe.md` — scenario script for AC-C6.3:
  attempt to consume a token twice (second attempt rejected).

All fixtures are reproducible by `tests/integration/req-C1-injection-probes.test.js`
(if present) or by direct boundary-layer call from a REPL.

## Why these probes

The canonical IGNORE-PREVIOUS-INSTRUCTIONS family is the most-documented
prompt-injection vector in 2026 LLM literature. The boundary layer's
detector tier (rebuff + optional lakera-guard) must trip on this payload
deterministically — if it doesn't, the boundary is broken.

The approval workflow probes exercise the load-bearing one-shot
semantic: token must be consumed exactly once, with HMAC re-verification
on consumption (manual JSONL edits don't pass).
