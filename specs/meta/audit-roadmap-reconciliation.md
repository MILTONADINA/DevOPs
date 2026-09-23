# v0.6 audit roadmap reconciliation

**Scope:** `plan.md` §5, after the deterministic audit engine, status storage,
and dashboard read surfaces were added ahead of the v0.6 release.

## REQ-1 — Evidence-based checklist

WHEN the v0.6 checklist is refreshed, THE SYSTEM SHALL distinguish existing
source and focused test coverage from live request-path integration. It SHALL
mark the implemented Git attestation core, Llama and Opus prompt/parser cores,
audit schema, and dashboard read surfaces according to their actual evidence.
It SHALL retain explicit open gates for trusted commit anchoring, real model
execution and cost controls, request-path wiring, local database verification,
live conflict timing, and release evaluation.

## Acceptance criteria

- **AC-1:** every checked v0.6 item names a source artifact that exists.
- **AC-2:** the checklist does not imply that unit-tested model seams have
  executed a real Llama or Opus audit.
- **AC-3:** live timing, local database, request-path, and release gates remain
  unchecked until their own evidence exists.
