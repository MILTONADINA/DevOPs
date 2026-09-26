# Stratum local network posture

**Status**: approved (owner, 2026-09-26, spec batch 1; recorded in .workflow/state/approvals.jsonl as human_approved_spec)
**Spec ID**: security/stratum-local-network (quality plan cycle S1)
**Decision context**: DevOPs is open source and local-first, with no hosted service (owner, 2026-09-26; ADR-0025). The Stratum proxy runs on the user's own machine and holds the user's provider keys.

## Problem

A read-only audit (Workflow `wf_eade04c4-534`, finding SEC-1, reproduced) found:
- In personal mode the proxy has no authentication.
- It registers `@fastify/cors` with the default `origin: '*'` (`stratum/src/proxy/app.ts:123-124`).
- It never checks the `Host` header.

So any web page the user opens while the proxy runs can send requests to `http://localhost:4080` and spend the user's provider key. A page can do this directly, as a cross-origin request, or through DNS rebinding: a hostname that resolves to 127.0.0.1 after the page loads.

The same audit found three smaller exposures:
- Nothing refuses a non-loopback bind without authentication. The Docker image sets `HOST=0.0.0.0`.
- `RATE_LIMIT_MAX=abc` turns the rate limiter off, because the value parses to NaN.
- Provider base URLs accept plain `http` to any host.

## Goal: secure by default, with nothing to configure

The default local setup must keep working with no new settings: an AI client on the same machine, pointed at `http://localhost:4080` or `http://127.0.0.1:4080`. Command-line clients send no `Origin` header and a loopback `Host`. Everything that is not that default needs a deliberate choice: a browser page, another hostname, a remote bind, or an insecure upstream.

## Definitions

- **Auth configured.** The proxy runs with API-key authentication, which is the team (commercial) mode's `auth.resolve` in `stratum/src/proxy/index.ts`.
- **Loopback name.** `127.0.0.1`, `localhost` or `[::1]`, each with or without the listening port.

## Requirements

### REQ-1 — No cross-origin access without auth
WHERE no auth is configured, THE PROXY SHALL NOT send an `Access-Control-Allow-Origin` header for any origin, and SHALL answer a CORS preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) with status 403. WHERE auth is configured, THE PROXY SHALL allow only the origins listed in `STRATUM_CORS_ORIGINS` (comma-separated, empty by default).

### REQ-2 — Loopback Host only without auth
WHERE no auth is configured, THE PROXY SHALL refuse with status 403, before routing, every request whose `Host` header is missing or is not a loopback name. WHERE auth is configured, THE PROXY SHALL accept any `Host`, unless `STRATUM_ALLOWED_HOSTS` (comma-separated) is set, in which case only those hosts and the loopback names are accepted.

### REQ-3 — No unauthenticated remote bind
- The listen address SHALL be read from `STRATUM_HOST`.
- `HOST` SHALL still be honoured for one release as a deprecated alias, and the proxy SHALL log a warning that names `STRATUM_HOST` when `HOST` is used.
- IF the listen address is not a loopback address, AND no auth is configured, AND `STRATUM_ALLOW_REMOTE_UNAUTHENTICATED` is not `1`, THEN THE PROXY SHALL refuse to start. It exits non-zero with a message that names the three ways forward: bind to loopback, configure auth, or set the opt-in.

### REQ-4 — Numeric settings fail closed
IF `PORT` is set and is not an integer from 1 to 65535, OR `RATE_LIMIT_MAX` is set and is not a positive integer, THEN THE PROXY SHALL refuse to start. It exits non-zero with a message that names the variable and the value it rejected.

### REQ-5 — Upstream transport
- THE PROXY SHALL refuse at startup any provider base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, `GEMINI_BASE_URL`, `CQ_LOCAL_BASE_URL`) that uses plain `http` to a non-loopback host, unless `STRATUM_ALLOW_INSECURE_UPSTREAM` is `1`.
- It SHALL refuse a base URL whose host and port equal its own listen address (a self-loop).
- Loopback `http` stays allowed, for local model servers such as Ollama.

### REQ-6 — Docs and packaging match the behaviour
- `stratum/docs/API_REFERENCE.md` SHALL state which requests need auth in each mode.
- The local setup docs SHALL name the new variables and the reason for the default.
- `stratum/Dockerfile` SHALL be removed (owner decision O-11: no deployment; Compose already covers local use). Every doc that tells a user to run it SHALL be removed or rewritten.

