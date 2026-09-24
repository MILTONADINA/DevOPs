# Trusted commercial conversation and shadow observation

**Scope:** Commercial `/v1/messages` requests need a server-owned conversation
identity for per-conversation Tier-1 observation. The shadow pruner may measure
the history it would retain, but SHALL NOT change a forwarded request, a model
response, or a billing amount. The v0.4 quality gates remain red.

## REQ-1 — Durable identity bound to authentication

WHEN an authenticated commercial message has no `x-cq-conversation-id`, THE
SYSTEM SHALL create a database conversation session with a server-generated
UUID, the API key's organization, project scope, and key ID, and return that ID
in the response header. WHEN the header is present, THE SYSTEM SHALL use it
only after a database lookup verifies all three bindings and that the session
is active. A malformed or foreign ID SHALL fail before forwarding upstream.
Client body and query fields SHALL NOT choose a conversation identity. An
unbound key SHALL see only unbound conversations. Conversation sessions SHALL
NOT consume the explicit-session cap, appear in the explicit-session API, or
store raw turns.

## REQ-2 — Observation without pruning

WHEN local shadow observation is explicitly enabled and a trusted conversation
request succeeds, THE SYSTEM SHALL keep a bounded per-conversation Tier-1
window, timestamp newly observed turns with the server clock, and call the
existing scoped context manager for a subsequent query. It SHALL emit only
numeric selection metrics and trusted identity metadata; it SHALL NOT persist
raw text or embeddings. The observer SHALL use only locally cached encoder
files and SHALL log an observation failure without changing the upstream
request, response, or billing. No pruning decision SHALL alter forwarding.

## REQ-3 — Lifetime and failure handling

WHEN a conversation has no activity for two hours or the in-memory conversation
limit is reached, THE SYSTEM SHALL evict its raw Tier-1 window. A process
restart MAY lose the observation window while the database identity remains
valid. Failed upstream requests SHALL NOT ingest assistant turns. Graceful
shutdown SHALL wait for accepted observation work. Shadow observation SHALL
remain off by default.

## Acceptance criteria

- **AC-1:** Route and adapter tests cover server creation, authenticated
  continuation, malformed/foreign/key/project scope rejection, and no upstream
  forward on rejected continuation.
- **AC-2:** A rolled-back local SQL fixture proves conversation-kind and
  organization/key binding, and verifies explicit-session queries omit it.
- **AC-3:** A fake encoder test covers same-conversation history, cross-key and
  project isolation, bounded eviction, numeric-only logging, and unchanged
  normal/streaming forwarding when observation is on or fails.
