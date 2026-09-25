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

One 2025 study found that 9.8-42.1% of code from eight LLMs under plain
prompts contained a vulnerability, across two security benchmarks
([Yan et al., arXiv:2506.23034](https://arxiv.org/abs/2506.23034)). That study
did not test EARS. EARS is used here because precise requirements leave less
to interpret: it removes the "interpret it however makes sense" failure mode
by being parseable.

## See also

- Spec template: `templates/ears-spec/SPEC_TEMPLATE.md`
- Skill: `skills/universal/development/ears-spec-writing/`
- Slash command: `/ears-spec <feature>`
