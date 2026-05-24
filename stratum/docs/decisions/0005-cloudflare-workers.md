# ADR-0005: Cloudflare Workers Over Traditional Node.js Server

**Date:** 2026-04-06
**Status:** Accepted

## Context

The CQ proxy needs to intercept Anthropic API calls with sub-50ms added latency globally. We need a runtime for the proxy layer. The main candidates are: a traditional Node.js/Fastify server on a VPS or cloud VM, and Cloudflare Workers (edge compute).

## Decision

Use Cloudflare Workers as the production proxy runtime, with Durable Objects for stateful session management.

## Consequences

- Global edge deployment: Workers run in 300+ locations, placing the proxy near the developer by default
- No cold starts: Workers are always warm, unlike Lambda or Cloud Run
- Durable Objects provide strongly-consistent session state without an external Redis layer
- 128MB memory limit per Worker — heavy compute (embedding, ONNX) must run client-side or in a separate service
- Wrangler CLI is the deployment tool — straightforward but adds a build step
- Local development requires `wrangler dev` or a Fastify fallback (we use Fastify for Phase 1 local dev)
- CPU time limits exist — streaming LLM responses require careful handling to avoid timeouts

## Alternatives Considered

**Traditional Node.js on a VPS (DigitalOcean, Hetzner):** Rejected because it requires manual scaling, is single-region by default, adds 50–150ms latency for developers far from the server, and requires managing uptime. The latency target (<50ms added) is not achievable from a single region.

**AWS Lambda / Google Cloud Run:** Rejected because cold starts (100–500ms) violate the latency target for the first request in a session. Provisioned concurrency solves this but at significant cost premium. Also single-region unless manually multi-region.

**Fly.io:** Closer to the right model (global, low-latency), but Durable Objects (for session state) are a Cloudflare-specific primitive. Replicating that behavior on Fly requires external state management complexity.
