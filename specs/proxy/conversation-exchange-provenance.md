# Commercial exchange provenance for facts and shadow turns

**Scope:** A verified commercial conversation can contain many message
exchanges. Its facts and transient shadow turns need a shared, server-owned
exchange identity before supersession can be applied to specific turns. This
change does not activate pruning or persist raw dialogue.

## REQ-1 — One trusted exchange identity

WHEN a successful authenticated commercial message has a verified conversation
ID and completed user and assistant text, THE SYSTEM SHALL mint one UUID for
that completed exchange and pass the same ID to memory extraction and shadow
observation, for normal and streaming responses. Client headers, query fields,
and body fields SHALL NOT choose the exchange ID. Failed upstream messages
SHALL NOT produce a fact or observed exchange.

## REQ-2 — Bind persisted facts without exposing provenance

WHEN the recorder persists a fact for a verified conversation, THE SYSTEM
SHALL set `source_exchange_id` from the trusted event on each typed fact row.
It SHALL ignore a model-supplied value. The database SHALL permit non-null
exchange IDs only on conversation facts and SHALL reject subsequent changes
to an existing fact's exchange or session identity. Direct legacy recorder
calls SHALL retain NULL exchange IDs. Typed fact reads SHALL continue to omit
this internal field. Organization backup and clean-target restore SHALL
preserve it.

## REQ-3 — Carry identity through the transient selection

WHEN the shadow observer ingests a completed exchange, THE SYSTEM SHALL attach
its trusted exchange ID to both in-memory turns. Selected turns SHALL retain
that ID for later provenance-based suppression. The observer SHALL keep its
existing bounded lifetime, numeric-only metrics, non-blocking response
behavior, and default-off setting.

## Acceptance criteria

- Route tests fail first, then prove the same fresh UUID reaches recorder and
  observer for normal and streaming success despite spoofed client fields;
  failures emit neither event.
- Focused projection/context-manager tests fail first, then prove trusted
  exchange injection, no typed fact read exposure, and selected turn identity.
- A local Compose migration and actual commercial request prove the fact's
  exchange ID is non-null, a legacy fact stays NULL, non-conversation writes
  and identity rewrites fail, and clean-target backup/restore preserves IDs.
- Existing memory, survival, audit, recovery, typecheck, and targeted lint
  checks remain green. Tier-C remains a separate release gate.
