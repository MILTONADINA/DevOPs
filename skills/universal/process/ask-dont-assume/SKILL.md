---
name: ask-dont-assume
description: Surface ambiguity as explicit blockers instead of silently picking an interpretation. Use whenever a request contains undefined values, unstated scope, or competing interpretations. Critical for non-trivial work - silent assumptions cause 31.6% of agent failures (Context Blindness). Triggers on vague requests, missing acceptance criteria, or requests that conflict with prior decisions.
---

# Ask, Don't Assume

> Counters Context Blindness — the #1 failure mode (31.6%) across 591
> documented agent incidents.

**Tradeoff:** Adds clarification turns before implementation. Worth it: zero
silent assumptions, zero wasted implementation cycles on the wrong thing.

---

## When to invoke

Any time you spot:

- **Undefined values** — "add rate limiting" (what value? what scope?)
- **Unstated scope** — "fix the auth bug" (which one? all of them?)
- **Competing interpretations** — request matches multiple existing patterns
- **Conflict with prior decisions** — spec says X, request implies Y
- **Missing acceptance criteria** — "make it work" / "improve performance"
- **Non-obvious tradeoffs** — performance vs. consistency, speed vs. quality
- **Privacy/compliance touchpoints** — new data collection, new endpoints,
  new dependencies that handle PII/PHI/PCI

---

## How to ask well

1. **State what you understood.** Show the user you read carefully.
2. **List the interpretations.** Number them.
3. **State your recommendation.** With rationale.
4. **Ask one specific question per ambiguity.** Don't bury the ask in prose.

---

## Example (good)

> The request says "add rate limiting to the API." Before implementing, I need
> to clarify:
>
> 1. **Rate limit value**: 60 req/min? Higher? Different per endpoint?
> 2. **Scope**: Per-IP, per-user-ID, per-API-key?
> 3. **Endpoints**: All endpoints, only `/api/public/*`, or specific routes?
> 4. **Enforcement**: Return 429, queue, or silently drop?
> 5. **Storage**: In-memory, Redis, database?
>
> **My recommendation**: 100 req/min per-API-key on `/api/public/*` returning
> 429, backed by Redis. This handles the common abuse case while not affecting
> internal services.
>
> Proceed with that, or adjust?

---

## Example (bad — what NOT to do)

> Sure, I'll add rate limiting to all endpoints at 60 req/min.

[Picks one interpretation, hides the others, ships the wrong thing.]

---

## Writing the blocker

If the user is not available right now, write the question to
`.workflow/state/blockers.md` and STOP:

```markdown
## Blocker [2026-05-22T11:14:02Z] — clarification needed

**Task**: add-api-rate-limiting (T-022)
**Spec**: not yet written — request arrived without spec

**Question**: rate limiting parameters are undefined. Pick one of:
1. ...
2. ...

**My recommendation**: option 2 (100 req/min per-API-key, Redis backend).

**Cannot proceed without**: explicit answer in next session, or spec update at
`specs/api/rate-limiting.md`.
```

Then halt. Do not implement on guess.

---

## When NOT to ask

- The work is trivial (typo fix, comment update, single-character change).
- The spec explicitly defines the interpretation.
- A documented project convention covers it (in `decisions.md` or `ADR-NNNN`).
- The user has already answered this exact question this session.

---

## Anti-pattern: rapid-fire clarification

Don't ask 14 questions before doing anything. Cluster related questions, ask
the most important 1-3, propose defaults for the rest:

> Three things I need to confirm:
> 1. [key question]
> 2. [key question]
> 3. [key question]
>
> For everything else, I'll proceed with these defaults: [list]. Object if any
> are wrong.

---

**This skill is working when:** clarifying questions arrive before
implementation, not after rewrite. Track in
`governance/telemetry/clarifications.jsonl`. Pre-implementation clarification
ratio should rise; post-implementation rework should fall.
