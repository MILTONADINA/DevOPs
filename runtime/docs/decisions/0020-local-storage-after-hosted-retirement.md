# ADR-0020: Local Supabase stack after hosted project retirement

**Date:** 2026-09-23
**Status:** Accepted for local development; production topology open

## Context

The owner will not reactivate the paused paid Supabase project. Stratum's
memory, audit, auth, and billing adapters use the Supabase HTTP API and
PostgreSQL functions. Plain PostgreSQL alone would require replacing those
adapters. The owner chose PostgreSQL on this machine with the free local
Supabase-compatible local stack.

## Decision

Use a project-local Compose stack for development and migration verification.
The initial CLI setup applied all migrations, but Docker Desktop ignored its
network-level loopback bind setting and published API and database on all
interfaces. The owner chose Compose with an explicit `127.0.0.1` gateway port;
PostgreSQL has no host port. Apply committed schema locally, including the
September 2026 audit migrations. Do not connect to the retired hosted project.
Local results do not close deployed or commercial release gates.

## Consequences

- Existing Supabase client adapters can run against a local HTTP API.
- The Compose database uses trust auth on its project network and is not
  published to the host. A generated service JWT is passed to child processes
  without a credential file.
- The operator is responsible for local data durability and backups.
- A production storage location and operations plan remain necessary before
  a commercial release. This Compose stack is not a production server.

This supersedes ADR-0001's hosted-production choice while retaining its
local-development choice and PostgreSQL schema rationale.
