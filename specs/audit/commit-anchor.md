# Git attestation commit anchor

**Scope:** `plan.md` §5a, deterministic Tier-1 audit.

## REQ-1 — Claimed commit confirmation

WHEN a code fact supplies `commit_hash`, THE SYSTEM SHALL confirm it only with
a matching indexed change from that exact commit. If the claimed commit is
missing or its indexed changes do not establish the fact, THE SYSTEM SHALL
return UNVERIFIED even when a different commit has similar evidence. A later
contradicting indexed change SHALL still produce CONFLICT after a valid
confirmation.

## REQ-2 — Rename evidence integrity

WHEN the indexer represents a rename as delete-old plus add-new, THE SYSTEM
SHALL accept the pair as confirmation only when both changes belong to the
same commit. A claimed `commit_hash`, if present, SHALL match that commit.

## Acceptance criteria

- **AC-1:** a matching symbol and change in a different commit does not confirm
  a fact whose `commit_hash` names another commit.
- **AC-2:** a matching claimed commit confirms the fact; a later deletion of
  its asserted symbol yields CONFLICT with the later commit as evidence.
- **AC-3:** delete-old and add-new from separate commits remain UNVERIFIED;
  the same-commit pair confirms a rename.
