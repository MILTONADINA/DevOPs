# Root local setup

**Scope:** `plan.md` §7a and the owner-approved project-local Supabase Compose stack.

## REQ-1 — One root command

WHEN an operator runs `npm run setup` from the repository root on macOS,
Linux, or WSL2, THE SYSTEM SHALL check Node and Docker Compose prerequisites,
install Stratum dependencies when missing, start the loopback-only local stack,
and smoke-test the proxy listener and local database health. It SHALL exit
nonzero with an actionable error if a prerequisite or smoke check fails.

## REQ-2 — Secret boundary and honest readiness

WHEN root setup runs, THE SYSTEM SHALL use only process environment and the
local Compose credential handoff. It SHALL NOT read or write a `.env` file.
It SHALL state that provider-backed message traffic requires a configured
provider and SHALL NOT claim the cold-clone, cross-platform, or real-data
recovery release gates are met from a single-machine smoke check.

## Acceptance criteria

- **AC-1:** root `npm run setup -- --help` documents supported systems and
  prerequisites; unsupported native Windows fails closed.
- **AC-2:** a local run reaches the real proxy listener, receives healthy
  database status, exits zero, and leaves only the intended local Compose
  stack running.
- **AC-3:** the root setup source contains no dotenv loading or `.env` file
  access; setup output identifies the remaining provider requirement.
