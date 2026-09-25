---
name: session-summary
description: Generate the end-of-session human-reviewable report. Use at session end before writing the baton. Aggregates all verified claims, lists open blockers, links proofs, and surfaces low-confidence items for human review. Required for any session that produced verifiable work.
---

# Session Summary

> The human-readable digest of a session's work. Produced before baton handoff.

**Tradeoff:** Extra session-end output. Worth it: humans can review and approve
a session's work in 2 minutes instead of re-reading the entire transcript.

---

## When to invoke

- At session end (before `write-baton.sh` runs)
- When the user types `/session-summary`
- Before any merge to a shared branch

---

## Output format

Write to `.workflow/state/session-summary.md`:

```markdown
# Session Summary — <session_id>

**Duration**: <start> → <end>
**Tool**: <Claude Code | Codex | Cursor | ...>
**Lifecycle**: <discovery | design | build | harden | launch | operate | evolve>
**Mode**: <greenfield | brownfield | migration | hotfix | refactor | debug-prod | audit>

---

## Tasks completed (verified)

| Task | Spec ref | Claim ID | Confidence | Test exit |
|------|----------|----------|------------|-----------|
| T-014 | specs/auth/tokens.md#ac-3 | claim-2026-05-22-018 | high | 0 |
| T-015 | specs/auth/tokens.md#ac-4 | claim-2026-05-22-019 | high | 0 |
| T-016 | specs/auth/tokens.md#ac-5 | claim-2026-05-22-020 | medium | 0 |

---

## ⚠ Low-confidence items (require human review)

- claim-2026-05-22-020 (T-016): expiry test passes but uses fake timers.
  Real-clock verification recommended in staging.

---

## 🚧 Open blockers

(none)

OR

1. **AC-7 ambiguity** — should refresh tokens be invalidated on password change?
   Need spec clarification. See `.workflow/state/blockers.md`.

---

## Files modified

- `src/auth/refresh.ts` (added expiry handling)
- `src/auth/refresh.test.ts` (added 3 tests)
- `specs/auth/tokens.md` (updated AC-3 wording with user approval)

---

## Cost

- LLM spend: $X.XX from `.workflow/state/budget-ledger.jsonl`, or "not
  measured" when that ledger does not exist
- Per-model and per-subagent breakdown: from the same ledger, when it has them

---

## Next session

The baton at `.workflow/state/baton.md` contains the literal `next_action`.
The next agent should read it first.

---

## Constitution adherence

<!-- One line per check: ✓ or ✗ with the evidence (validator output, ledger
     total, file). Write "not measured" when nothing this session produced
     evidence for the check. -->

- Spec-anchoring: <✓/✗ + evidence, or not measured>
- Verified claims: <✓/✗ + validator result, e.g. 3/3>
- Surgical edits: <✓/✗ + evidence, or not measured>
- Budget: <✓/✗ + ledger total, or not measured>
- Loop detection: <✓/✗ + evidence, or not measured>
- Client boundary: <✓/✗ + evidence, or not measured>
```

---

## Verification before signing

Before marking the session "complete":

1. Run `claim-validator` on all proofs. Confirm 100% pass.
2. Check blockers file. If any are unresolved AND the session changed code that
   touches them, flag it.
3. Recompute the cost from `.workflow/state/budget-ledger.jsonl` if it exists;
   otherwise report cost as not measured (that is not a failed check).
4. Confirm each change this session traces to a spec section. No tool computes
   a spec-trace rate, so check the diff against the specs you worked from.

If any check fails, the summary is marked **not safe to merge** and the agent
must escalate to the user.

---

**This skill is working when:** humans approve sessions in < 2 minutes based on
the summary, without re-reading the transcript.
