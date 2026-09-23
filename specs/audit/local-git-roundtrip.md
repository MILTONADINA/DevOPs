# Local Git-to-audit round-trip

**Scope:** `plan.md` §5a/§5c and the local Compose development stack.

## REQ-1 — Real Git evidence

WHEN the local audit check runs, THE SYSTEM SHALL create a disposable Git
history inside this project containing a function rename and a later deletion.
It SHALL attach the stored FunctionChange fact to the rename commit and run the
real `audit:repo --facts --persist` command against that history. The command
SHALL classify the fact as CONFLICT based on the later deletion.

## REQ-2 — Local persistence evidence

WHEN the conflict is persisted through the local Compose API, THE SYSTEM SHALL
confirm that the fact is suppressed, its audit status is CONFLICT, and one
unacknowledged conflict alert belongs to the disposable organization. The
check SHALL remove its Git, fact, session, organization, status, and alert
fixtures. It SHALL describe this as local operator-path evidence, not as live
proxy request-path or deployed dashboard-timing evidence.

## Acceptance criteria

- **AC-1:** the real indexer identifies rename and later delete commits from
  the disposable repository, and the CLI reports one CONFLICT.
- **AC-2:** the local database reports suppression, one CONFLICT status, and
  one unacknowledged alert for the same fact and organization.
- **AC-3:** no test fixture remains after a successful run.
