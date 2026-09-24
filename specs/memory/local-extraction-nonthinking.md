# Deterministic local fact extraction

**Scope:** commercial fact extraction through the configured loopback model.

## REQ-1 — Request a completed JSON answer

WHEN the proxy requests typed facts from a local OpenAI-compatible model, THE
PROXY SHALL request non-thinking chat-template mode and deterministic sampling
for that extraction call. It SHALL keep the existing token cap and reject a
completion that reports a token-limit stop before parsing facts. These
settings SHALL apply only to server-initiated fact extraction, not to the
client's upstream message request.

## REQ-2 — Preserve memory boundaries

WHEN an extraction response completes, THE PROXY SHALL continue validating
and storing typed facts under the verified conversation. WHEN extraction fails,
THE PROXY SHALL preserve the successful upstream message response and store no
facts from that extraction.

## Acceptance criteria

- A loopback commercial-route fixture observes non-thinking template settings,
  temperature zero, and the existing token cap on extraction requests, while
  completed facts persist and token-limited output does not.
- A focused real local-model call on the previously truncated database case
  completes within the existing cap and produces validated typed facts.
