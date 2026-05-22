# Verification

The proof-of-work enforcement layer.

## Files

- `claim-schema.yml` — the structure every proof artifact must satisfy
- `claim-validator.ts` — re-runs proofs, validates exit codes, checks reproducibility hashes
- `confidence-rules.yml` — when a claim should be downgraded to medium/low
- `reproducibility-check.ts` — helper to compute reproducibility_hash before emitting a claim
- `stale-proof-detector.ts` — finds proofs referencing unreachable git SHAs

## Usage

```bash
# Validate all claims in .workflow/proofs/
node verification/claim-validator.js --all

# Validate a single claim
node verification/claim-validator.js .workflow/proofs/claim-2026-05-22-018.yml

# Validate without re-running (schema and SHA only)
node verification/claim-validator.js --all --no-rerun

# Find stale proofs
node verification/stale-proof-detector.js

# Generate the hash for a new claim before writing it
node verification/reproducibility-check.js 7c4a9f2 "pnpm test auth/token"
```

## Integration points

- Session-end hook (`write-baton.sh`) reads `governance/telemetry/proof-rate.jsonl`
  which is fed by validator runs.
- CI: run `node verification/claim-validator.js --all` on every PR.
- Pre-merge: same, with `--rerun`.

## How a claim is born

1. Agent completes a verifiable task.
2. Agent emits `.workflow/proofs/claim-YYYY-MM-DD-NNN.yml` matching the schema.
3. `proof-of-work` skill captures stdout+stderr to `.workflow/proofs/<id>-test.log`.
4. Validator runs, confirms reproducibility.
5. Session-summary aggregates verified claims.
6. Stale proofs are pruned in CI.
