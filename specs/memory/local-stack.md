# Local Stratum storage

**Scope:** `plan.md` §4–§5 and ADR-0001. The owner retired the paused hosted
Supabase project and chose the free local CLI stack on 2026-09-23.

## REQ-1 — No hosted dependency for development

WHEN an operator starts Stratum for local development, THE SYSTEM SHALL use
the Supabase CLI's local Postgres and HTTP API on this machine. It SHALL apply
the committed migrations in order without linking to or contacting the paused
hosted project. The local services SHALL be bound to loopback rather than
exposed on a public interface.

IF the container runtime publishes the local API or database on a
non-loopback host address, THE SYSTEM SHALL stop this project's stack and
report a startup failure rather than leaving it running.

## REQ-2 — Audit schema availability

WHEN a fresh local stack is initialized, THE SYSTEM SHALL create the
`audit_statuses` table and the `persist_audit_results` RPC from the committed
September 2026 migrations. A local audit write SHALL remain organization
scoped, atomic, and unavailable to anonymous and authenticated database roles.

## REQ-3 — Release honesty

WHEN local storage checks pass, THE SYSTEM SHALL label them as development
evidence. It SHALL NOT mark the v0.5/v0.6 deployed latency gates or the v1
commercial storage gate complete without a separate production deployment
and its own verification.

## Acceptance criteria

- **AC-1:** a fresh `supabase start`/`db reset` succeeds locally with no hosted
  project reference or remote API call.
- **AC-2:** SQL checks confirm the audit table, RPC, and service-role
  privileges on the local database.
- **AC-3:** the local API responds over loopback and is unreachable through a
  non-loopback interface; broad Docker port bindings cause automatic stop and
  a nonzero startup exit.
