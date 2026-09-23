# ADR-0020: Local Supabase stack after hosted project retirement

**Date:** 2026-09-23
**Status:** Accepted for local development; production topology open

## Context

The owner will not reactivate the paused paid Supabase project. Stratum's
memory, audit, auth, and billing adapters use the Supabase HTTP API and
PostgreSQL functions. Plain PostgreSQL alone would require replacing those
adapters. The owner chose PostgreSQL on this machine with the free local
Supabase CLI stack.

## Decision

Use the local CLI stack for development and migration verification. Keep its
API and database on loopback. Apply the committed schema locally, including
the September 2026 audit migrations. Do not connect to the retired hosted
project. Local results do not close deployed or commercial release gates.

## Consequences

- Existing Supabase client adapters can run against a local HTTP API.
- The operator is responsible for local data durability and backups.
- A production storage location and operations plan remain necessary before
  a commercial release. The CLI development stack is not a production server.

This supersedes ADR-0001's hosted-production choice while retaining its
local-development choice and PostgreSQL schema rationale.
