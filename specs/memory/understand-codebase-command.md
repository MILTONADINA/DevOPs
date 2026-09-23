# Bound /understand-codebase command

**Scope:** `plan.md` §4f, on the approved local Supabase graph/vector store.

## REQ-1 — Scoped query

WHEN `/understand-codebase` is invoked, THE SYSTEM SHALL accept an entity name,
a semantic query, or both, and call the existing read-only CLI with the
operator-bound organization ID. It SHALL reject caller-supplied organization
flags and unknown flags. It SHALL never load `.env` or print a service key.

## REQ-2 — Trusted connection

BEFORE invoking the CLI, THE SYSTEM SHALL verify that the real current project
path matches `DEVOPS_STRATUM_PROJECT_ROOT`, the organization ID is a UUID, and
the Supabase URL and service key satisfy the SessionStart binding rule in
`specs/memory/session-start-recall.md#req-1`. WHEN verification fails, THE
SYSTEM SHALL make no client call and return a clear nonzero result.

## REQ-3 — Local semantic search

WHEN a semantic query is requested, THE SYSTEM SHALL use the project-local
encoder cache without downloading a model. If the cache is unavailable, THE
SYSTEM SHALL report the query failure without a remote model request.

## Acceptance criteria

- **AC-1:** bound invocation passes only the trusted organization ID to the
  existing CLI and preserves entity/query/k values.
- **AC-2:** mismatched root, URL, org, credentials, or caller org flags result
  in zero CLI calls.
- **AC-3:** the universal slash command points to the bound invocation and
  does not claim a graph dashboard exists until it does.
