---
name: goal-loop
description: Execute the spec-tests-implement-verify cycle for one atomic task at a time. Use after plan-decomposition has produced a task list. This is the workhorse loop - the agent implements, runs tests, reflects on failure, retries with bounded iteration. Halts mechanically when budget, iteration count, or scratchpad stasis ceilings hit. See constitution/LOOP.md for full protocol.
---

# Goal Loop

> The execution engine for spec-anchored work. Implements the loop in
> `constitution/LOOP.md`.

**Tradeoff:** Single-task focus is slower than batch implementation. Worth it:
each iteration is verifiable, failures are bounded, and partial progress is
durable.

---

## When to invoke

After:
- Spec is approved
- Plan exists at `.workflow/state/plans/<spec-id>.md`
- A specific task `T-NNN` is the current focus

Per task. Not per session. One task ≠ one session necessarily.

---

## Protocol (see constitution/LOOP.md for full diagram)

```
1. Load task T-NNN. Read AC mapping. Read related code via researcher subagent.
2. Write failing test(s). Confirm they fail.
3. Implement minimum change to make test pass.
4. Run verification command.
   - PASS: emit proof-of-work, mark task complete, move to next.
   - FAIL: write reflection (specific test names + error messages),
           retry with different approach, increment iteration count.
5. If iteration count >= N (default 5): write blocker, halt.
6. If budget cap hit: halt (budget-brake hook fires).
7. If loop-detection fires: halt.
8. If scratchpad-stasis fires: halt.
```

---

## Reflection requirements

The reflection step is not optional. Before retrying, write to
`.workflow/state/loop-<task-id>.jsonl`:

```json
{
  "iteration": 3,
  "timestamp": "2026-05-22T10:42:13Z",
  "action_taken": "<what was just done>",
  "verification_command": "<command>",
  "exit_code": <code>,
  "failing_tests": ["test name 1", "test name 2"],
  "error_messages": ["actual error from output"],
  "reflection": "<specific hypothesis about why it failed>",
  "next_action": "<concrete next change>"
}
```

A reflection that says "try again with different approach" without specifics
is a constitution violation.

---

## Exit conditions

### Success
- All tests for the task pass
- No regression in other tests
- Lint, type check, format all clean
- Emit proof-of-work artifact
- Move to next task or write baton

### Bounded failure (blocker)
- Iteration count exceeded → write blocker, halt
- Budget cap hit → write blocker, halt
- Loop detected → write blocker, halt
- User intervention required → write open question, halt

NEVER:
- Skip the test
- Mark task complete without proof
- Modify acceptance tests during the loop
- Lower the spec to match the code

---

## Anti-patterns

**Test deletion**: if a test is "wrong," update the spec first, then regenerate
the test. Never edit tests mid-loop.

**Spec mutation**: if the spec is unclear, halt with a blocker. Don't reinterpret
mid-implementation.

**Success masking**: if the test command returned non-zero, the test did not
pass. Period. The claim-validator will catch you anyway.

**Hidden context**: every iteration must reference specific failing tests and
error messages. No vague reflections.

---

**This skill is working when:** sessions reach `done` state through verification
rather than assertion. Track verified_done / claimed_done ratio in
`governance/telemetry/done-ratio.jsonl`. Target: > 0.95.
