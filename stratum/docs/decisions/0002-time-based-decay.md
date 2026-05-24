# ADR-0002: Time-Based Decay (Hours) Instead of Turn-Count Decay

**Date:** 2026-04-06
**Status:** Accepted

## Context

The CQ-Extended KadaneDial algorithm adds a temporal decay factor λ to penalize stale context. The decay exponent can be computed two ways:
- **Turn-count-based:** `λ^(n - i)` where `n` is the current turn number and `i` is the turn index
- **Time-based:** `λ^((now_seconds - timestamp_i) / 3600)` — elapsed hours

## Decision

Use time-based decay in hours.

## Consequences

- Requires that every stored turn has an accurate `timestamp` in Unix milliseconds
- Decay is consistent regardless of session pacing — a 5-minute 10-turn session and a 5-day 10-turn session behave correctly and differently
- Breaks compatibility with any implementation that uses turn-count decay

## Alternatives Considered

**Turn-count-based decay:** Rejected because developer Claude Code sessions vary enormously in turn density. A developer who types slowly over three days and one who has a 10-turn conversation in 5 minutes would produce identical decay curves — which is wrong. Stale context should be penalized by actual elapsed time, not by how many other turns happened to occur.

**No decay (base DyCP behavior):** Rejected because the base algorithm has no mechanism to prefer recent context over semantically similar stale context. For developer workloads where APIs deprecate and decisions reverse, a 6-month-old turn about `getUser()` would score equally to a 10-minute-old turn about the same function. This is a hallucination vector.
