# Commercial billing fail-closed gates

**Scope:** The local commercial runtime uses authenticated message routes and
signed usage billing. Test-only dependency composition may omit billing to
exercise memory without writing the immutable ledger.

## REQ-1 — Complete commercial startup

WHEN a production entrypoint is started with `CQ_COMMERCIAL=true` or `1`, THE
SYSTEM SHALL refuse to serve requests unless the database URL, service key,
and dedicated billing signing secret are present. It SHALL refuse the
ephemeral Vercel runtime for commercial billing. Personal mode SHALL continue
without those commercial settings.

## REQ-2 — Measurable usage before acknowledgement

WHEN the durable commercial usage outbox is active and a successful upstream
message has no positive finite input-token count from either the upstream
response or preflight count, THE SYSTEM SHALL report a billing-unavailable
error instead of completing a normal response or sending the streaming
`message_stop`. It SHALL NOT write a zero-token ledger event. Upstream
non-success responses SHALL retain their existing pass-through behavior.

## Acceptance criteria

- **AC-1:** Focused startup tests reject missing credentials/signing secret and
  confirm personal mode and complete local commercial settings pass.
- **AC-2:** Normal and streaming route tests demonstrate explicit errors and no
  outbox enqueue for an unmeasurable successful response.
