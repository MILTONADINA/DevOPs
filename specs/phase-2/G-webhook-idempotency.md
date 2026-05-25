# Phase 2 / Area G — Webhook Idempotency Skill (Universal)

**Spec ID**: phase-2/G-webhook-idempotency
**Status**: draft
**Last updated**: 2026-05-22
**Owner**: miltonadina
**Reviewers**: miltonadina

---

## Context

Webhook idempotency is gap #47 in `docs/GAP_61_COVERAGE_MATRIX.md` and a recurring source of production-critical defects across every provider that emits HTTP webhooks (Stripe, GitHub, Slack, Twilio, SendGrid, …). The failure mode is the same regardless of provider: a webhook delivery retries, the receiver double-processes the event, and a side effect (charge, deploy, notification, inventory mutation) happens twice. Phase 2 area G ships a **universal** security skill at `skills/universal/security/webhook-idempotency/SKILL.md` teaching the provider-agnostic patterns (idempotency keys, replay windows, dedupe storage). Stack-specific variants (e.g., the Stripe-specific skill in area D) extend this with provider-specific signature verification and event-id discipline.

## Out of scope

- Stripe-specific webhook idempotency — that is one of the nine skills in **area D**.
- The runtime middleware / library that implements idempotency for a given application — this is a teaching skill, not a runtime artifact.
- Webhook *signature* verification (HMAC validation) — separate concern; mentioned briefly but not the primary subject.
- Reactive replay-attack detection — covered by area C (prompt-injection-defense) for content-level attacks; this spec covers control-flow-level replays.

## Actors and data

- **Primary actors**: coder and reviewer subagents (consulting the skill when writing or reviewing webhook handlers).
- **Data classes touched**: indirectly — webhook payloads typically contain PII or financial data, but the skill itself contains only patterns and synthetic examples.
- **Compliance scope**: indirect — incorrect idempotency in PCI/PII contexts amplifies the regulatory blast radius of double-processing.

---

## Functional requirements (EARS)

### REQ-G1 (Ubiquitous) — SKILL.md exists
THE SYSTEM SHALL contain a `SKILL.md` file at `skills/universal/security/webhook-idempotency/SKILL.md` with valid YAML frontmatter (`name`, `description`).

### REQ-G2 (Ubiquitous) — Idempotency-key pattern documented
THE SYSTEM SHALL ensure the skill explains the idempotency-key pattern: how the *provider* assigns a stable id per event (e.g., `event.id`, `delivery_id`) and how the *receiver* persists processed-ids to refuse duplicate work.

### REQ-G3 (Ubiquitous) — Replay-window pattern documented
THE SYSTEM SHALL ensure the skill explains the replay-window pattern: how to reject events whose timestamp is older than a configurable window (typically 5 minutes) to defend against stored-and-replayed deliveries.

### REQ-G4 (Ubiquitous) — Storage strategies documented
THE SYSTEM SHALL ensure the skill compares at least three storage strategies for the processed-id set (Redis with TTL, database unique constraint, in-memory LRU for low-volume) including the failure modes of each.

### REQ-G5 (Ubiquitous) — At least two provider worked examples
THE SYSTEM SHALL ensure the skill includes worked code examples for at least two of {Stripe, GitHub, Slack, Twilio, SendGrid}, in TypeScript or Python, illustrating both the idempotency-key and replay-window patterns.

### REQ-G6 (Event-driven) — Analyzer recommends skill on webhook indicators
WHEN `analyzer/scan.ts` detects webhook-handler indicators (a route matching `/webhook(s)?`, an import of a provider SDK with webhook helpers, a `Stripe-Signature` / `X-Hub-Signature-256` header reference in source), THE SYSTEM SHALL include `security/webhook-idempotency` in the `recommended.skills` array.

### REQ-G7 (Ubiquitous) — Anti-patterns called out
THE SYSTEM SHALL ensure the skill enumerates at least three concrete anti-patterns: (i) using request body hash as the idempotency key (changes on legitimate retries), (ii) storing processed-ids in memory only (loses on restart), (iii) silently re-processing on dedupe-store failure (turns the safety net into the failure vector).

### REQ-G8 (Ubiquitous) — ASI threat mapping
THE SYSTEM SHALL ensure the skill explicitly references at least one OWASP ASI 2026 identifier from `governance/owasp-asi-2026/threats.md` that the skill mitigates — typically ASI02 (Tool Misuse, since a replayed webhook can re-trigger a destructive tool call).

---

## Acceptance criteria

### AC-G1.1 (maps to REQ-G1)
**Given** the post-implementation repository
**When** `Test-Path skills/universal/security/webhook-idempotency/SKILL.md` is executed
**Then** the result is true and the YAML frontmatter is parseable with non-empty `name` and `description`.

