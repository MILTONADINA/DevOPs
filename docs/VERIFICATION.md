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
- `type` — implementation, test, scan, deploy, migration, refactor, perf, doc,
  security-review, threat-model
- `spec_ref` — points into /specs/
- `proof.git_sha`, `files_changed`, `test_command`, `test_exit_code`, `test_output_path`
- `proof.red` for `implementation` and `test`: `sha` is exactly 40 lowercase
  hexadecimal characters; `exit_code` is a nonzero integer. It is optional
  for the other claim types, but any supplied RED object must satisfy the same shape.
- `confidence` — high, medium, low
- `reproducibility_hash` — sha256(command + env + sha)

The RED rule applies through the shared schema to every selected document.
It does not check whether the RED commit exists or whether a command failed.
Authors retain the actual observation; schema acceptance cannot supply one.
The existing reproducibility hash excludes RED fields. Committed member
hashes bind declared bytes without authenticating execution. Negative and
above-255 nonzero RED exits remain shape-valid; extra properties and the
existing declared GREEN exit policy are unchanged.

## Optional completion state

`claim.state`, when supplied, is exactly one of `implemented`, `verified`,
`code_converged`, `release_ready`, `fixed_not_live` or `production_complete`.
It is optional for every claim type and never defaulted. This is vocabulary
validation, not evidence that the stated completion level was reached. The
validator does not yet enforce convergence, release graph or deployment
requirements; AC-M10.1 remains open. The unchanged reproducibility hash excludes
state; committed member hashes bind declarations without proving them. Keep
historical claims unchanged rather than backfilling or upgrading their states.
See [the bounded contract](../specs/verification/completion-state-declarations.md).

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

## Closure citation checks

The [MR18-A contract](../specs/graph/closure-references.md) checks literal CLOSED
items for a commit/PR citation and an ID accepted by the committed proof set:

```bash
npx --no-install tsx scripts/lint-closures.mjs
npx --no-install tsx scripts/lint-closures.mjs --local-backlog
```

Default selection uses committed `SHIP_BLOCKERS.md` and the optional committed
polish backlog. The flag explicitly requires only the named local
`.workflow/state/polish-backlog.md` as its replacement; no arbitrary path or
historical claim discovery is supported. Both modes validate the full nonempty
publication and keep command declarations inert. The [usage reference](../verification/README.md#closure-references-mr18-a)
defines the exact heading/table and evidence forms, limits and diagnostics.

A passing result is citation and membership integrity. It does not prove that
a PR merged, a cited commit fixes the item or the claim substantiates closure.
The current ship-blocker document has zero literal CLOSED items; that count is
not historical verification. Preserve resolved prose and original evidence.
Freshness dates/hooks, whole MR18 and the remaining MR10 work stay open.
