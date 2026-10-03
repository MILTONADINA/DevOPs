# Idempotent commercial usage events

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md`: C2 REQ-4 replaces HMAC replay comparison with persisted-input comparison and preserves the event-ID index. C3 REQ-7 removes the legacy signature verifier; the unsigned replay requirements remain unchanged.

**Scope:** Safe usage replay after an ambiguous database result. This spec
identifies each new team message event; `durable-usage-outbox.md` supplies the
persistent queue. M1 removes signatures from all rows. Historical rows with no
event ID remain readable; new request events carry a server-generated ID.

## REQ-1 — Stable event identity on the request path

WHEN a successful authenticated normal or streaming `/v1/messages` request
records usage, THE SYSTEM SHALL generate a server-side UUID and UTC occurrence
time once for that response and pass them with the measured usage. A client
header, query value, or body field SHALL NOT choose either value. Failed
upstream responses SHALL NOT produce a usage event. The ID and occurrence
time SHALL remain stable if the recorder retries the same event.

## REQ-2 — Unsigned replay identity

WHEN a usage input carries a usage event UUID, THE SYSTEM SHALL store it with
its organization, session, token counts, pinned price and optional pruning log.
THE DATABASE SHALL allow at most one usage row per non-NULL event ID. The
occurrence time SHALL determine the usage bucket's UTC day, including when
the event is replayed after midnight.
WHEN the insert reports a uniqueness conflict, THE RECORDER SHALL read the
existing row by event ID and return its nonempty ID only if its organization,
session, original/quarantined tokens and event ID match. It SHALL also preserve
the pinned-price and pruning-log integrity checks using persisted inputs;
price comparison SHALL respect database numeric precision. Missing or
mismatched rows and unrelated database errors SHALL fail closed. No signature
SHALL be computed or compared.

## REQ-3 — Legacy audit verification boundary

The former signature-verification requirement is superseded by
`specs/ops/payment-removal.md#req-4`. C3 removes its CLI and old payment tests;
they do not establish integrity of post-M1 unsigned rows. Current replay
verification is REQ-2 and payment-removal AC-4.

## Acceptance criteria

- **AC-1:** Red/green normal and streaming route tests show generated UUIDs rather than
  client-supplied IDs.
- **AC-2:** Red/green recorder tests prove replay returns one matching row, rejects each
  conflicting input, and inserts no signature or fee. Storage precision and
  malformed/missing replay results are covered.
- **AC-3:** M1 keeps the nullable unique event-ID index while removing signatures
  and mutation guards. A local writer insert/replay check proves one matching
  row; unrelated or mismatching conflicts fail. Historical NULL IDs remain
  valid table data without pretending they supply event replay identity.
