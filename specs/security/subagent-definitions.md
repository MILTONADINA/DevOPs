# Reviewer and security subagent definitions

**Spec ID**: security/subagent-definitions
**Status**: implemented
**Last updated**: 2026-10-18

## Scope and authority

Issue #269. The published `subagents/universal/reviewer.md` and `security.md`
were applied as read-only agents to a real change in an unrelated project and
left gaps. This spec covers the text of those two definitions only; it adds no
runtime behavior.

## REQ-1 — Reviewer regression and per-branch checks

**Enforced by:** test:tests/subagent-definitions.test.mjs
THE reviewer definition SHALL require a regression check of every new guard,
early exit, retry or stop rule against the existing specs whose flows it
crosses, and SHALL require spec anchoring and test coverage per new branch,
not only per file.

## REQ-2 — Reviewer tracing, privacy and cost checks

**Enforced by:** test:tests/subagent-definitions.test.mjs
THE reviewer definition SHALL phrase the observability check in terms of the
project's trace primitive (spans, structured events or logs), SHALL require a
new outbound-data path to enforce the same gates as the existing path that
sends similar data, and SHALL count paid calls whose output nothing consumes
under the performance and cost check.

## REQ-3 — Reviewer evidence and verdicts

**Enforced by:** test:tests/subagent-definitions.test.mjs
THE reviewer definition SHALL require file:line, inputs and state, and the
wrong outcome for a Blocker, and SHALL allow a per-check "Not applicable"
verdict.

## REQ-4 — Security offline mode

**Enforced by:** test:tests/subagent-definitions.test.mjs
WHERE the network is not allowed, THE security definition SHALL direct the
agent to vendored or pinned local rules, `--metrics=off` and a disabled version
check, and SHALL require reporting any scanner's network or home-directory side
effects.

## REQ-5 — Security language-model checklist and flag injection

**Enforced by:** test:tests/subagent-definitions.test.mjs
THE security definition SHALL include a checklist for code that calls language
models (data reaching each provider kind, consent or export policy re-checked at
each use, model output persisted into future prompts) and SHALL list flag
injection next to shell injection.

## REQ-6 — Host project evidence

**Enforced by:** test:tests/subagent-definitions.test.mjs
WHERE the host project does not use DevOps, THE security definition SHALL accept
the host project's evidence format in place of the claim YAML and SHALL name the
project owner, not the subagent, as the party who may block a merge.

## Acceptance criteria

### AC-1 (REQ-1, REQ-2, REQ-3)
WHEN the reviewer definition is read, THE test SHALL find the regression,
privacy parity, per-branch, trace-primitive, unconsumed-paid-call, evidence and
"Not applicable" text.

### AC-2 (REQ-4, REQ-5, REQ-6)
WHEN the security definition is read, THE test SHALL find the offline mode,
language-model, flag injection and host-evidence sections.
