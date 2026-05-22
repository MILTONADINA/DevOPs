---
name: ears-spec-writing
description: Write requirement specifications in EARS (Easy Approach to Requirements Syntax) notation. Use whenever authoring or editing files in /specs/, converting prose requirements into structured form, or reviewing existing specs for ambiguity. EARS uses five sentence patterns to produce unambiguous, testable, machine-readable requirements. Used by NASA, Airbus, Rolls-Royce, and Amazon Kiro IDE.
---

# EARS Spec Writing

> Five sentence patterns. Zero ambiguity. Both humans and LLMs read them the same way.

**Tradeoff:** EARS feels formal compared to free prose. Worth it: the LLM cannot
"interpret" an EARS clause — there's nothing to interpret. Specs become tests.

---

## The five patterns

### 1. Ubiquitous (always-true requirements)

```
THE SYSTEM SHALL <action>.
```

Example:
> THE SYSTEM SHALL store all passwords using Argon2id with a work factor of at least 3.

### 2. Event-driven (response to an external trigger)

```
WHEN <trigger>, THE SYSTEM SHALL <action>.
```

Example:
> WHEN a user submits a valid email on the password reset form,
> THE SYSTEM SHALL send a one-time reset link valid for 30 minutes.

### 3. State-driven (behavior conditional on system state)

```
WHILE <state>, THE SYSTEM SHALL <action>.
```

Example:
> WHILE a reset link is unused and unexpired,
> THE SYSTEM SHALL allow exactly one password change before invalidating the link.

### 4. Unwanted behavior (handle the bad path explicitly)

```
IF <undesirable condition>, THEN THE SYSTEM SHALL <action>.
```

Example:
> IF a password is entered incorrectly 5 times within 15 minutes,
> THEN THE SYSTEM SHALL lock the account for 30 minutes and email the owner.

### 5. Optional features (conditional on feature presence)

```
WHERE <feature is present>, THE SYSTEM SHALL <action>.
```

Example:
> WHERE 2FA is enabled for the account,
> THE SYSTEM SHALL require a valid TOTP code before completing password reset.

### Complex (combinations, used sparingly)

```
WHEN <trigger>, IF <condition>, THEN THE SYSTEM SHALL <action>.
```

Example:
> WHEN the user clicks the reset link, IF the link has not been used and has not
> expired, THEN THE SYSTEM SHALL render the new-password form.

Use complex sparingly — most requirements decompose into 2-3 simple ones.

---

## Rules

1. **Use SHALL, not "must" / "should" / "may"**. SHALL is the requirement
   keyword. Other words signal preference, not requirement.

2. **One requirement per sentence**. If you say "and," it's probably two
   requirements.

3. **Quantify everything possible**. "Fast" is not a requirement. "Within 200ms
   p95 latency" is.

4. **Subject is always THE SYSTEM** (or a named subsystem like THE PAYMENT
   SERVICE). Not "the user does X."

5. **Number requirements**: REQ-001, REQ-002, … so you can reference them in
   tests, ADRs, and PRs.

---

## Anti-patterns

### "Should" instead of "shall"
> ❌ The system should validate email addresses.
> ✓ THE SYSTEM SHALL validate email addresses against RFC 5321 format.

### Implementation in the spec
> ❌ The system shall use Redis to cache the reset link with TTL=1800.
> ✓ THE SYSTEM SHALL invalidate the reset link 30 minutes after issuance.

(How you implement the 30-minute expiry is up to the engineer; the spec says
behavior, not technology.)

### Untestable requirement
> ❌ The system shall be user-friendly.
> ✓ WHEN a user enters an invalid email,
>   THE SYSTEM SHALL display an inline error message within 200ms identifying the specific format issue.

### Multiple requirements bundled
> ❌ The system shall validate emails, hash passwords with Argon2id, and rate-limit logins.
> ✓ Three separate REQs.

---

## Acceptance criteria from EARS

Each REQ should produce one or more numbered acceptance criteria:

```
REQ-3 (state-driven): WHILE a reset link is unused and unexpired,
THE SYSTEM SHALL allow exactly one password change before invalidating the link.

AC-3.1: Given a fresh reset link, when the user submits a new password,
        then the server responds 200 and the password is updated.

AC-3.2: Given a fresh reset link, when the user submits a new password twice
        with the same link, then the second response is 410 Gone.

AC-3.3: Given an expired reset link, when the user submits a new password,
        then the server responds 410 Gone.
```

Tests are derived directly from ACs. The relationship REQ → AC → test is the
traceability chain. The claim-validator follows this chain backwards on every
PR.

---

## Tool integration

- Amazon Kiro generates EARS automatically from natural language descriptions.
- GitHub spec-kit (formerly Spec Kit) accepts EARS as the canonical format.
- The `spec-extraction` skill in DevOPs produces EARS by default.

---

## Quick reference card

| Pattern | Form | Use for |
|---------|------|---------|
| Ubiquitous | `THE SYSTEM SHALL ...` | Always-true invariants |
| Event-driven | `WHEN <event>, THE SYSTEM SHALL ...` | Response to triggers |
| State-driven | `WHILE <state>, THE SYSTEM SHALL ...` | State-dependent behavior |
| Unwanted | `IF <condition>, THEN THE SYSTEM SHALL ...` | Error/edge handling |
| Optional | `WHERE <feature>, THE SYSTEM SHALL ...` | Conditional features |

---

**This skill is working when:** every `/specs/` file is parseable by the EARS
linter, and acceptance tests can be auto-generated from REQs.

## References

- Mavin, A. et al. "Easy Approach to Requirements Syntax (EARS)" RE'09
- "Ten Years of EARS" — IEEE Software, 2019
- Amazon Kiro documentation on spec-driven development
- GitHub spec-kit (issue #1356 — EARS integration)
