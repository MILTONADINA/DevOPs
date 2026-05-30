/**
 * Anthropic provider adapter (ADR-0019) — the IDENTITY adapter.
 *
 * Anthropic is the native shape, so this adapter does no translation: it forwards the (already
 * Anthropic-shaped) request straight through the existing, battle-tested transport
 * (forwardToAnthropic / forwardStreamToAnthropic — retries, idle-abort, header passthrough, capture).
 * It exists so the router treats Anthropic like every other provider behind the same Provider contract.
 */

import { forwardToAnthropic, type MessagesBody, type ForwardHeaders, type ForwardResult } from "../forward";
import { forwardStreamToAnthropic, type StreamForwardResult } from "../stream-forward";
import type { Provider, ProviderCredentials } from "./types";

export const anthropicProvider: Provider = {
  name: "anthropic",
  forward(model: string, body: MessagesBody, creds: ProviderCredentials, passthrough?: ForwardHeaders): Promise<ForwardResult> {
    // Honor the resolved native model (e.g. an "anthropic/" prefix was stripped); otherwise unchanged.
    return forwardToAnthropic({ ...body, model }, creds.apiKey, creds.baseUrl, passthrough);
  },
  forwardStream(model: string, body: MessagesBody, creds: ProviderCredentials, passthrough?: ForwardHeaders): Promise<StreamForwardResult> {
    return forwardStreamToAnthropic({ ...body, model }, creds.apiKey, creds.baseUrl, passthrough);
  },
};
