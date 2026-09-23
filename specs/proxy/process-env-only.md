# Proxy process credentials

**Scope:** local proxy startup and AGENTS.md secret boundary.

## REQ-1 — Process environment only

WHEN the proxy entry point is loaded, THE SYSTEM SHALL use credentials and
commercial-mode settings supplied by its process environment. It SHALL NOT
load `.env` or let a dotenv configuration file override those settings.

## Acceptance criteria

- **AC-1:** importing the proxy entry point with a mocked dotenv override
  does not change an existing `CQ_COMMERCIAL` process value.
- **AC-2:** existing commercial-mode option wiring remains functional.
