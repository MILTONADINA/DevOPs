---
name: proof-of-work
description: Produce structured proof artifacts for every completed claim. Use this skill whenever the agent claims to have implemented something, tested something, deployed something, or completed a task. Every claim must ship with proof — git SHA, files changed, test command, exit code, output tail, and a reproducibility hash. Claims without proof are rejected by the claim-validator. Triggers on any output that asserts completion.
---

# Proof of Work

> Implements Principle 5 of the DevOPs Constitution.
> Every claim about completed work ships with structured proof.

**Tradeoff:** Per-task output is ~200-500 tokens larger. Worth it: hallucination
on verifiable categories (tests, diffs, scans) drops to near-zero, and the
`claim-validator` can independently confirm every assertion.

---

## When to use

Any time you say one of:

- "I've implemented X"
- "Tests pass"
- "Deployed to staging/prod"
- "Security scan clean"
- "Migration applied"
- "Refactored Y without behavior change"
- "Performance improved by Z%"

…you MUST emit a proof artifact.

---

## How to use

1. After completing a verifiable action, write the proof artifact to
   `.workflow/proofs/<claim-id>.yml` using the schema in
   `verification/claim-schema.yml`.

2. The `claim-id` follows the format `claim-YYYY-MM-DD-NNN` where NNN is the
   next available sequence number.

3. The artifact MUST conform to this structure:

```yaml
claim:
  id: claim-2026-05-22-001
  type: implementation | test | scan | deploy | migration | refactor | perf
  spec_ref: "specs/<file>.md#<section-anchor>"
  description: "<one factual sentence, no marketing language>"
  proof:
    git_sha: "<full or short commit hash>"
    files_changed:
      - "src/auth/refresh.ts"
      - "src/auth/refresh.test.ts"
    test_command: "<the exact, runnable command>"
    test_exit_code: 0
    test_output_path: ".workflow/proofs/claim-2026-05-22-001-test.log"
    duration_ms: 4271
  confidence: high | medium | low
  reproducibility_hash: "sha256:<hash of (test_command + env + git_sha)>"
  caveats: |
    Optional. State any conditions where the proof might not reproduce
    (flaky test, network dependency, time-of-day sensitivity).
```

4. Save the full test output (stdout + stderr) at `test_output_path`.

5. Compute `reproducibility_hash` deterministically. Reference
   implementation in `verification/reproducibility-check.ts`.

---

## Confidence levels

- **high**: deterministic verification. Tests, type checks, linting, builds
  that produce identical output on re-run. Default.
- **medium**: verification depends on environment but the result is
  reproducible within a controlled environment (Docker container, CI runner).
  Network-dependent tests, time-sensitive code.
- **low**: verification is subjective or non-reproducible. UI screenshots,
  human-judged design quality, A/B test results. **Triggers explicit human
  review.**

If in doubt, downgrade. False high-confidence is worse than acknowledged
low-confidence.

---

## Forbidden patterns

Do NOT emit a claim if:

- Tests did not actually run (compile errors, environment failures)
- The command emitted non-zero exit code (no, "it's basically passing" is not
  acceptable)
- You cannot produce a stable `reproducibility_hash`
- The work is partial — emit only when the unit of work is complete
- You are uncertain whether the work matches the spec — open a blocker instead

---

## Example

After implementing refresh-token rotation per `specs/auth/tokens.md#ac-3`:

```yaml
claim:
  id: claim-2026-05-22-018
  type: implementation
  spec_ref: "specs/auth/tokens.md#ac-3"
  description: "Implemented 7-day expiry on refresh tokens with REFRESH_EXPIRED error code per AC-3"
  proof:
    git_sha: "7c4a9f2"
    files_changed:
      - "src/auth/refresh.ts"
      - "src/auth/refresh.test.ts"
    test_command: "pnpm test auth/token"
    test_exit_code: 0
    test_output_path: ".workflow/proofs/claim-2026-05-22-018-test.log"
    duration_ms: 4271
  confidence: high
  reproducibility_hash: "sha256:e7a3b9c5d2f4..."
  caveats: |
    None. Test uses fake timers so no real-clock dependency.
```

---

## Verification

After emitting the claim, run:

```bash
node verification/claim-validator.js .workflow/proofs/claim-2026-05-22-018.yml
```

The validator re-runs `test_command` and confirms:

1. Exit code matches
2. The `git_sha` exists in the repo
3. The `files_changed` are present in that commit
4. The `reproducibility_hash` recomputes to the same value

If any check fails, the claim is rejected and the session cannot proceed
to completion until it's fixed or withdrawn.

---

**This skill is working when:** 100% of session-end summaries show all claims
verified by the validator. Track in `governance/telemetry/proof-rate.jsonl`.
