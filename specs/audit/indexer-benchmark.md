# Git indexer performance gate

**Scope:** `plan.md` §5a, v0.6 audit ship preparation.

## REQ-1 — Repeatable local measurement

WHEN an operator runs `npm run bench:audit-indexer` from `stratum/`, THE
SYSTEM SHALL index the latest 100 commits using the production
`indexRepository` path and report the commit count, declaration-change count,
sample timings, and p95 latency in milliseconds.

## REQ-2 — Honest gate

IF the checkout contains fewer than 100 commits, or no declaration changes
are indexed, THE SYSTEM SHALL fail without reporting a passing latency gate.
IF p95 latency reaches or exceeds 5,000 ms, THE SYSTEM SHALL fail. A local
pass SHALL be labeled as local evidence, not a deployed release measurement.

## Acceptance criteria

- **AC-1:** the command reports five timed samples of the real indexer and
  exits zero only when the target is met on a complete checkout.
- **AC-2:** a missing Git history or indexer error yields a nonzero exit.
