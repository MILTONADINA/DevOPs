# Contributor onboarding guide

**Scope:** `plan.md` §7a `DEVELOPER_GUIDE.md` and §7d `CONTRIBUTING.md` polish.

## REQ-1 — Executable local path

WHEN a contributor opens the developer guide, THE SYSTEM SHALL document the
supported host prerequisites, root setup command, local database/proxy
boundary, and the next command to run the proxy with a process-supplied
provider. It SHALL point to the local operations runbook for stop, migration,
backup, and restore tasks. It SHALL distinguish a local smoke check from the
clean-machine and real-data release gates.

## REQ-2 — Review and verification

WHEN a contributor prepares a pull request, THE SYSTEM SHALL identify the
current root and Stratum test/typecheck/lint commands, targeted proof-claim
validation, spec reference, and the actual CI checks. It SHALL describe Claude
review as conditional on its API key and require review of any visible skip.
It SHALL NOT claim a historical proof-corpus pass count is the current gate.

## REQ-3 — Signing and sensitive data

WHEN a contributor signs a release, THE SYSTEM SHALL direct them to the
existing owner signing procedure rather than ask for a private key or
passphrase. The guide SHALL state that secrets and organization backups stay
out of commits, PR bodies, and logs.

## Acceptance criteria

- **AC-1:** the guide's command names correspond to scripts in the root or
  Stratum package manifests.
- **AC-2:** all linked local guide/runbook/spec files exist, and the guide
  describes the release-gate limits honestly.
- **AC-3:** the contributor checklist points to the guide, uses the current
  claim-validation mode, and does not describe an unset Claude key as a review.
