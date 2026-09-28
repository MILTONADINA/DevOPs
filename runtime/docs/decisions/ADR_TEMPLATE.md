# ADR-TEMPLATE.md — Architecture Decision Record Template

Copy this file, rename it `NNNN-short-title.md` (next sequential number), and fill it in.

---

# ADR-NNNN: [Short Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context

What is the problem we are trying to solve? What constraints exist? What forces are at play?

Be specific. A vague context produces a vague decision. Include:
- The technical constraint or tradeoff
- What phase of the roadmap this decision affects
- Any relevant research, benchmarks, or prior art

## Decision

What did we decide to do?

Be precise. "Use X for Y" is better than "use X." The decision should be actionable and leave no ambiguity about what to implement.

## Consequences

What are the positive outcomes of this decision?
What does this make harder or more expensive?
What do we need to monitor to know if this decision was wrong?

## Alternatives Considered

For each rejected alternative:
- What it was
- Why it seemed appealing
- The specific reason we rejected it

Do not list alternatives you never actually considered. This section exists to document the tradeoff, not to appear thorough.

---

## Examples of Good ADR Decisions

Good: "Use time-based decay (hours) instead of turn-count decay because sessions span multiple days and turn-count decay produces inconsistent penalization across session densities."

Bad: "Use time-based decay because it's better."

Good: "Prohibit LLM summarization for memory compression because: (1) each summarization cycle is lossy, (2) summaries cannot be verified against Git history, (3) summaries confabulate with false confidence."

Bad: "Don't use summarization because it's inaccurate."

The quality of an ADR is measured by whether, six months later, a new engineer can read it and understand exactly why the decision was made and what would have to change for us to reconsider it.
