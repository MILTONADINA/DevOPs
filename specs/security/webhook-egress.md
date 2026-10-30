# Webhook egress

**Status**: draft (story dv-webhook; awaiting owner approval)
**Spec ID**: security/webhook-egress
**Decision context**: DevOPs is open source and local-first. The webhook URL is chosen by the operator of the proxy (or, in team mode, by an org admin), so delivering to it is an outbound request to a configurable target. `specs/security/stratum-local-network.md` covers inbound traffic and provider base URLs; nothing covered webhook delivery in `runtime/src/webhooks/`.

## Problem

`runtime/src/webhooks/deliver.ts` blocked only literal private IPs and documented DNS rebinding as undefended: a public hostname could resolve to `127.0.0.1` or `169.254.169.254` at connect time. It also made a single attempt, treated every failure alike, and kept no record of an event that was never delivered. The literal check used string prefixes, which miss encodings such as NAT64, 6to4 and CGNAT.

## Definitions

- **Public address.** An IP literal that is outside 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, `::`, `::1`, fc00::/7, fe80::/10, ff00::/8 and 2001::/32, and whose embedded IPv4 (IPv4-mapped, IPv4-compatible, 64:ff9b::/96, 2002::/16) is itself public.
- **Attempt.** One resolve, vet and connect sequence.

## Requirements

### REQ-1 — Vet every resolved address
**Enforced by:** test:runtime/test/webhooks/address-guard.test.ts; test:runtime/test/webhooks/egress.test.ts
WHEN a delivery attempt starts, THE DELIVERY SHALL resolve the hostname once, and IF the answer is empty or any returned address is not a public address, THEN it SHALL refuse the attempt without connecting, as a non-retryable `ssrf_blocked` failure. Address checks SHALL be numeric (bytes against CIDR ranges), and an address that does not parse SHALL be refused.

### REQ-2 — Pin the connection
**Enforced by:** test:runtime/test/webhooks/egress.test.ts
THE DELIVERY SHALL connect to exactly an address it vetted in the same attempt, on a connection opened for that attempt (no reused keep-alive socket), with the TLS server name and the Host header left as the URL hostname (no TLS server name for an IP literal, and an IPv6 literal bracketed in Host), and SHALL NOT resolve again between the check and the connect. THE DELIVERY SHALL judge the attempt on the response status line and headers and SHALL NOT await the body, so a slow or endless body on a 2xx neither delays nor fails it.

### REQ-3 — No redirects, URL checks
**Enforced by:** test:runtime/test/webhooks/egress.test.ts
THE DELIVERY SHALL NOT follow a redirect: a 3xx answer is a non-retryable `redirect` failure. IF the URL is not http(s), has userinfo, or names `localhost`, a `.localhost` name or a non-public IP literal, THEN the delivery SHALL refuse it before any lookup.

### REQ-4 — Bounded, classified retries
**Enforced by:** test:runtime/test/webhooks/retry.test.ts; test:runtime/test/webhooks/egress.test.ts
THE RETRIER SHALL retry only a failure that is a network error, a timeout, a 5xx or a 429, using the documented 5s, 30s, 5min, 30min, 2hr schedule with each delay jittered by plus or minus 20%. WHERE the response carries a valid Retry-After, the retrier SHALL use it instead, clamped to the longest scheduled delay, and SHALL ignore a negative or unparseable value. IF the next retry would end more than the total-time cap (3 hours) after the first attempt, THEN the retrier SHALL stop with `budget_exhausted`. It SHALL NOT retry any other 4xx, a redirect or an `ssrf_blocked` refusal, and SHALL NOT retry a result whose `retryable` is not exactly `true`.

### REQ-5 — Local dead-letter record
**Enforced by:** test:runtime/test/webhooks/dead-letter.test.ts
WHEN delivery is given up, THE RETRIER SHALL report the event, and the dead-letter store SHALL write one file `<eventId>.json` in a 0700 directory inside the project root, containing only the event id, the URL hostname and port, the attempt count, the last status, the failure class and the first and last attempt times. IF the event id does not match `evt_` followed by 36 characters of `[0-9a-f-]`, THEN the store SHALL write nothing. The record SHALL NOT contain the URL path, query or userinfo, a raw error message, the body, the secret or the signature. A repeated event id keeps the first record, and a failed dead-letter write (or a throwing scheduler) is reported through the retrier's `onError` hook and never rejects `send`.

## Acceptance criteria

Test titles name the cases below.

- **AC-1** (REQ-1). Hostnames that resolve to 169.254.169.254, to a list mixing a public and a private address, to `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe`, `64:ff9b::7f00:1`, `2002:0a00:0001::`, a Teredo address, 100.64.0.1, 0.0.0.0, 255.255.255.255, fd00::1, fe80::1 or ff02::1 are refused and the transport is never called. An empty answer is refused. A throwing resolver is a retryable `network` failure with no connection. A resolver that never answers is aborted at the attempt timeout.
- **AC-2** (REQ-2). The lookup is called once per attempt and the transport receives that address and the hostname. A local server that the transport is pointed at by address sees `Host: <hostname>:<port>`, with an IPv6 literal bracketed. An https request to an IP-literal host does not fail with `ERR_INVALID_ARG_VALUE`. Two attempts open two connections. A server that sends a 200 head and a partial body and never ends yields `delivered: true, status: 200` in under the attempt timeout.
- **AC-3** (REQ-3). A 302, 307 or 308 with a Location pointing at `http://127.0.0.1:1` produces exactly one request at the server and `delivered: false`, `retryable: false`, `reasonClass: "redirect"`. `ftp:`, `file:`, `data:`, `https://u:p@host/`, `LOCALHOST`, `localhost.`, `a.localhost` and a `:0` port are refused.
- **AC-4** (REQ-4). 400, 401, 403, 404 and 410 schedule nothing and dead-letter after one attempt; 429 and 503 schedule a retry. With `random` fixed at 0.5 the delays equal the documented schedule. Retry-After `999999999` is clamped, `-5` and `garbage` are ignored, a past date gives 0. A cap that cannot hold the next delay ends with `budget_exhausted`.
- **AC-5** (REQ-5). The record for `https://u:p@host/path?token=x` contains none of `u:p`, `/path`, `token`, the secret, the body or `sha256=`. An event id of `../../x` throws and writes no file. An unparseable URL records a null host and no port. A repeated event id keeps the first record. A dead-letter directory reached through a symlink that escapes the root throws and creates nothing outside it.

## Falsified by

- A webhook delivery that connects to an address in a blocked range, to an address that was not vetted in the same attempt, or after a redirect.
- A 4xx other than 429, a redirect or an `ssrf_blocked` refusal that is retried.
- A dead-letter file that holds a URL path, query, credential, body, secret or signature.

## Out of scope

- The inbound proxy listener (`specs/security/stratum-local-network.md`) and webhook signing and idempotency (`specs/phase-2/G-webhook-idempotency.md`).
- A durable queue: retries are in-memory, so a restart drops pending retries. The dead-letter directory holds only events that exhausted their retries or failed permanently while the process ran; it is a local file, not the dashboard list that `runtime/docs/WEBHOOKS.md` describes for the hosted product.
- Replaying dead-lettered events.
- RFC 8215 local-use NAT64 `64:ff9b:1::/48` is refused outright rather than decoded.
