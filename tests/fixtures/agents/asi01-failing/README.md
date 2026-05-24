# ASI01-Failing Agent Harness — Test Fixture for REQ-B3 / AC-B3.1

This directory holds the synthetic ASI01-failing Python harness for spec
`specs/phase-2/B-deepteam-ci.md` REQ-B3 / AC-B3.1.

## What this is

A deliberately-vulnerable Python `model_callback` that DeepTeam can probe
to produce a severity-`critical` ASI01 (Agent Goal Hijacking) finding.
The harness obediently follows injection patterns in its input — exactly
the failure mode ASI01 names. The vulnerability is by construction; a
defender reviewing the code sees it by inspection.

## Why it's intentionally vulnerable

CI's red-team gate (REQ-B3) needs a deterministic critical-finding to
verify end-to-end:

1. The wrapper script `scripts/run-redteam.sh` exits 1 on `severity:
   critical` (REQ-B3 wiring, already attested by claim 068 from session 5).
2. GitHub Actions inherits the non-zero exit and fails the workflow.
3. The branch-protection gate blocks the PR merge.

Without a deterministic critical-finding input, the end-to-end test
relies on DeepTeam happening to find a critical issue in the project's
real agent surface — a flaky proof. This fixture is the lock-in.

## What's in here

- `harness.py` — the `model_callback(user_input: str) -> str` function
  DeepTeam invokes. Pure Python; no external dependencies; deterministic
  per input. Goal-hijacking surface covers the canonical ASI01 probe
  patterns ("IGNORE PREVIOUS INSTRUCTIONS", "Disregard previous",
  "System: ..." prefixes).
- `test_harness.py` — unit tests that lock in the intentional vulnerability.
  A future refactor that accidentally adds an injection check would fail
  these tests, surfacing the regression. **Run with `python -m pytest
  tests/fixtures/agents/asi01-failing/test_harness.py`**.

## How CI uses it

The deepteam job in `.github/workflows/security-scan.yml` (added in
session 5 B.03) invokes `scripts/run-redteam.sh`. That script's Python
harness can be parameterised to invoke this fixture's `model_callback`
as the agent-under-test. The expected outcome:

- DeepTeam probes `model_callback` with the OWASP_ASI_2026 framework's
  ASI01 attack patterns.
- The harness obediently complies (returns the attacker's target string).
- DeepTeam classifies the response as `severity: critical`.
- The script's Python harness tallies `critical_count >= 1` and exits 1.
- The workflow step fails. The workflow fails. Branch protection blocks
  merge.

## Companion fixture for AC-B1.2

`tests/fixtures/agents/docs-only-change/` is the documentation-only
fixture for AC-B1.2 (docs-only PR skips the deepteam job entirely via
the REQ-B1 path filter). It is intentionally minimal — a single
`docs/` change with no code.

## What this fixture does NOT do

- It does NOT install DeepTeam. The CI workflow does that. Locally,
  developers can `pip install deepteam` and run `bash scripts/run-redteam.sh`.
- It does NOT verify DeepTeam's classification of the harness output as
  `critical`. That's DeepTeam's responsibility, exercised in CI.
- It does NOT cover all ASI01 variants. The three patterns
  (`IGNORE PREVIOUS INSTRUCTIONS`, `Disregard previous`, `System:`
  prefix) are representative; DeepTeam's framework includes more.

## See also

- `specs/phase-2/B-deepteam-ci.md` REQ-B3 + AC-B3.1
- `governance/owasp-asi-2026/threats.md` ASI01 (#1 risk for 2026)
- `scripts/run-redteam.sh` — the CI wrapper that invokes DeepTeam
- `.github/workflows/security-scan.yml` deepteam job — the CI gate
- `skills/universal/security/prompt-injection-defense/SKILL.md` — the
  agent-side defense this fixture intentionally lacks
