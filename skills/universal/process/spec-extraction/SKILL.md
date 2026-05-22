---
name: spec-extraction
description: Convert a user's prose requirements into EARS-formatted specifications under /specs/. Use whenever the user describes new functionality, requirements, or a feature without an existing spec. Required first step for any non-trivial implementation - no spec, no work. Triggers on phrases like "add feature X", "build a Y", "we need to do Z", "the system should...".
---

# Spec Extraction

> Implements Principle 8 of the DevOPs Constitution.
> Every commit must trace to a spec section. This skill produces those specs.

**Tradeoff:** Upfront design time before code. Worth it: LLMs without specs
generate vulnerable code 9.8-42.1% of the time (multiple 2025-2026 benchmarks).

---

## When to invoke

The user has described a desired behavior but there's no corresponding section
in `/specs/`. Either:

- The project has no `/specs/` directory (initialize it)
- The user is adding a new feature (new spec section)
- The user is changing existing behavior (update existing spec first)

---

## Process

1. **Read the user's request carefully.** Identify the system, the actors, the
   data, the triggers, and the success criteria.

2. **Choose the spec file.** Specs are organized by domain:
   `specs/auth/`, `specs/billing/`, `specs/api/`, etc. Pick the right home or
   propose a new file.

3. **Write requirements in EARS notation** (see `docs/EARS_GUIDE.md` for full
   reference). Five patterns:

   - **Ubiquitous**: `THE SYSTEM SHALL <action>`
   - **Event-driven**: `WHEN <event>, THE SYSTEM SHALL <action>`
   - **State-driven**: `WHILE <state>, THE SYSTEM SHALL <action>`
   - **Unwanted behavior**: `IF <condition>, THEN THE SYSTEM SHALL <action>`
   - **Optional**: `WHERE <feature is present>, THE SYSTEM SHALL <action>`

4. **Add acceptance criteria** (numbered, testable, one assertion each).

5. **Add non-functional requirements** (NFR-1, NFR-2…) for performance,
   security, accessibility, compliance.

6. **Confirm the spec with the user before implementation.**

---

## Spec template

Use `templates/ears-spec/SPEC_TEMPLATE.md` as the starting structure:

```markdown
# <Feature name>

**Spec ID**: <domain>/<feature>
**Status**: draft | approved | implemented | deprecated
**Last updated**: YYYY-MM-DD
**Owner**: <user>

## Context

<2-3 sentence explanation of why this exists>

## Actors and data

- Actors: <list>
- Data classes touched: <PII | PHI | PCI | financial | children's data | none>
- Compliance scope: <COPPA | GDPR | HIPAA | SOC 2 | PCI DSS | none>

## Functional requirements (EARS)

### REQ-1 (Ubiquitous)
THE SYSTEM SHALL store passwords using Argon2id with work factor >= 3.

### REQ-2 (Event-driven)
WHEN a user submits a valid email on the password reset form,
THE SYSTEM SHALL send a one-time reset link valid for 30 minutes.

### REQ-3 (State-driven)
WHILE a reset link is unused and unexpired,
THE SYSTEM SHALL allow exactly one password change before invalidating the link.

### REQ-4 (Unwanted behavior)
IF the password is entered incorrectly 5 times within 15 minutes,
THEN THE SYSTEM SHALL lock the account for 30 minutes and notify the owner by email.

### REQ-5 (Optional)
WHERE 2FA is enabled for the account,
THE SYSTEM SHALL require a valid TOTP code before allowing password reset.

## Acceptance criteria

- **AC-1**: Passwords stored with Argon2id verified by reading the hash prefix
- **AC-2**: Reset link expires at exactly 30 minutes (within ±5 second tolerance)
- **AC-3**: Second password change attempt on the same link returns 410 Gone
- **AC-4**: 6th failed attempt within 15 minutes returns 423 Locked + sends lockout email
- **AC-5**: With 2FA on, reset requires TOTP, returns 401 without

## Non-functional requirements

- **NFR-1**: Password hash check completes within 200ms (p95) on m5.large
- **NFR-2**: All endpoints log to OTel with `user_id` and `tenant_id` in baggage, PII redacted
- **NFR-3**: WCAG 2.2 AA compliance for the reset form

## Threat model reference

See `docs/threat-models/auth-password-reset.md` for STRIDE + OWASP ASI 2026 analysis.

## Decisions

- Argon2id chosen over bcrypt: see `docs/decisions/ADR-0012-password-hashing.md`
```

---

## Quality checks before approval

- [ ] Every REQ is in one of the 5 EARS patterns (no free-form prose)
- [ ] Every REQ is testable (you can write a test that proves or disproves it)
- [ ] Every AC corresponds to at least one REQ
- [ ] NFRs include performance, security, accessibility, compliance
- [ ] Threat model is linked (write one if missing — invoke `owasp-asi-threat-model`)
- [ ] Decisions are linked (write ADRs for non-obvious choices)

---

## Anti-patterns

**Spec sprawl**: don't write 50 pages. EARS is concise by design. A typical
feature spec is 1-3 pages.

**Implementation in the spec**: specs say WHAT, not HOW. "Use Redis with TTL"
is implementation; "expire after 30 minutes" is spec.

**Untestable requirements**: "be fast", "be secure", "be user-friendly". Make
each one measurable: "p95 latency < 200ms", "OWASP ASI 2026 ASI01 mitigated",
"WCAG 2.2 AA compliant per axe-core scan".

---

**This skill is working when:** every implementation PR cites a spec section,
and the spec is updated before the implementation, not after. Track in
`governance/telemetry/spec-trace-rate.jsonl`. Target: 100%.
