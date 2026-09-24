# Idempotent commercial usage events

**Scope:** Prepare append-only billing for safe replay after an ambiguous
database result. This change identifies each new commercial message usage
event; it does not yet provide a durable queue or guarantee that a process
crash cannot lose an event. Historical ledger rows have no event ID and retain
their existing signatures.

## REQ-1 — Stable event identity on the request path

WHEN a successful authenticated normal or streaming `/v1/messages` request
records usage, THE SYSTEM SHALL generate a server-side UUID and UTC occurrence
time once for that response and pass them with the measured usage. A client
header, query value, or body field SHALL NOT choose either value. Failed
upstream responses SHALL NOT produce a billing event. The ID and occurrence
time SHALL remain stable if the recorder retries the same event.

## REQ-2 — Signed, append-only replay identity

WHEN a billing input carries a usage event UUID, THE SYSTEM SHALL store it
beside the signed immutable fields and include it in the HMAC payload. THE
DATABASE SHALL allow at most one ledger row per non-NULL usage event ID. The
occurrence time SHALL determine the usage bucket's UTC day, including when
the same event is replayed after midnight.
WHEN the insert reports a uniqueness conflict, THE RECORDER SHALL read the
existing row by event ID and return its ID only if its organization and signed
inputs match exactly. It SHALL fail closed for a missing or mismatched row,
and for unrelated database errors. Existing rows with NULL event ID SHALL
retain the legacy signature and validation path.

## REQ-3 — Audit verification

WHEN the read-only billing verifier checks a new row, IT SHALL include its
usage event ID in the signing inputs. It SHALL continue validating legacy
rows with NULL event ID using the original payload.

## Acceptance criteria

- **AC-1:** Red/green normal and streaming route tests show generated UUIDs
  rather than client-supplied IDs.
- **AC-2:** Red/green recorder tests prove replay returns one matching row,
  rejects conflicting content, and signs the event identity without changing
  legacy signatures.
- **AC-3:** The local migration adds the nullable unique event ID without
  updating existing ledger rows, and the verifier test catches ID tampering.
