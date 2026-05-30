# ADR-0018: The Upstream Anthropic Key in Commercial Mode — Per-Deployment for the Pilot, Per-Request Pass-Through to Scale

**Date:** 2026-05-30
**Status:** Accepted (per-deployment key for the first design partner; per-request pass-through is the documented scale path, default-OFF until taken up)

## Context

Tracing the commercial request path surfaced an undocumented architectural decision: `POST /v1/messages`
forwards to Anthropic using `deps.apiKey` — the single `ANTHROPIC_API_KEY` from the deployment's env —
for **every** tenant (`src/proxy/routes/messages.ts` → `forwardToAnthropic`, which sets `x-api-key` from
that one key). The tenant authenticates with their **CQ key** (`Authorization: Bearer cq_…` / `x-api-key`,
resolved to an org by the auth gate); that CQ key is consumed by the gate and is NOT forwarded upstream
(the forward builds its own headers), so there is **no key leak** — but all tenants share one upstream key.

This matters because of the business model: CQ bills **20% of token SAVINGS**, it does NOT resell Anthropic
tokens. The savings accrue on the key whose Anthropic bill drops when context is pruned. So the question is:
*whose* Anthropic key does the proxy forward on?

- **For the FIRST design partner (the v1.0.0 milestone — one paying partner):** a dedicated deployment with
  `ANTHROPIC_API_KEY` set to **the partner's** key is correct and sufficient. Their traffic forwards on their
  key → their Anthropic bill reflects the pruning reduction → CQ bills 20% of that measured saving. One
  partner, one instance, one key. No code change needed; this is what's built.

- **To scale to MANY partners on shared infrastructure:** a single shared key is wrong (CQ would pay everyone's
  Anthropic bill, tenants would collide on one account's rate limits, and savings could not be attributed
  per-tenant). Each request must forward on the requesting tenant's own Anthropic key.

## Decision

1. **Ship the per-deployment env key for the first design partner.** Single-tenant: `ANTHROPIC_API_KEY` =
   the partner's key, a dedicated instance (the container from ADR-deployment / `Dockerfile`). This is the
   v1.0.0 pilot architecture — valid, simplest, and requires nothing new.

2. **The documented scale path is per-request PASS-THROUGH, not key storage.** When multi-tenant-on-shared-infra
   is taken up: the tenant's SDK sets its `apiKey` to **its own Anthropic key** (sent as `x-api-key`, forwarded
   upstream unchanged), and supplies the **CQ key** for our auth/billing via a dedicated header (`x-cq-api-key`).
   The auth gate resolves the org from `x-cq-api-key`; the forward uses the request's `x-api-key` (the tenant's
   Anthropic key) instead of `deps.apiKey`. No customer key is ever stored. This is additive — when
   `x-cq-api-key` is absent the current single-key behaviour is unchanged — so it is a backward-compatible
   evolution, but it changes the partner-facing auth contract, so it is **default-OFF and gated on an explicit
   product decision** (the header name + onboarding doc are a partner-visible commitment).

3. **Do NOT store customer Anthropic keys server-side.** Storing third-party API secrets is a liability that
   would require the same encryption-at-rest + TEE posture the constitution gates (crypto.ts stays a stub until
   AWS Nitro attestation + a security review; ADR-0003/SECURITY.md). Pass-through avoids storage entirely and is
   therefore the recommended scale design over a per-org stored key.

## Consequences

- The first paid invoice (v1.0.0) is unblocked by this decision: a single-partner pilot needs no new code —
  point a dedicated deployment's `ANTHROPIC_API_KEY` at the partner's key.
- The path to N tenants is written down and is pass-through (no key vault, no TEE dependency) — a contained,
  backward-compatible change when the second partner arrives.
- This is recorded so the shared-env-key behaviour is never mistaken for a bug or a multi-tenant-ready state:
  it is a deliberate, scoped pilot choice with a known evolution.

## Alternatives Considered

- **Store a per-org Anthropic key (encrypted) and forward with it.** Rejected as the default scale path:
  storing customer API secrets pulls in the gated encryption/TEE posture (ADR-0003) and a key-rotation/secret-
  management burden. Pass-through achieves multi-tenancy with zero stored secrets.
- **Keep one shared CQ-owned Anthropic key for all tenants and resell tokens.** Rejected: that is a different
  business (a token reseller), not the savings-arbitrage model (BUSINESS_MODEL.md); CQ would carry every
  tenant's Anthropic spend and margin risk.
- **Require the Anthropic key in `Authorization` and the CQ key in `x-api-key` (no new header).** Rejected:
  ambiguous/colliding with the current gate, and the Anthropic SDK puts its key in `x-api-key`, not
  `Authorization` — `x-cq-api-key` for our side keeps the tenant's SDK usage standard (set `apiKey` = their
  Anthropic key, add one default header).
