# Current decisions within one extraction batch

**Scope:** the prompt for extracting typed facts from an ordered batch of
conversation turns. This does not decide whether two separately stored facts
supersede one another.

## REQ-1 — Preserve the current assertion

WHEN later turns directly state a different value for the same named subject,
THE EXTRACTOR SHALL instruct the local model to emit only the latest current
TechDecision from that batch and omit the obsolete value from its rationale.
It SHALL keep unrelated decisions. It SHALL NOT ask the model to create a
reviewed supersession link.

## REQ-2 — Keep FunctionChange tied to code

WHEN the input mentions layout, typography, or other non-code work, THE
EXTRACTOR SHALL instruct the model not to classify it as FunctionChange.
FunctionChange SHALL be requested only for an explicitly named code function
or method that was renamed, deprecated, or had its signature changed.

## Acceptance criteria

- A focused prompt test is red before the instruction and green afterward.
- A real local-model probe on three unchanged stale-update cases emits the
  current TechDecision without the obsolete value or spurious FunctionChange;
  a named code-function rename still emits FunctionChange.
- The commercial local-model request, typed-fact validation, typecheck, and
  current request behavior continue to pass. This does not create reviewed
  supersession or satisfy the full Tier-C/pruning release gate.
