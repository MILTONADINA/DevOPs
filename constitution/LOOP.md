# LOOP.md — The Goal-Driven Iteration Protocol

> Karpathy's observation: *"LLMs are exceptionally good at looping until they
> meet specific goals. Don't tell it what to do, give it success criteria and
> watch it go."*
>
> This document specifies exactly how that loop runs in DevOPs.

---

## The protocol

```
┌────────────────────────────────────────────────────────────────────┐
│  spec ── derive ──► acceptance tests (written first, failing)      │
│                                                                    │
│                            ┌───────────────────────┐               │
│                            ▼                       │               │
│                     ┌─────────────┐                │               │
│                     │  IMPLEMENT  │                │               │
│                     └──────┬──────┘                │               │
│                            ▼                       │               │
│                     ┌─────────────┐                │               │
│                     │   VERIFY    │                │               │
│                     │ (run tests) │                │               │
│                     └──────┬──────┘                │               │
│                            ▼                       │               │
│                          PASS?                     │               │
│                       ┌───┴───┐                    │               │
│                      yes      no                   │               │
│                       │       │                    │               │
│                       ▼       ▼                    │               │
│                  ┌───────┐  ┌──────────────┐       │               │
│                  │ EMIT  │  │ REFLECT &    │       │               │
│                  │ PROOF │  │ RETRY (≤ N)  │───────┘               │
│                  └───┬───┘  └──────┬───────┘                       │
│                      │             │                               │
│                      │             ▼                               │
│                      │       N EXCEEDED?                           │
│                      │         ┌───┴───┐                           │
│                      │        no       yes                         │
│                      │         │        │                          │
│                      │         └────┐   ▼                          │
│                      │              │ ┌────────────────────┐       │
│                      │              │ │  WRITE BLOCKER,    │       │
│                      ▼              │ │  STOP, ASK USER    │       │
│                  ┌───────┐          │ └────────────────────┘       │
│                  │ EXIT  │          │                              │
│                  └───────┘          ▼                              │
│                              (back to IMPLEMENT)                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Inputs

The loop requires three inputs before starting:

1. **A spec** — an EARS-formatted section in `/specs/` describing the desired
   behavior unambiguously. If no spec exists, the loop refuses to start and
   invokes `spec-extraction` first.
2. **Acceptance tests** — derived from the spec, written BEFORE implementation.
   They must initially fail (otherwise the implementation already exists or
   the tests are wrong).
3. **A max iteration count `N`** — default 5. Configurable per project in
   `.workflow/state/loop-config.yml`.

---

## Iteration mechanics

### Per-iteration log

Each iteration writes a structured entry to
`.workflow/state/loop-<task-id>.jsonl`:

```json
{
  "iteration": 3,
  "timestamp": "2026-05-22T10:42:13Z",
  "action_taken": "Modified src/auth/token.ts to handle null refresh_token",
  "verification_command": "pnpm test auth/token",
  "exit_code": 1,
  "failing_tests": ["should reject null token", "should log invalid token"],
  "reflection": "Test expected 401 but got 500. Error handler missing for null case.",
  "next_action": "Add null check before token validation in line 47"
}
```

This log is the agent's working memory during the loop. It is read at the start
of each iteration to avoid repeating failed approaches.

### Hard ceilings

The loop is bounded by deterministic ceilings, enforced by hooks:

- **Iteration count**: max `N` (default 5). After N failures, the loop halts
  and writes a blocker.
- **Wall-clock time**: max 30 minutes per loop (configurable). Prevents
  multi-hour silent runaway.
- **Budget**: max `$X` per loop (configurable in `cost-controls/budget.yml`).
  Reserve-commit pattern: each iteration reserves the maximum cost before
  proceeding.
- **Tool-call repetition**: if the same tool with identical arguments is
  called > 5 times across the loop, the loop halts.
- **Scratchpad stasis**: if the loop log doesn't show meaningful state change
  across 3 iterations, the loop halts.

All five ceilings fire from `hooks/universal/` and **cannot be overridden by
the agent.**

### Reflection step (required)

Before retrying, the agent must write a reflection to the loop log:

- What was attempted
- Why it failed (specific test output, not "it didn't work")
- What will be different in the next iteration

A reflection that says "try again with different approach" without specifics
is a constitution violation (Principle 1: don't hide confusion).

---

## Exit conditions

### Exit on success

When all acceptance tests pass:

1. Emit a proof-of-work artifact (`verification/claim-schema.yml` format).
2. Add the claim to `.workflow/proofs/`.
3. Run `claim-validator` to confirm reproducibility.
4. Log the loop completion in `.workflow/state/done.md`.
5. Exit the loop.

### Exit on blocker

When N exceeded, budget exhausted, or any hard ceiling is hit:

1. Write a structured blocker to `.workflow/state/blockers.md`:

   ```markdown
   ## Blocker [auto-generated 2026-05-22T11:14:02Z]

   **Task**: refresh-token-rotation
   **Spec**: specs/auth/tokens.md#ac-3
   **Stopped at iteration**: 5 of 5
   **Reason**: Test "should reject expired token" continues to fail after 5
   attempts. Final iteration log: .workflow/state/loop-T-014.jsonl

   **What I tried**:
   - Iteration 1: Added expiry check at validation time
   - Iteration 2: Added expiry check at refresh time
   - Iteration 3: Migrated to jose library for expiry handling
   - Iteration 4: Added clock skew tolerance of 30s
   - Iteration 5: Refactored to centralized expiry checker

   **What I think is wrong**: The test expects a specific error code (4011)
   but the spec doesn't define this. The error code may be encoded in
   another spec or the test may be wrong. Need clarification.

   **What I need from you**:
   1. Confirm: should expired tokens return 401 (RFC standard) or 4011
      (custom)?
   2. If 4011, please add an EARS clause to specs/auth/tokens.md defining it.
   ```

2. Notify the user via the session summary.
3. Halt the loop. Do NOT continue with other tasks until the blocker is
   resolved or explicitly waived.

---

## Anti-cheating provisions

The loop has been observed to "cheat" in several ways. These are blocked:

### Test deletion

If the agent modifies acceptance tests during the loop (other than the initial
generation from spec), the validator flags it. Tests can only be modified via
a spec update.

### Spec mutation

The agent cannot modify `/specs/` during a loop. Spec changes require
explicit human approval and start a new loop.

### Success masking

If the agent emits a "passed" claim where the test command actually returned
non-zero, `claim-validator` re-runs the command and rejects the claim.

### Hidden context

The reflection step must reference specific failing test names and error
messages. Vague reflections ("approach didn't work") are rejected.

---

## Worked example

**Spec section** (`specs/auth/tokens.md#ac-3`):