### AC-G2.1 (maps to REQ-G2)
**Given** the skill body
**When** the file is searched for `idempotency` (case-insensitive)
**Then** at least 4 occurrences appear, and at least one H2 or H3 section is titled `Idempotency key` (or close variant).

### AC-G3.1 (maps to REQ-G3)
**Given** the skill body
**When** the file is searched for `replay`
**Then** at least 2 occurrences appear, and at least one H2 or H3 section discusses time-window enforcement with a concrete duration recommendation.

### AC-G4.1 (maps to REQ-G4)
**Given** the skill body
**When** storage strategies are enumerated
**Then** at least three distinct strategies are named with a "fails when" caveat per strategy.

### AC-G5.1 (maps to REQ-G5)
**Given** the skill body
**When** fenced code blocks are inspected
**Then** at least two fenced code blocks reference distinct provider SDK / webhook patterns (e.g., one for Stripe, one for GitHub).

### AC-G6.1 (maps to REQ-G6)
**Given** an analyzer fixture project with a route handler at `/api/webhook/stripe`
**When** `node analyzer/scan.ts` runs against it
**Then** the emitted profile's `recommended.skills` includes `security/webhook-idempotency`.

### AC-G7.1 (maps to REQ-G7)
**Given** the skill body
**When** the "Anti-patterns" section is inspected
**Then** at least three numbered or H3-headed anti-patterns appear, each with a one-line description of the failure mode.

### AC-G8.1 (maps to REQ-G8)
**Given** the skill body
**When** the file is searched for the pattern `ASI\d{2}`
**Then** at least one match is found.

---

## Non-functional requirements

### NFR-G1 — Reproducibility
- Worked code examples are self-contained and deterministic (no live network calls; synthetic event payloads inline).

### NFR-G2 — Observability
- When a coder subagent invokes this skill, it emits an OTel span with `skill.id=security/webhook-idempotency` so per-skill consultation counts are aggregable.

### NFR-G3 — Security
- Threat model: not a standalone artifact (per Prompt 3, threat models cover A, B, C, E, F).
- The skill itself contains no secrets or sensitive payload examples.

### NFR-G4 — Compliance
- Provider worked examples redact any PII fields in the synthetic payloads.

### NFR-G5 — Surgical scope
- One new directory + SKILL.md. Optionally one update to `analyzer/recommendation-rules.yml` for REQ-G6.

---

## Threat model

Not a standalone artifact. The relevant ASI mapping is recorded inside the skill itself (REQ-G8). Concretely:

- **ASI02 (Tool Misuse)** — a replayed webhook that re-triggers a destructive tool (db-mutate, deploy, charge) is the canonical idempotency-failure path; the skill teaches the defenses.

---

## Decisions

- **Universal-not-stack-specific.** The patterns (key + window + dedupe storage + storage-strategy tradeoff) are provider-agnostic. Provider-specific signature verification and event-shape parsing live in stack-specific skills (the Stripe variant is one of the nine in area D).
- **Worked examples in TypeScript and Python.** Match the two language families the analyzer detects most. Rust/Go examples are deferred until the stack-specific skill set expands.
- **Anti-patterns explicit, not implied.** AP-13 (Quick Fix Without Test) cautions against patterns the agent recognizes; explicitly listing webhook anti-patterns lets the validator subagent reject PRs that introduce them.

---

## Open questions

None blocking. The exact set of providers in the worked-example section is determined at implementation time — minimum two; the spec doesn't fix which two.

---

## Implementation plan

Step 3 atomization will likely produce: (1) author `skills/universal/security/webhook-idempotency/SKILL.md` body (~200 lines); (2) author 2 fenced worked examples (TypeScript Stripe + Python FastAPI/GitHub); (3) extend `analyzer/recommendation-rules.yml` with webhook-indicator rules; (4) write fixture for AC-G6.1; (5) update `docs/SECURITY.md` to reference this skill in the "Skills" section.

## Test plan

| REQ   | AC(s)   | Phase-2-impl claim ID (provisional) |
| ----- | ------- | ----------------------------------- |
| REQ-G1 | AC-G1.1 | (Phase 2 implementation) |
| REQ-G2 | AC-G2.1 | (Phase 2 implementation) |
| REQ-G3 | AC-G3.1 | (Phase 2 implementation) |
| REQ-G4 | AC-G4.1 | (Phase 2 implementation) |
| REQ-G5 | AC-G5.1 | (Phase 2 implementation) |
| REQ-G6 | AC-G6.1 | (Phase 2 implementation) |
| REQ-G7 | AC-G7.1 | (Phase 2 implementation) |
| REQ-G8 | AC-G8.1 | (Phase 2 implementation) |

The Phase 2 spec-authoring claim for this spec is `claim-2026-05-22-023`.

---

## Change log

- 2026-05-22 miltonadina: created (Phase 2 Step 1; Prompt 3 area G; closes GAP_61_COVERAGE_MATRIX gap #47).
