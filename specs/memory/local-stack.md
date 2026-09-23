# Local Stratum storage

**Scope:** `plan.md` §4–§5 and ADR-0020. The owner retired the paused hosted
Supabase project, chose the free local Supabase stack, then chose project-local
Compose with explicit loopback ports after Docker Desktop ignored the CLI
network binding option on 2026-09-23.

## REQ-1 — No hosted dependency for development

WHEN an operator starts Stratum for local development, THE SYSTEM SHALL use
project-local Docker Compose for Supabase PostgreSQL, PostgREST, and its
`/rest/v1` gateway on this machine. It SHALL apply the committed migrations in
order without linking to or contacting the paused hosted project. The local API
SHALL be bound to `127.0.0.1`; PostgreSQL SHALL have no published host port.
Restarting SHALL preserve the data volume and skip migrations already applied.

IF the container runtime publishes the local API or database on a
non-loopback host address, THE SYSTEM SHALL stop this project's stack and
report a startup failure rather than leaving it running.

WHEN a local command needs the Supabase service JWT, THE SYSTEM SHALL generate
or retrieve it from the running project stack and pass it only through the
child process environment. It SHALL not write credentials to `.env` or print
them in command output.

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

- **AC-1:** a fresh Compose startup applies every committed migration once;
  a restart preserves data and does not replay applied migrations.
- **AC-2:** SQL checks confirm the audit table, RPC, and service-role
  privileges on the local database.
- **AC-3:** the local API responds over loopback and no project service has a
  non-loopback published port; broad Docker bindings cause automatic stop and
  a nonzero startup exit.
- **AC-4:** local commands receive a valid service-role JWT through the process
  environment without a credential file or credential output.
