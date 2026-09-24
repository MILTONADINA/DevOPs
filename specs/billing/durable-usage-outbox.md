# Durable local commercial usage outbox

**Scope:** Commercial billing runs on the operator's project-local, persistent
filesystem and local PostgreSQL stack. A successful message must not depend on
an in-flight database promise surviving process death. This does not make an
ephemeral serverless filesystem suitable for commercial billing.

## REQ-1 — Commit usage before successful response completion

WHEN an authenticated message has successful upstream usage with positive input
tokens, THE SYSTEM SHALL write its server-generated event ID, original UTC time,
authenticated organization/project, model, measured tokens, and current input
token price into a project-local outbox before completing the normal response or
the streaming `message_stop` event. The outbox write SHALL use a private file,
atomic rename, and file and directory fsync. If that write fails, THE SYSTEM
SHALL fail the normal response or terminate the stream with an explicit error;
it SHALL NOT silently acknowledge an unjournaled successful response.

## REQ-2 — Restart replay and idempotent acknowledgement

WHEN the proxy starts or a retry interval fires, THE SYSTEM SHALL replay each
complete pending outbox event through the signed billing recorder, using the
original ID, UTC time, and price. It SHALL remove and fsync the file only after
the recorder confirms success, including a verified duplicate. A database
error SHALL leave the event on disk for a later retry. A malformed event SHALL
remain on disk and produce an error signal rather than being silently discarded.
Graceful close SHALL wait for the current replay pass, without requiring an
unavailable database to recover before shutdown.

## REQ-3 — Local deployment boundary

WHEN commercial usage billing is enabled, THE SYSTEM SHALL require a persistent
project-local outbox directory that is writable at startup. A serverless runtime
with only ephemeral storage SHALL fail commercial billing startup until a
persistent outbox backend is configured. Personal mode SHALL remain unaffected.

## Acceptance criteria

- **AC-1:** A normal response and a completed stream leave a durable event
  before reporting success; a failed journal write yields an explicit error.
- **AC-2:** A fake-database failure leaves the file, restart replays the same
  event ID/time/price, and verified success removes it. A crash after DB commit
  but before removal is safe through the unique signed ledger identity.
- **AC-3:** Local tests verify private atomic files and ignore incomplete temp
  files; startup rejects an unwritable or ephemeral outbox in commercial mode.
