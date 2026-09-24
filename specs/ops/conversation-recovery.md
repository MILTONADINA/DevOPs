# Conversation session backup and restore

**Scope:** Commercial conversation sessions have a database foreign key to
their authenticating API key. Organization recovery must preserve that binding.

## REQ-1 — Dependency-ordered restore

WHEN an organization backup contains a conversation session, THE RESTORE
SHALL insert its API key before its session, preserving both IDs and the
stored project scope. It SHALL restore into a clean target without changing
the existing signed billing ledger behavior.

## REQ-2 — Validate before writing

WHEN a conversation session refers to an API key absent from the same
organization backup, THE RESTORE SHALL reject the backup before any database
write. It SHALL continue to accept historical backups with no conversation
sessions, and reject foreign-organization API key rows under the existing
backup validation rule.

## Acceptance criteria

- A focused test fails against the prior restore order, then proves API keys
  precede sessions and a missing conversation key is rejected before planning.
- A disposable local Compose check backs up an organization with a bound key
  and conversation, removes the fixture, restores it through the real CLI,
  verifies exact key/conversation/project IDs and authenticated continuation,
  then removes the fixture and temporary backup.
