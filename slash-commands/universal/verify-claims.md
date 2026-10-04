---
name: verify-claims
description: Validate the exact committed claim metadata set without replaying commands. Use before merge or status reporting; CI uses the same nonempty committed selector.
---

# /verify-claims

From the DevOPs repository root:

```bash
npm run validate:claims -- --all --no-rerun
```

From a consuming project's root, with the installed `tsx` launcher and
`DEVOPS_ROOT` identifying the DevOPs checkout:

```bash
tsx "${DEVOPS_ROOT:-$HOME/DevOPs}/verification/claim-validator.ts" --all --no-rerun
```

Both forms require that calling project's reviewed, committed
`.workflow/proofs/committed/manifest.json` and complete named set. A missing or
empty set fails; there is no fallback to ignored local proof history. Replace
`--all` with `--claim <id>` to validate one selected claim after binding every
member. `--no-rerun` is mandatory; conflicting/repeated selectors, malformed
arguments and unknown IDs fail.

To check a just-emitted **local** claim without publishing a set, replace the
selector with its explicit quoted filename and retain `--no-rerun`. This uses
the legacy local schema/Git/hash checks, as the generated project hook does;
it does not satisfy the committed CI gate. Review and commit a project's
manifest, YAML and artifacts separately before adopting the committed gate.

Report accepted **metadata**, not independently observed GREEN, RED, log
contents or command execution. Committed validation binds HEAD bytes/hashes,
main ancestry, changed regular blobs and target-spec anchors under the finite
supported Git layout. It does not prove declared commands used the artifacts.
The committed checker never fetches or repairs history. Legacy local replay
without `--no-rerun` remains unsafe and is outside this command.
