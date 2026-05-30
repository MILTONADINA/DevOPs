# ADR-0019: Multi-Provider Gateway — Anthropic-Shaped Surface, Provider Adapters Behind It

**Date:** 2026-05-30
**Status:** Accepted (Anthropic-in / any-provider-out; an OpenAI-compatible INBOUND surface is a documented, additive follow-on)

## Context

Stratum began as an Anthropic Messages API proxy: `POST /v1/messages` takes an Anthropic-shaped body,
`forwardToAnthropic`/`forwardStreamToAnthropic` call `api.anthropic.com`, and every value-add downstream —
capture/redaction, the SSE accumulator (`sse.ts`), usage billing (`messages.ts` reads
`response.usage.{input,output}_tokens`), telemetry, and the waste/pruning model — assumes the **Anthropic
response shape**. Operators want to route the SAME proxy (and its measurement/billing) at OpenAI, Google
Gemini, OpenRouter, and local/OpenAI-compatible servers (Ollama, LM Studio, vLLM, llama.cpp).

The constraint that drives the design: the proxy's value is the *measurement + savings* layer, and that
layer is wired to the Anthropic response shape. Re-plumbing capture/billing/accumulator for N native
provider shapes would be a large, bug-prone change touching the money path. The provider differences are
also mostly in *request/response translation*, not in the proxy's own logic.

## Decision

1. **Keep the inbound surface Anthropic-shaped; translate per provider behind a `Provider` interface.**
   The client still speaks Anthropic (`POST /v1/messages`) and still receives an Anthropic-shaped Message
   (and Anthropic SSE). A `Provider` adapter takes the Anthropic-shaped request, translates it to the
   provider's native API, calls it, and translates the response **back to the Anthropic shape** — a Message
   object for the non-stream path, and Anthropic SSE chunk strings (`message_start` → `content_block_delta`
   → `message_delta` w/ usage → `message_stop`) for the stream path. Result: `messages.ts`, `capture.ts`,
   `sse.ts`, the billing recorder, and telemetry are **unchanged and provider-agnostic** — they always see
   Anthropic shapes regardless of backend. "Speak Anthropic, run anywhere."

2. **One OpenAI-compatible adapter serves OpenAI, OpenRouter, and local servers.** They share the
   `/chat/completions` contract; they differ only by base URL, key, and a couple of optional headers
   (OpenRouter's `HTTP-Referer`/`X-Title`). Gemini gets its own adapter (`generateContent`). Anthropic is
   wrapped as the identity adapter (no translation).

3. **Route by model id, default-safe.** Resolution order: an explicit `provider/model` prefix
   (`openai/…`, `gemini/…`, `openrouter/…`, `local/…`, `anthropic/…`) → name heuristics (`claude*`→anthropic,
   `gpt*`/`o[0-9]*`/`chatgpt*`→openai, `gemini*`→gemini) → the env default `CQ_DEFAULT_PROVIDER` (default
   `anthropic`). A bare `claude-*` model therefore still routes to Anthropic exactly as before — **zero
   behavior change** for existing clients and tests.

4. **Per-provider credentials from env; no stored customer keys.** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/
   `OPENROUTER_API_KEY`/`GEMINI_API_KEY` (+ per-provider `*_BASE_URL`, and `CQ_LOCAL_BASE_URL`/
   `CQ_LOCAL_API_KEY` for local). A model that routes to an un-configured provider returns a clean
   `provider not configured` error, never a crash. (Per-request pass-through, ADR-0018, extends naturally:
   each provider can take the tenant's own key from a header instead of env — additive, default-off.)

5. **Token counting + pricing are provider-aware.** Exact pre-flight counting stays the Anthropic SDK path
   for Anthropic models; other providers fall back to the existing honestly-flagged `estimated` heuristic
   (Gemini's `countTokens` can be added later). Billing always uses the **upstream-confirmed** usage the
   adapter normalizes from the provider response (OpenAI `prompt_tokens`/`completion_tokens`, Gemini
   `usageMetadata`) — the exact-counts rule (CLAUDE.md) holds because the number comes from the provider,
   not an estimate. Pricing (`pricing.ts`) gains verified per-family list prices; OpenRouter/local default
   to passthrough/0 (the operator sets `CQ_INPUT_PRICE_PER_TOKEN` for a negotiated/local rate).

## Consequences

- The money/measurement layer is untouched and keeps its test coverage; risk concentrates in the pure,
  heavily-unit-tested translation functions (request out, response back, SSE re-emit) rather than the
  request hot path or the billing code.
- A Claude Code (or any Anthropic-format) client can target OpenAI/Gemini/OpenRouter/local models through
  Stratum with no client change — just the model id (or a `provider/` prefix).
- Existing Anthropic behavior is preserved bit-for-bit (identity adapter + default routing), so this is a
  backward-compatible extension, not a rewrite.
- An **OpenAI-compatible INBOUND** endpoint (`POST /v1/chat/completions`) is a clean follow-on: translate
  inbound OpenAI→Anthropic at the edge, reuse the same provider adapters. Deferred (most immediate value is
  Anthropic-in/any-out for the current user); recorded here so the surface is intentional, not accidental.

## Alternatives Considered

- **Re-plumb capture/billing/accumulator to handle each provider's native shape.** Rejected: large change
  across the money path for every provider, multiplying the surface that must stay exact; the translate-to-
  Anthropic-shape choice confines all provider variance to pure functions.
- **Shell out to LiteLLM / proxy to OpenRouter for everything.** Rejected: adds a dependency/hop and hides
  the token usage Stratum must measure exactly for billing; OpenRouter is supported as *a* backend, not as
  the universal translation layer.
- **Expose only an OpenAI-compatible inbound surface and drop the Anthropic shape.** Rejected: the existing
  clients (incl. Claude Code) and the entire measurement/billing layer are Anthropic-shaped; that would be a
  rewrite with no benefit over keeping Anthropic-in and adding OpenAI-in later.
