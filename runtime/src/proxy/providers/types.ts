/**
 * Multi-provider gateway — the Provider contract (ADR-0019).
 *
 * Every backend (Anthropic, OpenAI-compatible, Gemini, …) implements the SAME contract: it accepts an
 * ANTHROPIC-shaped request and returns an ANTHROPIC-shaped result — a Message object for `forward()` and
 * Anthropic SSE chunk strings for `forwardStream()`. All translation to/from the provider's native API
 * lives INSIDE the adapter, so the route, capture/redaction, the SSE accumulator, billing, and telemetry
 * stay provider-agnostic (they always see Anthropic shapes). "Speak Anthropic, run anywhere."
 */

import type { ForwardHeaders, ForwardResult, MessagesBody } from "../forward";
import type { StreamForwardResult } from "../stream-forward";

/** Resolved upstream endpoint + auth for one provider call. */
export interface ProviderCredentials {
  /** The provider's API key (Bearer/x-api-key/?key= depending on the adapter). May be "" for a keyless local server. */
  apiKey: string;
  /** The provider base URL (no trailing slash), e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** Extra request headers some providers want (e.g. OpenRouter's HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
}

/**
 * A backend LLM provider adapter.
 *
 * Contract: `forward` returns a {@link ForwardResult} whose `data` is an Anthropic Message object
 * (`{ id, type:"message", role:"assistant", model, content:[…], stop_reason, usage:{input_tokens,
 * output_tokens} }`); `forwardStream` returns a {@link StreamForwardResult} whose `stream` yields
 * Anthropic SSE chunk strings. The `model` argument is the PROVIDER-NATIVE model id (any `provider/`
 * routing prefix already stripped) — the adapter sends that, not `body.model`.
 */
export interface Provider {
  /** Stable id: "anthropic" | "openai" | "openrouter" | "gemini" | "local". */
  readonly name: string;
  /**
   * Forward a non-streaming request and return an Anthropic-shaped result.
   * @throws on a network/transport error (the caller maps to 502); HTTP 4xx/5xx come back IN the result.
   */
  forward(model: string, body: MessagesBody, creds: ProviderCredentials, passthrough?: ForwardHeaders): Promise<ForwardResult>;
  /**
   * Forward a streaming request; the result's `stream` yields Anthropic SSE chunk strings (so the existing
   * tee + accumulator + billing work unchanged), or `data` carries a passed-through non-2xx error body.
   * @throws on a network/transport error before any byte (the caller maps to 502).
   */
  forwardStream(model: string, body: MessagesBody, creds: ProviderCredentials, passthrough?: ForwardHeaders): Promise<StreamForwardResult>;
}

/** The resolved destination for an inbound model id: which provider, which native model, with what creds. */
export interface ProviderRoute {
  provider: Provider;
  /** Provider-native model id (routing prefix stripped). */
  model: string;
  creds: ProviderCredentials;
}
