# Real local model message extraction

**Scope:** the v0.5 development gate for a locally running OpenAI-compatible
model and the project-local Compose API.

## REQ-1 — Real extraction through the request path

WHEN an authenticated commercial `/v1/messages` request contains one explicit
technical decision, THE SYSTEM SHALL send its final user and assistant turns
to the configured loopback extraction model and persist the model's validated
typed fact under a new organization-bound memory session. The check SHALL use
a real local model response, not a fake completion server.

## REQ-2 — Recall and cleanup

AFTER that request, THE SYSTEM SHALL recall the fact through the project-bound
SessionStart bridge for the owning organization. The check SHALL remove its
disposable organization, key, session, and fact on success or failure.

## Acceptance criteria

- **AC-1:** the model produces one valid TechDecision about RS256 JWT signing,
  and the local database contains that one unsuppressed fact in one memory
  session after the proxy drains its asynchronous recorder.
- **AC-2:** SessionStart returns the same fact ID without the API credential.
- **AC-3:** this is evidence for one explicit decision on one local model. It
  does not establish broad extraction accuracy, Claude hook activation, or a
  deployed latency gate.
