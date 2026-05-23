# Phase 2 / Area G — Universal Webhook Idempotency Skill — Implementation Plan

**Plan ID**: phase-2-G-plan
**Spec**: specs/phase-2/G-webhook-idempotency.md
**Threat model**: N/A — teaching content, no new attack surface (per Prompt 3; the ASI mapping is inline in the skill per REQ-G8)
**Status**: draft (Step 3 — awaiting approval before Step 4)
**Last updated**: 2026-05-23
**Owner**: miltonadina

---

## Carry-forwards from Step 1 + Step 2

- Spec G's intentional universal-not-stack-specific framing is preserved: provider-agnostic patterns here; provider-specific signature verification + event-shape parsing lives in stack-specific area D (the Stripe variant is plan D task D.04).
- ASI02 (Tool Misuse) is the canonical threat path — a replayed webhook re-triggers a destructive tool. Mapping recorded inline per REQ-G8.

## Task list

### Task G.01 — Author skeleton `skills/universal/security/webhook-idempotency/SKILL.md` with frontmatter
**REQ**: REQ-G1
**AC**: AC-G1.1
**Type**: implementation
**Effort**: ~20 min
**Depends on**: (none)
**Success criterion**: File exists at the documented path with valid YAML frontmatter (`name`, `description` non-empty). AC-G1.1 passes.

### Task G.02 — Author "Idempotency key" section
**REQ**: REQ-G2
**AC**: AC-G2.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: G.01
**Success criterion**: Skill body contains an H2 or H3 section titled `Idempotency key` (or close variant) explaining how the provider assigns a stable id per event (`event.id`, `delivery_id`) and how the receiver persists processed-ids to refuse duplicate work. Case-insensitive "idempotency" appears ≥ 4 times. AC-G2.1 passes.

### Task G.03 — Author "Replay window" section
**REQ**: REQ-G3
**AC**: AC-G3.1
**Type**: implementation
**Effort**: ~20 min
**Depends on**: G.01
**Success criterion**: Section explains rejecting events whose timestamp is older than a configurable window with a concrete duration recommendation (e.g., "5 minutes" or "300 seconds"). Word "replay" appears ≥ 2 times. AC-G3.1 passes.

### Task G.04 — Author "Storage strategies" section
**REQ**: REQ-G4
**AC**: AC-G4.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: G.01
**Success criterion**: Section compares ≥ 3 storage strategies (Redis with TTL, database unique constraint, in-memory LRU for low-volume) each with an explicit "fails when" caveat (Redis: TTL eviction during outage; DB: write contention at high throughput; in-memory: lost on process restart). AC-G4.1 passes.

### Task G.05 — Author ≥ 2 worked code examples (TypeScript Stripe + Python FastAPI/GitHub)
**REQ**: REQ-G5
**AC**: AC-G5.1
**Type**: implementation
**Effort**: ~45 min
**Depends on**: G.02, G.03, G.04
**Success criterion**: ≥ 2 fenced code blocks referencing distinct provider patterns. Examples are self-contained, deterministic (no live network), and illustrate both the idempotency-key and replay-window patterns. PII redacted in any synthetic payloads. AC-G5.1 passes.

### Task G.06 — Author "Anti-patterns" section
**REQ**: REQ-G7
**AC**: AC-G7.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: G.01
**Success criterion**: Section enumerates ≥ 3 anti-patterns as numbered or H3-headed entries, each with a one-line failure-mode description: (i) body-hash key (changes on legitimate retries), (ii) in-memory dedupe (lost on restart), (iii) silent re-process on store failure (safety net becomes failure vector). AC-G7.1 passes.

### Task G.07 — Add ASI threat mapping (REQ-G8)
**REQ**: REQ-G8
**AC**: AC-G8.1
**Type**: implementation
**Effort**: ~15 min
**Depends on**: G.02, G.03, G.04, G.05, G.06
**Success criterion**: Skill body references ≥ 1 `ASI\d{2}` identifier from `governance/owasp-asi-2026/threats.md` — at minimum ASI02 (Tool Misuse). Mapping is materially substantiated by the surrounding content (not decorative). AC-G8.1 passes.

