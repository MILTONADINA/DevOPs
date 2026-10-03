# Verification

The proof-of-work enforcement layer.

## Files

- `claim-schema.yml` — the structure every proof artifact must satisfy
- `claim-validator.ts` — validates the packaged schema, checks Git metadata and hashes, and optionally re-runs declared commands
- `confidence-rules.yml` — when a claim should be downgraded to medium/low
- `reproducibility-check.ts` — helper to compute reproducibility_hash before emitting a claim
- `stale-proof-detector.ts` — finds proofs whose Git commit is absent from the local object store

## Usage

```bash
# Validate a single claim without executing its command
npm run validate:claims -- .workflow/proofs/claim-2026-05-22-018.yml --no-rerun

# Validate selected local claims (schema, Git metadata and declared hash)
npm run validate:claims -- --all --no-rerun

# Find stale proofs
npx tsx verification/stale-proof-detector.ts

# Generate the hash for a new claim before writing it (no environment block)
npx tsx verification/reproducibility-check.ts 7c4a9f2 "pnpm test auth/token"
```

Omitting `--no-rerun` retains the existing behavior: the validator executes
claim-controlled shell text with the caller's environment and may write a
`.rerun` file. That replay path is not a safe execution boundary. A successful
`--no-rerun` result accepts declared data and metadata; it does not establish
that the declared command, GREEN or RED was observed.

## Packaged schema validation (MR10-A)

The validator loads the fixed sibling `claim-schema.yml` from its own package,
even when called from another project. A schema in the calling project does
not override it. Claim paths must stay within the canonical working directory;
the schema stays within the validator's package root. Inputs must be regular
files without symlink components, at most256 KiB each, and valid UTF-8.

Both inputs use one YAML1.2 core document with string mapping keys and finite
JSON-compatible values. Duplicate keys, anchors, aliases, nonstandard tags,
multiple documents and collection nesting above64 levels are refused.
Standard quoted, literal and folded string values retain their YAML semantics.
The draft2020-12 schema compiles offline with local fragment references and
`date-time` validation. Validation does not coerce types, insert defaults or
remove properties. New failures use fixed input categories or escaped schema
paths and keywords without printing claim contents.

This is the schema-loading slice of
[MR10](../specs/verification/claim-schema-loading.md). The existing Git checks
establish commit-object existence and whether each claimed filename appears in
the commit's changed-file list; they do not prove reachability or regular-file
existence at that commit. The hash is recomputed from declared command,
environment and SHA strings. The current schema permits additional properties,
nonzero integer exits and implementation claims without `proof.red`.
Nonempty committed proof selection, missing-ID refusal, real spec anchors,
SHA reachability, safe RED replay and `/sprint` integration remain pending.

## Integration points

- Session-end hook (`write-baton.sh`) counts the claim files in `.workflow/proofs/`
  that are newer than the previous baton.
- CI (`.github/workflows/ci.yml`) runs `claim-validator.ts --all --no-rerun` and the
  stale-proof detector on every PR. `.workflow/proofs/` is gitignored, so on a CI
  checkout both find no claims and pass. MR10-A deliberately preserves that
  empty-selection exit0 without loading a schema. A committed proof set and
  nonempty CI enforcement remain pending under PB-60 and roadmap MR10.

## How a claim is born

1. Agent completes a verifiable task.
2. Agent emits `.workflow/proofs/claim-YYYY-MM-DD-NNN.yml` matching the schema.
3. `proof-of-work` skill captures stdout+stderr to `.workflow/proofs/<id>-test.log`.
4. Validator checks the declared schema, Git metadata and reproducibility hash;
   command execution is separate from `--no-rerun` validation.
5. Session-summary aggregates verified claims.
6. The stale-proof detector reports claims whose `git_sha` is missing from the local
   object store (`git rev-parse --verify`). A commit that is stored but unreachable
   from any ref still passes.
