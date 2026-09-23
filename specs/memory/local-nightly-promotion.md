# Local nightly memory promotion

**Scope:** `plan.md` §4d on the owner's macOS development machine and the
project-local Compose API.

## REQ-1 — Scheduled operator invocation

WHEN the operator installs the local promotion schedule, THE SYSTEM SHALL
register one user-level macOS job for 02:00 local time. The job SHALL run the
existing offline Tier-2 to Tier-3 promotion CLI from this project's `stratum/`
directory through `db:with-env`, so each invocation receives a fresh local
service JWT. Its plist and logs SHALL remain inside the project.

## REQ-2 — Failure visibility and reversibility

WHEN installation fails, THE SYSTEM SHALL report a nonzero exit and leave no
registered job from that attempt. WHEN the operator removes the schedule, THE
SYSTEM SHALL unregister its project-specific job. The job SHALL leave normal
promotion output and errors in project-local logs.

## Acceptance criteria

- **AC-1:** the generated plist is valid, names the 02:00 local schedule, and
  invokes `local-compose.ts with-env` followed by the promotion CLI.
- **AC-2:** `launchctl` shows the installed project-specific job and a real
  invocation exits successfully against the local Compose API.
- **AC-3:** the schedule is reversible and does not claim to run while the
  machine is asleep or the local Compose stack is stopped.