## Acceptance criteria

Tests live in `stratum/test/proxy/local-network.test.ts` unless stated. Each test title names its AC as `specs/security/stratum-local-network.md#AC-n`.

- **AC-1** (REQ-1). Given personal mode, when a preflight arrives with `Origin: https://evil.example`, the response is 403 with no `Access-Control-Allow-Origin`. When a GET arrives with that Origin and a loopback Host, the response carries no `Access-Control-Allow-Origin`.
- **AC-2** (REQ-2). Given personal mode:
  - `GET /health` with `Host: evil.example:4080` returns 403;
  - with `Host: 127.0.0.1:4080`, `localhost:4080`, `[::1]:4080` or `localhost` it returns 200;
  - with no `Host` it returns 403.
- **AC-3** (REQ-1, REQ-2). Given auth configured:
  - a foreign `Host` is accepted;
  - an Origin not in `STRATUM_CORS_ORIGINS` gets no `Access-Control-Allow-Origin`;
  - a listed Origin gets its own origin back;
  - with `STRATUM_ALLOWED_HOSTS=proxy.lan`, `Host: other.lan` returns 403 and `Host: proxy.lan` is accepted.
- **AC-4** (REQ-3). The following start behaviours hold (a start-options or `start()` test; spawn the entry point where the check lives in `start()`):
  - `STRATUM_HOST=0.0.0.0` without auth refuses to start and exits non-zero with the message;
  - the same with `STRATUM_ALLOW_REMOTE_UNAUTHENTICATED=1` starts and logs a warning;
  - the same with auth configured starts;
  - `HOST=0.0.0.0` alone behaves like `STRATUM_HOST` and logs the deprecation warning.
- **AC-5** (REQ-4). Each of `RATE_LIMIT_MAX=abc`, `RATE_LIMIT_MAX=0`, `PORT=0`, `PORT=70000` and `PORT=x` makes startup exit non-zero with a message naming the variable. Unset values keep today's defaults (100 and 4080).
- **AC-6** (REQ-5). The following base URLs behave as stated:
  - `ANTHROPIC_BASE_URL=http://10.0.0.5:8080` refuses to start;
  - the same with `STRATUM_ALLOW_INSECURE_UPSTREAM=1` starts;
  - `CQ_LOCAL_BASE_URL=http://127.0.0.1:11434/v1` starts;
  - an `https` URL starts;
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:4080` with the proxy on port 4080 refuses (self-loop).
- **AC-7** (goal). The default path still works with no new settings:
  - the root `npm run setup` smoke boot (`stratum/scripts/smoke-setup.ts`) and `tests/setup-local.test.mjs` pass unchanged;
  - a `POST /v1/messages` with no `Origin` header and `Host: localhost:4080`, against an injected fake upstream, is served.
- **AC-8** (REQ-6):
  - `git ls-files stratum/Dockerfile` is empty;
  - `git grep -n "docker run.*stratum-proxy\|HOST=0.0.0.0" -- stratum/docs docs README.md` finds nothing;
  - API_REFERENCE states the per-mode auth rule.

## Falsified by

- Any request from a foreign Origin or a foreign Host that gets a 2xx, or an `Access-Control-Allow-Origin` header, from a proxy with no auth configured.
- A proxy with no auth configured and without the opt-in that starts listening on a non-loopback address.
- `RATE_LIMIT_MAX=abc` or an invalid `PORT` that starts the proxy.

## Out of scope

- Secrets at rest and redaction (cycle S2, `specs/security/stratum-secret-hygiene.md`).
- Supply chain (S3).
- Authentication in personal mode. A loopback-only default with the Host allow-list closes the browser path without asking users to manage a key.
- TLS for the local listener.

## Changes for users

- Nothing changes for an AI client on the same machine.
- A browser app that called the proxy from another origin stops working. None is documented.
- A setup that exported `HOST` keeps working for one release, with a warning.
- A user whose model server runs on another LAN host over `http` sets `STRATUM_ALLOW_INSECURE_UPSTREAM=1`.
- Docker users use the Compose stack or run the proxy directly; the image is removed.