### Task G.08 — Extend `analyzer/recommendation-rules.yml` with webhook-indicator rules
**REQ**: REQ-G6
**AC**: AC-G6.1
**Type**: implementation
**Effort**: ~30 min
**Depends on**: G.01
**Success criterion**: Rules detect webhook-handler indicators: route matching `/webhook(s)?`, import of a provider SDK with webhook helpers (`@stripe/stripe-js`, `@octokit/webhooks`, etc.), `Stripe-Signature` or `X-Hub-Signature-256` header reference in source. Detection emits `security/webhook-idempotency` in `recommended.skills`.

### Task G.09 — Author analyzer fixture
**REQ**: REQ-G6
**AC**: AC-G6.1
**Type**: test
**Effort**: ~20 min
**Depends on**: G.08
**Success criterion**: Fixture at `tests/fixtures/analyzer/webhook-project/` contains a minimal Express/Fastify route handler at `/api/webhook/stripe`. `node analyzer/scan.ts` against the fixture emits `recommended.skills` including `security/webhook-idempotency`. AC-G6.1 passes.

### Task G.10 — Update `docs/SECURITY.md` to reference this skill
**REQ**: cross-reference completeness
**AC**: structural — link present
**Type**: docs
**Effort**: ~20 min
**Depends on**: G.07
**Success criterion**: `docs/SECURITY.md` "Skills" section (or equivalent) lists `security/webhook-idempotency` with a brief one-line summary and a link to the SKILL.md.

### Task G.11 — Security-review: NFR-G1 + NFR-G4 verification
**REQ**: NFR-G1 (reproducibility — no live network), NFR-G4 (PII redaction in synthetic payloads)
**AC**: prerequisite for Phase 4 sign-off
**Type**: security-review
**Effort**: ~20 min
**Depends on**: G.05
**Success criterion**: Worked examples (G.05) contain no live network calls (no real `fetch`, `axios.get` to remote hosts; only synthetic event payloads inline). PII fields in synthetic payloads are redacted (`email: "redacted@example.test"`, `name: "REDACTED"`, etc.). Review checklist signed.

### Task G.12 — Emit per-REQ Phase 4 implementation claims (G1–G8)
**REQ**: meta — consolidates Step 4 claim emission for area G
**AC**: all G ACs reproducible via `npm run validate:claims`
**Type**: test
**Effort**: ~30 min
**Depends on**: G.01 – G.11
**Success criterion**: 8 new claim YAML files (one per REQ-G1 through REQ-G8) all valid per the claim-validator's re-run check.

## Dependency graph

```
G.01 (skeleton) ─┬─► G.02 (idempotency-key) ──┐
                 ├─► G.03 (replay-window)     ├─► G.05 (worked examples) ─► G.11 (sec-review)
                 ├─► G.04 (storage strategies)┤
                 ├─► G.06 (anti-patterns) ────┘
                 ├─► G.07 (ASI mapping) ───────► G.10 (docs link)
                 └─► G.08 (analyzer rules) ───► G.09 (fixture)
                                                              │
                                                              ▼
                                                          G.12 (test — emit claims)
```

G.02/G.03/G.04/G.06 are parallelisable (independent section authorship). G.05 (worked examples) depends on the conceptual scaffolding being in place. G.07 (ASI mapping) is the integration glue.

## Total effort estimate

- Implementation tasks (G.01–G.08): ~3.75 hours
- Test/fixture tasks (G.09, G.12): ~0.83 hours
- Security-review task (G.11): ~0.33 hours
- Docs task (G.10): ~0.33 hours
- **Grand total: ~4.0–4.5 hours of Step 4 implementation work for area G.**

## Out of scope for this plan

- Stripe-specific webhook idempotency — plan D task D.04.
- Runtime middleware / library that implements idempotency for a given application — this is a teaching skill, not a runtime artifact.
- Webhook signature verification (HMAC validation) — separate concern; mentioned briefly but not the primary subject of area G.
- Reactive replay-attack detection at content level — area C (prompt-injection-defense). G covers control-flow-level replays only.

## Change log

- 2026-05-23 miltonadina: created (Phase 2 Step 3; Prompt 3 area G plan decomposition).
