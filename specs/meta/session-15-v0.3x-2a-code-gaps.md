# Spec — Session 15 v0.3.x §2a: Phase 0 code-side gaps closure

**Type**: Meta (implementation; first authorized logic changes to `stratum/scripts/capture-session.ts` after the Session 13 ZERO-modifications baseline)
**Status**: AUTHORED 2026-05-28 — implementation begins immediately under Session 14 masterpiece blueprint binding + Q8.1 vitest TDD discipline
**Author**: Milton Adina (Session 15 goal: "develop the project ... deliver a masterpiece")
**Branch**: `stratum-phase-0-capture` (long-lived; rebased onto `4c62801` at session start)
**Quality bar**: production-grade per blueprint §6 (coverage statements ≥85% / branches ≥80% / functions ≥90% / lines ≥85%; TS strict; no `any`; explicit error handling; FAIL-CLOSED security defaults).

This spec covers the four code-side gaps in `plan.md §2a` as a single coordinated change unit. Single spec + single claim per the masterpiece blueprint's claim-emission discipline.

---

## REQ-S15-2a-1 — Q4 base-URL wiring (env-var-primary override)

THE SYSTEM SHALL allow operators to redirect Anthropic API calls to a configurable base URL via the `ANTHROPIC_BASE_URL` environment variable, with a safe default of `https://api.anthropic.com` and fail-fast validation at module load time.

### AC-S15-2a-1.1

WHEN `stratum/scripts/capture-session.ts` is loaded AND `process.env.ANTHROPIC_BASE_URL` is unset, THE SYSTEM SHALL default the base URL to `https://api.anthropic.com`.

### AC-S15-2a-1.2

WHEN `stratum/scripts/capture-session.ts` is loaded AND `process.env.ANTHROPIC_BASE_URL` is set to a valid http(s) URL, THE SYSTEM SHALL use that URL as the prefix for the `/v1/messages` forward path.

### AC-S15-2a-1.3

WHEN `stratum/scripts/capture-session.ts` is loaded AND `process.env.ANTHROPIC_BASE_URL` is set to a string that cannot be parsed as a URL OR uses a non-http(s) scheme, THE SYSTEM SHALL log a structured error to stderr AND exit with code 1 (FAIL-FAST at module load — NOT at first request).

### AC-S15-2a-1.4

WHEN the base URL config is snapshotted at module load, THE SYSTEM SHALL NOT re-read `process.env.ANTHROPIC_BASE_URL` on subsequent requests (determinism guard against mid-run env mutation).

---

## REQ-S15-2a-2 — P0-F PII redaction wiring (SECURITY-BEARING)

THE SYSTEM SHALL apply PII redaction (via consumption of `observability/pii-redaction.ts`) to request and response payloads BEFORE writing capture artifacts to disk, with FAIL-CLOSED behavior on redactor exceptions.

### AC-S15-2a-2.1

WHEN a turn is captured for storage, THE SYSTEM SHALL apply PII redaction to `request.messages[].content` (text + tool inputs), `request.system` (system prompt if present), and `response.content[].text` (assistant text) BEFORE the capture artifact is written to `data/sessions/session-<uuid>.json`.

### AC-S15-2a-2.2

WHEN the PII redactor throws an exception during redaction of a turn, THE SYSTEM SHALL drop that turn from the session JSON (do NOT proceed to storage write of unredacted content), emit a structured stderr error including the exception class + message + turn number, AND continue accepting subsequent turns (single-turn failure does NOT terminate the proxy).

### AC-S15-2a-2.3

THE SYSTEM SHALL NOT redact non-PII metadata: `model`, `stop_reason`, `usage.input_tokens`, `usage.output_tokens`, `id`, `type`, `role`. These are not PII per `observability/pii-redaction.ts` pattern definitions and are required for downstream Phase 1+ analysis.

### AC-S15-2a-2.4

