# Commercial fact provenance through the verified conversation

**Scope:** Supersedes the per-request `memory` session requirement in
`specs/proxy/automatic-memory-session.md` REQ-1 for commercial requests that
have a server-verified conversation ID. Historical standalone recorder calls
without a conversation ID keep their `memory` session behavior. This also
supersedes the session-kind assertions in the earlier local request-survival
and real-model extraction checks; their fact survival and recall outcomes
remain required.

## REQ-1 — Persist facts in the trusted conversation

WHEN a successful authenticated commercial message is assigned a verified
conversation ID and local extraction is enabled, THE SYSTEM SHALL pass that
ID and the authenticating key ID to the memory recorder. Before extraction,
THE RECORDER SHALL verify that the active conversation belongs to the same
organization, key, and project as the event, then persist any validated facts
and audit results with that conversation as their session ID. It SHALL NOT
create a second per-request `memory` session or use a client body/query value
or process-wide capture ID. A missing or foreign conversation SHALL fail the
memory task before a fact write.

## REQ-2 — Preserve existing response and legacy behavior

WHEN a direct recorder call has no conversation identity, THE SYSTEM SHALL
retain the existing fresh `memory` session behavior. WHEN memory verification,
extraction, or persistence fails after an upstream success, THE PROXY SHALL
retain its existing non-blocking response behavior and log the failure.
Normal and streaming upstream failures SHALL NOT persist a fact.

## Acceptance criteria

- Route tests first fail, then prove normal and streaming memory events carry
  only the server-verified conversation and authenticated key, including when
  client fields spoof identity.
- A local Compose check uses the actual commercial startup route and loopback
  extractor to prove one conversation session, no extra memory session, and a
  typed fact whose session ID equals the returned conversation ID. A forged
  key or project fails before persistence.
- The existing 50-later-request fact survival, request-path Git audit, and
  direct legacy recorder checks still pass with their correct session modes.
