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

## REQ-3 — Single Stratum setup entry

WHEN an operator runs `npm run setup` from `stratum/`, THE SYSTEM SHALL invoke
the same root local setup workflow. No setup entry SHALL load dotenv or create
a `.env` file from a template.

## REQ-4 — Checkout-local analyzer entry

WHEN an operator runs `npm run analyze` from this checkout without setting
`DEVOPS_ROOT`, THE SYSTEM SHALL execute the analyzer shipped in this checkout
and refresh `.workflow/profile.yml`. The npm entry SHALL work even when a
local copy has lost the executable bit on the shell script.

## Acceptance criteria

- **AC-1:** root `npm run setup -- --help` documents supported systems and
  prerequisites; unsupported native Windows fails closed.
- **AC-2:** a local run reaches the real proxy listener, receives healthy
  database status, exits zero, and leaves only the intended local Compose
  stack running.
- **AC-3:** the root setup source contains no dotenv loading or `.env` file
  access; setup output identifies the remaining provider requirement.
- **AC-4:** both package setup commands resolve to the root local workflow,
  and the old dotenv-writing Stratum setup script is absent.
- **AC-5:** `npm run analyze` exits zero without `DEVOPS_ROOT` and writes a
  current profile from this checkout.
