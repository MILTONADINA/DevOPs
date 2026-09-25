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
# Validate all claims in .workflow/proofs/ (re-runs every proof)
npm run validate:claims -- --all

# Validate a single claim
npm run validate:claims -- .workflow/proofs/claim-2026-05-22-018.yml

# Validate without re-running (schema and SHA only)
npm run validate:claims -- --all --no-rerun

# Find stale proofs
npx tsx verification/stale-proof-detector.ts

# Generate the hash for a new claim before writing it (no environment block)
npx tsx verification/reproducibility-check.ts 7c4a9f2 "pnpm test auth/token"
```

## Integration points

- Session-end hook (`write-baton.sh`) counts the claim files in `.workflow/proofs/`
  that are newer than the previous baton.
- CI (`.github/workflows/ci.yml`) runs `claim-validator.ts --all --no-rerun` and the
  stale-proof detector on every PR. `.workflow/proofs/` is gitignored, so on a CI
  checkout both find no claims and pass. The real check is a local full re-run
  before merge (see polish backlog PB-60).

## How a claim is born

1. Agent completes a verifiable task.
2. Agent emits `.workflow/proofs/claim-YYYY-MM-DD-NNN.yml` matching the schema.
3. `proof-of-work` skill captures stdout+stderr to `.workflow/proofs/<id>-test.log`.
4. Validator runs, confirms reproducibility.
5. Session-summary aggregates verified claims.
6. The stale-proof detector reports claims whose `git_sha` is missing from the local
   object store (`git rev-parse --verify`). A commit that is stored but unreachable
   from any ref still passes.
