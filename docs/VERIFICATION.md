# Verification Protocol

See `verification/README.md` for the active code. This doc explains the
philosophy.

## The rule

Every claim of completed work ships with a proof artifact in
`.workflow/proofs/`. No proof, no claim, no merge.

## Schema

`verification/claim-schema.yml` defines the structure. The validator
(`claim-validator.ts`) enforces it.

## Required fields

- `id` — claim-YYYY-MM-DD-NNN
- `type` — implementation, test, scan, deploy, migration, refactor, perf
- `spec_ref` — points into /specs/
- `proof.git_sha`, `files_changed`, `test_command`, `test_exit_code`, `test_output_path`
- `confidence` — high, medium, low
- `reproducibility_hash` — sha256(command + env + sha)

## Confidence

- `high` — deterministic
- `medium` — reproducible in controlled env
- `low` — subjective; **triggers explicit human review**

Low confidence claims block merge until human approves.

## Re-running

```bash
npm run validate:claims -- --all              # validates everything, re-running each proof
npm run validate:claims -- --all --no-rerun   # schema + git only
```

CI runs the `--no-rerun` form on every PR, but `.workflow/proofs/` is gitignored,
so on a CI checkout it finds no claims and passes (polish backlog PB-60). Before
merging, re-run the claims locally with the first form.
