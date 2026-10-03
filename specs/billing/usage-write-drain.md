# Drain accepted commercial usage on shutdown

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` C2: the usage writer is unsigned under REQ-4/5. This spec keeps the direct asynchronous-recorder drain contract; `durable-usage-outbox.md` governs fail-closed journaling on the production path.

**Scope:** Usage recording is asynchronous so a successful upstream response
does not wait for the billing database. A graceful proxy close must give
already-started writes time to finish. C2 preserves that drain and response
behavior while replacing the writer. Durable journal failure must still fail
the response under `durable-usage-outbox.md`; asynchronous database replay
failure must preserve the journal entry.

## REQ-1 — Track and drain accepted writes

WHEN a successful authenticated normal or streaming `/v1/messages` response
starts a commercial usage write, THE SYSTEM SHALL track that write until it
settles. A graceful Fastify close SHALL await all usage writes started before
the close hook completes. The proxied response SHALL remain independent of
database latency. A rejected promise or synchronous recorder error SHALL be
logged and SHALL NOT fail the upstream response or prevent other pending
writes from draining. Requests without a recorder or authenticated organization
SHALL retain existing behavior.

## Acceptance criteria

- **AC-1:** A red/green route test proves a successful response completes while
  its usage write is pending and close waits until that write settles.
- **AC-2:** A red/green route test proves a synchronous recorder error does not
  turn a successful upstream response into an error.
- **AC-3:** Existing normal and streaming usage counts, no-write on upstream
  errors, and asynchronous failure behavior remain covered by the focused
  route suite.
