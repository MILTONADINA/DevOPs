# Automatic commercial memory sessions

**Scope:** authenticated `/v1/messages` requests using the project-local
PostgreSQL API and an explicitly configured local extraction model.

## REQ-1 — Trusted automatic session

WHEN an authenticated commercial message request succeeds and local memory
extraction is enabled, THE SYSTEM SHALL create a new `memory` session owned by
the organization resolved from its API key. It SHALL NOT use the process-wide
capture ID, a client-supplied organization or session ID, or a daily billing
bucket as the fact's database session. Memory sessions SHALL NOT consume the
active explicit-session cap or appear as client-created sessions.

## REQ-2 — Validated fact persistence

WHEN that request completes, THE SYSTEM SHALL extract from the final user turn
and assistant text using only the configured local model, validate typed facts,
and persist them with the trusted organization and new session IDs. It SHALL
not persist raw turns or model-generated identity and provenance fields. A
failed upstream request SHALL NOT start memory extraction.

## REQ-3 — Response and shutdown behavior

WHEN extraction or persistence fails, THE SYSTEM SHALL log the error without
changing the upstream response. Graceful proxy shutdown SHALL wait for pending
memory writes. A streaming upstream failure SHALL NOT start a memory write.

## Acceptance criteria

- **AC-1:** unit routes trigger one scoped memory write on successful normal
  and streaming responses, and none on rejected or failed requests.
- **AC-2:** a local database check confirms new session and fact rows share the
  authenticated organization, remain invisible to explicit-session listings,
  and are removed after the check.
- **AC-3:** missing local extraction configuration leaves commercial forwarding
  unchanged; a configured non-loopback extraction URL is rejected.
