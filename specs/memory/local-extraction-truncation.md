# Reject truncated local extraction completions

**Scope:** commercial message memory extraction through the configured loopback model.

## REQ-1 — Completed extraction only

WHEN the local extraction model reports that its output stopped at the token
limit, THE PROXY SHALL treat extraction as failed and SHALL NOT persist any
facts from that output, even when the text contains a balanced JSON array.

## REQ-2 — Preserve request behavior

WHEN extraction fails after a successful upstream message response, THE PROXY
SHALL return the upstream response unchanged and SHALL keep the verified
conversation available for subsequent requests. A completed valid extraction
SHALL continue to persist validated facts.

## Acceptance criteria

- A loopback model returns a valid fact on a completed response, then a distinct
  balanced fact array inside a token-limited response. The commercial route
  returns success for both requests and persists only the first fact.
- The requests use one verified conversation and leave no test rows after the
  check.
