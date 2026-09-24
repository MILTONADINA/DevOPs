# Decision supersession recovery

**Scope:** Organization backup and clean-target restore of `tech_decisions`
whose `supersedes_id` points to another decision in the same organization.
This closes the documented forward-reference limitation in `restore-org.ts`.

## REQ-1 — Restore original relationships

WHEN a valid organization backup contains decision supersession references,
THE RESTORE SHALL insert every decision with its original ID and content, then
restore every original `supersedes_id` after all referenced decisions exist.
It SHALL preserve forward references and valid cycles, regardless of backup
row order. Backups without references SHALL retain the existing insert path.

## REQ-2 — Reject missing references before writing

WHEN a backed-up decision refers to an ID absent from that organization's
decision rows, THE RESTORE SHALL reject the backup before any database write.
It SHALL reject duplicate decision IDs and malformed non-null references.
The existing organization-scoped row validation SHALL remain in force.

## Acceptance criteria

- Focused tests first reproduce a forward-reference insert plan and missing
  reference acceptance, then prove two-phase insert/patch planning and prewrite
  rejection without mutating the backup object.
- A disposable local Compose check backs up decisions with a forward reference,
  clears the fixture, restores through the real CLI, and verifies the original
  IDs and relationship. It removes the fixture and temporary backup afterward.
