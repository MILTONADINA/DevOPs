# Stratum dependency alert remediation

**Owner**: Milton Adina  
**Date**: 2026-09-23  
**Source**: `SHIP_BLOCKERS.md` security quality bar and the owner's instruction to complete remaining work.

## REQ-1 — Alert baseline

WHEN remediating Stratum dependencies, THE SYSTEM SHALL record the failing
`npm audit` baseline and identify direct packages that bring in critical or
high severity vulnerable transitive packages.

## REQ-2 — Supported upgrades

WHEN a patched release is available, THE SYSTEM SHALL update the affected
direct dependency and lockfile without forcing a mismatched peer dependency.
If an update changes a major version, THE SYSTEM SHALL verify Stratum's
typecheck and relevant runtime tests before accepting it.

## REQ-3 — Verified outcome

AFTER updating dependencies, THE SYSTEM SHALL run `npm audit`, `npm run
typecheck`, and the focused Stratum test suite. Any remaining alert SHALL be
documented with its dependency path and reason it could not be cleared.

## Acceptance criteria

- **AC-1**: pre-fix audit output and package ancestry are recorded.
- **AC-2**: no critical or high severity alert remains in the Stratum lockfile.
- **AC-3**: typecheck and relevant tests pass with the updated install.
