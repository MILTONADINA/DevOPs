# Reviewed TechDecision supersession

**Scope:** `plan.md` §3c/§4 fact integrity and recall. SessionStart already
honors explicit newer same-project `TechDecision.supersedes_id` links, but no
trusted write path records why a link is valid. A matching domain or model
output alone cannot establish that one decision replaced another.

## REQ-1 — Record a reviewed replacement

WHEN the trusted service records that decision B replaces decision A, THE
DATABASE SHALL require B and A to be distinct active decisions in the exact
same organization and project, with B created later. The write SHALL include a
nonempty reviewer identity, a concrete evidence statement, and a review time.
The link and review fields SHALL be immutable after creation. One older
decision SHALL have at most one direct successor. The callable review operation
SHALL be available only to the service role. Model-extracted facts SHALL NOT
set these fields.

## REQ-2 — Preserve the reviewed link during recovery

WHEN an organization backup contains a reviewed supersession, THE RESTORE
WORKFLOW SHALL validate its referenced decision and review fields before any
write, including exact project, active state, newer creation time, and one
successor per old decision. It SHALL insert decision rows without forward
links, then restore the link and its original review metadata after both
decisions exist. It SHALL reject legacy unreviewed links rather than silently
presenting them as reviewed.

## Acceptance criteria

- Focused restore tests fail before implementation and pass afterward for
  reviewed forward links and missing review metadata.
- A rolled-back local PostgreSQL fixture verifies a valid link and rejects
  cross-organization, cross-project, self, older/equal-time, suppressed,
  duplicate-successor, mutation, and anonymous role cases.
- Typecheck and the existing restore tests pass. Request forwarding and
  pruning defaults remain unchanged.
