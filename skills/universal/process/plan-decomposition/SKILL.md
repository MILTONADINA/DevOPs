---
name: plan-decomposition
description: Break an approved spec into atomic, ordered, verifiable tasks before any code is written. Use after spec-extraction confirms a spec is approved and before invoking goal-loop. Each task has its own success criteria, estimated effort, and explicit dependencies. Prevents both "where do I start" paralysis and "ship-and-pray" rushes.
---

# Plan Decomposition

> The bridge between specs and implementation. Reduces a spec into atomic
> tasks the goal-loop can execute one at a time.

**Tradeoff:** Adds a planning artifact between spec and code. Worth it: each
task is independently verifiable and the dependency order prevents the
"refactor-while-implementing" antipattern.

---

## When to invoke

After:
- `spec-extraction` has produced an approved spec
- The user confirms scope
- No corresponding plan exists at `.workflow/state/plans/<spec-id>.md`

Before:
- Any code change
- `goal-loop` invocation

---

## Process

1. **Read the approved spec.** All REQs, ACs, NFRs.

2. **Identify atomic tasks.** An atomic task:
   - Has one clear success criterion
   - Can be implemented in < 1 hour
   - Has explicit dependencies (other tasks, external systems)
   - Maps to 1+ acceptance criteria

3. **Order them.** Apply these rules:
   - Schema / database changes BEFORE code that uses them
   - Tests BEFORE implementation (TDD)
   - Lowest-risk first (build confidence, fail early)
   - Foundation BEFORE features that depend on it
   - Security review tasks INTERLEAVED, not at the end

4. **Write the plan** to `.workflow/state/plans/<spec-id>.md`:

```markdown
# Plan — <spec-id>

**Spec**: <link>
**Status**: draft | approved | in-progress | complete
**Estimated total**: 4-6 hours

## Task list

### T-001: Add Argon2id dependency and verify install
- **AC mapping**: AC-1
- **Depends on**: (none)
- **Success**: `pnpm test crypto/argon` passes; produces a hash with `$argon2id$` prefix
- **Risk**: low

### T-002: Write failing tests for password hash storage
- **AC mapping**: AC-1
- **Depends on**: T-001
- **Success**: 3 new tests in `auth/password.test.ts`, all currently failing
- **Risk**: low

### T-003: Implement password hashing in user creation
- **AC mapping**: AC-1
- **Depends on**: T-002
- **Success**: Tests from T-002 pass; existing tests not broken
- **Risk**: medium (touches user creation path)

### T-004: Write failing tests for reset link expiry
- **AC mapping**: AC-2, AC-3
- **Depends on**: T-003
- **Success**: 5 new tests in `auth/reset.test.ts`, all currently failing
- **Risk**: low

[... continue for all ACs ...]

### T-NNN: Security review (interleaved at midpoint)
- **AC mapping**: NFR-2, threat model
- **Depends on**: T-003 through T-006
- **Success**: `/security-scan` clean; threat-model entries reviewed
- **Risk**: n/a (review task)
```

5. **Confirm the plan with the user.** Especially for plans with > 5 tasks.

---

## Anti-patterns

**Task: "Implement auth"**: not atomic. Break it further.

**Task without success criterion**: not verifiable. "Make the form work" is not
a task — "Form submits to POST /api/auth/reset and renders confirmation page
on 200, error message on 4xx" is.

**Front-loading risk**: putting all the hard parts at the end means failures
discovered late. Interleave risky tasks with safe ones.

**No security tasks**: security isn't a task you do at the end. It's a checkpoint
you cross multiple times. Schedule interleaved reviews.

---

**This skill is working when:** every implementation task is independently
verifiable, and the goal-loop runs one task at a time without context loss
between tasks.
