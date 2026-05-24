# Modified-Skill Detection Fixture (E.07)

This fixture exists to exercise REQ-E6 AC-E6.1: that a tampered skill
file fails `cosign verify-blob` against the *original* bundle.

## What's in here

- `SKILL.md` -- a verbatim copy of
  `skills/universal/process/karpathy-guidelines/SKILL.md` at the moment
  this fixture was authored, **plus an injected tamper string at the
  bottom**. This file is intentionally NOT byte-identical to the signed
  original.

## How the test runs

`.workflow/proofs/_checks/req-E6-tampered-detection.js` does the
authoritative test: it copies the legit skill into a temp dir, mutates
one byte, runs `cosign verify-blob --bundle` against the mutated file,
and asserts non-zero exit + a "matching bundle to payload" error in
stderr. The script tears down the temp dir on exit.

This fixture file is the **durable** version of the same modification
-- a tracked artifact that documents the "modified-skill" condition
visibly in the repo, so a reader can see what tampering looks like
without re-running the test.

## Why a SKILL.md *copy* not a symlink

We want this fixture to be a deliberate snapshot, not coupled to the
real skill. If the real karpathy-guidelines/SKILL.md is updated and
re-signed, the fixture still represents "the original was signed, then
one byte changed". The detection mechanic doesn't depend on which
specific skill is the source.

## What to do if this test fails

`cosign verify-blob` succeeding against the tampered file means
**Sigstore's integrity guarantee has been broken or our bundle is
malformed**. This is a critical-severity finding. Surface immediately
to the user with the verifier output; do NOT attempt to "fix" the
fixture by reducing the test surface.