THE SYSTEM SHALL import the redactor from a single source (`observability/pii-redaction.ts` from DevOPs's project root, referenced relative to the capture script). It SHALL NOT duplicate redaction regex patterns inside `stratum/scripts/capture-session.ts`. (Per spec §3 P0-F constraint.)

---

## REQ-S15-2a-3 — Anthropic SDK version verification

THE SYSTEM SHALL verify that `stratum/package.json`'s pinned `@anthropic-ai/sdk` version is compatible with the current capture-session.ts SDK usage; if not, bump or revert with explicit ADR documenting rationale.

### AC-S15-2a-3.1

WHEN the package.json `@anthropic-ai/sdk` pin is verified against the npm registry, THE SYSTEM SHALL produce one of three outcomes documented in baton.md + ADR:
- **Outcome A (no change needed)**: current pin works; no bump.
- **Outcome B (compatible bump)**: bump to current stable; tests still pass; ADR records the bump.
- **Outcome C (breaking change)**: SDK shape changed; capture-session.ts SDK calls (currently `messages.countTokens`) need adjustment OR stay on old version with explicit pin justification; ADR records the decision.

### AC-S15-2a-3.2

WHEN any package.json change is made, THE SYSTEM SHALL re-run the full vitest suite (`cd stratum && npm test`) and verify GREEN before committing.

---

## REQ-S15-2a-4 — Adversarial test additions

THE SYSTEM SHALL add three adversarial test files to `stratum/test/capture-session/` covering attack-surface scenarios for the production capture path.

### AC-S15-2a-4.1

WHEN `stratum/test/capture-session/injection-resilience.test.ts` is added, it SHALL include test cases verifying: (a) a message body containing the literal string `[REDACTED-email]` is NOT mistakenly double-redacted, (b) a message containing literal regex metacharacters (`.*`, `(?:...)`, `\b`) does NOT cause redactor regex to misfire, (c) Unicode/emoji content is preserved correctly through capture + redaction.

### AC-S15-2a-4.2

WHEN `stratum/test/capture-session/partial-response.test.ts` is added, it SHALL include test cases for: (a) Anthropic returns truncated JSON (incomplete response body), (b) Anthropic returns a valid status but malformed content blocks, (c) handler does not crash; capture artifact records the malformed state.

### AC-S15-2a-4.3

WHEN `stratum/test/capture-session/oversized-payload.test.ts` is added, it SHALL include test cases for: (a) request body >1MB, (b) response body with very long content (10K+ tokens of text), (c) handler completes without exhausting memory; capture write succeeds.

### AC-S15-2a-4.4

WHEN the full test suite is run after these additions, ALL existing 50 passing tests SHALL still pass (zero regression) AND the new adversarial tests SHALL pass (or `test.skip` with explicit rationale if a test exposes a real bug requiring a separate fix).

---

## REQ-S15-2a-5 — Coverage threshold compliance

THE SYSTEM SHALL maintain the production-grade coverage thresholds from blueprint §6 + `stratum/vitest.config.ts` on `scripts/capture-session.ts` after all §2a changes:
- Statements ≥85%
- Branches ≥80%
- Lines ≥85%
- (Functions threshold disabled per Session 13 v8-on-TS-source-maps fidelity artifact; this carry-forward remains documented in vitest.config.ts)

### AC-S15-2a-5.1

WHEN `npx vitest run --coverage` is executed at the §2a closure point, the reported metrics for `scripts/capture-session.ts` SHALL meet all four thresholds above.

---

## Scope boundary

This meta-spec covers v0.3.x §2a (Phase 0 code-side gaps) only. Out of scope:
- §2b content corpus (user-side activity: capturing real sessions)
- §2c Phase 0 closure rituals
- §2d Phase 1 measurement proxy buildout
- §2e–§2h release mechanics + post-§2a polish

Cross-references:
- `plan.md §2a` — task list
- `plan.md §2b–§2h` — downstream tasks (not in this spec)
- `blueprint.md §3` (Stratum Phase 0 — Observation)
- `blueprint.md §6` (Quality bar — testing + security)
- `.workflow/state/plans/stratum-phase-0-capture.md §4 P0-A AC-P0-A.x` — original Phase 0 acceptance
- `observability/pii-redaction.ts` — REQ-S15-2a-2 dependency (consumption target)
