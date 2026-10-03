# Team usage fail-closed gates

**Amended**: 2026-10-03 by `specs/ops/payment-removal.md` C2: REQ-5 removes the signing-secret prerequisite and keeps database and persistent-journal guards.

**Scope:** The local commercial runtime uses authenticated message routes and
unsigned usage persistence. A production team entrypoint always wires its
durable usage outbox. Isolated tests may inject recorder dependencies.

## REQ-1 — Complete commercial startup

WHEN a production entrypoint is started with `CQ_COMMERCIAL=true` or `1`, THE
SYSTEM SHALL refuse to serve requests unless the database URL and service key
are present. It SHALL wire usage persistence without a billing signing secret
and SHALL refuse the ephemeral Vercel runtime for team usage. The writable,
persistent project-local journal requirement SHALL remain. Personal mode SHALL
continue without those team settings.

## REQ-2 — Measurable usage before acknowledgement

WHEN the durable commercial usage outbox is active and a successful upstream
message has no positive finite input-token count from either the upstream
response or preflight count, THE SYSTEM SHALL report a billing-unavailable
error instead of completing a normal response or sending the streaming
`message_stop`. It SHALL NOT write a zero-token ledger event. Upstream
non-success responses SHALL retain their existing pass-through behavior.

## Acceptance criteria

- **AC-1:** Focused startup tests reject missing database credentials and
  ephemeral storage, confirm team usage is wired without a signing secret, and
  preserve personal mode. The real no-secret message-to-row check is required
  by `specs/ops/payment-removal.md#AC-5`.
- **AC-2:** Normal and streaming route tests demonstrate explicit errors and no
  outbox enqueue for an unmeasurable successful response.
