# ADR-0001: Use Supabase (Postgres) Instead of SQLite

**Date:** 2026-04-06
**Status:** Accepted

## Context

For local development and the Phase 1 measurement proxy, we need a storage layer for session data, billing records, and structured facts. SQLite was considered as the fastest-to-initialize option.

## Decision

Use Supabase local (which runs Postgres via Docker) for all development and Supabase hosted for production.

## Consequences

- Slightly slower local setup (requires Docker)
- Production-identical schema from day one — no migration surprises
- Row-level security (RLS) can be designed and tested locally
- Postgres features available immediately: `GENERATED ALWAYS AS`, `INT4RANGE`, triggers for append-only billing, `TIMESTAMPTZ` precision

## Alternatives Considered

**SQLite:** Rejected because the billing record schema requires `GENERATED ALWAYS AS` computed columns, append-only enforcement via triggers, and `INT4RANGE` for span storage. These are Postgres-specific. Migrating from SQLite to Postgres mid-project introduces schema translation risk.

**PlanetScale (MySQL):** Rejected because it lacks `INT4RANGE`, partial indexes, and `TIMESTAMPTZ`. Also costs money from day one.