```
THE SYSTEM SHALL reject refresh tokens that are older than 7 days.
WHEN a refresh token is presented and its issuance timestamp is more than 7
days before the current time, THE SYSTEM SHALL respond with HTTP 401 and the
error code "REFRESH_EXPIRED".
```

**Acceptance test** (written first, failing):

```typescript
test("rejects refresh token older than 7 days", async () => {
  const token = signRefreshToken({ iat: Date.now() - 8 * 86400_000 });
  const res = await request(app).post("/refresh").send({ token });
  expect(res.status).toBe(401);
  expect(res.body.error).toBe("REFRESH_EXPIRED");
});
```

**Loop iteration 1**: implement basic expiry check.

```diff
+ if (Date.now() - decoded.iat > 7 * 86400_000) {
+   return res.status(401).json({ error: "REFRESH_EXPIRED" });
+ }
```

**Verify**: `pnpm test auth/token` → exit code 0. Test passes.

**Emit proof**: `claim-2026-05-22-018.yml`:

```yaml
claim:
  id: claim-2026-05-22-018
  type: implementation
  spec_ref: specs/auth/tokens.md#ac-3
  description: Implemented 7-day expiry on refresh tokens with REFRESH_EXPIRED error code
  proof:
    git_sha: 7c4a9f
    files_changed: ["src/auth/refresh.ts", "src/auth/refresh.test.ts"]
    test_command: pnpm test auth/token
    test_exit_code: 0
    test_output_path: .workflow/proofs/claim-2026-05-22-018-test.log
  confidence: high
  reproducibility_hash: "sha256:e7a..."
```

**Exit loop. Task complete.**

---

## When NOT to use the loop

The loop is overhead for trivial tasks. Skip it for:

- Single-line edits (typos, comment fixes)
- File renames
- Pure read operations (research, code exploration without changes)

For everything else with measurable success criteria, use the loop.

---

## Implementation

The loop is implemented as:

- Skill `skills/universal/process/goal-loop/` — invoked when the agent recognizes
  a loop-shaped task
- Hook `hooks/universal/pre-tool/loop-detection.sh` — enforces hard ceilings
- Validator `verification/claim-validator.ts` — verifies exit conditions

All three must be present and active for the loop to function correctly.
