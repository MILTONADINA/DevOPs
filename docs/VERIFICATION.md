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

Low confidence requires human review under policy. Schema/metadata validation
does not itself enforce or prove that approval.

## Validation modes

```bash
# Committed nonempty set; the flag is required
npm run validate:claims -- --all --no-rerun

# One committed ID, after binding every member of the manifest
npm run validate:claims -- --claim claim-2026-10-03-019 --no-rerun

# A named local claim, without a committed-set requirement
npm run validate:claims -- .workflow/proofs/claim-2026-10-03-001.yml --no-rerun
```

The committed selectors read only `.workflow/proofs/committed/manifest.json`.
They bind all listed YAML/scripts/checks to captured HEAD and their hashes;
selected claims must have matching IDs, main-ancestor targets, changed regular
blobs and a spec fragment in the target snapshot. Missing or empty sets fail.
CI prepares full local history and `origin/main` before this nonempty metadata
gate; logs remain ignored and are not required as committed evidence.

Explicit local files retain the older Git object-existence/changed-name and
hash checks. Generated consuming-project hooks use that explicit-file mode,
include hidden top-level YAML and skip empty lists; they are not the committed
CI gate. Local emission does not automatically publish a committed set.

All `--no-rerun` forms accept declarations and metadata, not independently
observed commands, logs, GREEN or RED. Omitting the flag is refused for
committed selectors. Legacy explicit/implicit mode still executes raw
claim-controlled shell text when the flag is omitted; that replay path is
unsafe and is not hardened by MR10-B. Implicit empty discovery remains a
compatibility behavior. Safe RED replay and `/sprint` integration remain open.
See [the active reference](../verification/README.md) for the supported Git
layout, limits and finite spec-anchor rules.
