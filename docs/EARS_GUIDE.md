# EARS Guide

EARS = Easy Approach to Requirements Syntax. Used by NASA, Airbus, Rolls-Royce,
Amazon Kiro IDE, and (now) DevOPs.

See `skills/universal/development/ears-spec-writing/SKILL.md` for the active
skill that produces EARS specs.

## The five patterns

| Pattern | Form | Use for |
|---------|------|---------|
| Ubiquitous | `THE SYSTEM SHALL ...` | Always-true invariants |
| Event-driven | `WHEN <event>, THE SYSTEM SHALL ...` | Response to triggers |
| State-driven | `WHILE <state>, THE SYSTEM SHALL ...` | State-dependent behavior |
| Unwanted | `IF <condition>, THEN THE SYSTEM SHALL ...` | Error/edge handling |
| Optional | `WHERE <feature is present>, THE SYSTEM SHALL ...` | Conditional features |

## Why this matters for AI coding

Without EARS, LLMs without specs generate vulnerable code 9.8-42.1% of the
time (multiple 2025-2026 benchmarks). EARS removes the "interpret it however
makes sense" failure mode by being parseable.

## See also

- Spec template: `templates/ears-spec/SPEC_TEMPLATE.md`
- Skill: `skills/universal/development/ears-spec-writing/`
- Slash command: `/ears-spec <feature>`
