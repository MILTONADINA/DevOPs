/**
 * Production message-route deps (ADR-0019) — wires the multi-provider router into MessagesDeps.
 *
 * Moved out of forward.ts so forward.ts stays the Anthropic-transport leaf (no provider/router import
 * cycle). Boots with ANY configured provider (Anthropic, OpenAI, OpenRouter, Gemini, or a local
 * OpenAI-compatible server) — it no longer requires ANTHROPIC_API_KEY; it requires at least one provider.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCaptureStore } from "./capture";
import type { MessagesDeps } from "./forward";
import { withRetry, withStreamRetry } from "./retry";
import { resolveTelemetrySink } from "./telemetry";
import { configuredProviders, createRoutedCounter, createRoutedForward, createRoutedStreamForward } from "./providers/router";

/**
 * Build the real (production) message-route deps: the multi-provider router (forward + streaming + token
 * counting) + a disk-backed capture store. Called by the entry point at start().
 *
 * @returns wired {@link MessagesDeps}.
 * @throws {Error} if NO provider is configured (no Anthropic/OpenAI/OpenRouter/Gemini key + no local base URL).
 */
export function createDefaultMessagesDeps(): MessagesDeps {
  const configured = configuredProviders();
  if (configured.length === 0) {
    throw new Error("no LLM provider configured — set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or CQ_LOCAL_BASE_URL");
  }

  // The Anthropic SDK client is needed ONLY for exact token counting of Anthropic models; build it only
  // when an Anthropic key is present, so an OpenAI-only / local-only deployment boots without one.
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const client = anthropicKey !== undefined && anthropicKey !== "" ? new Anthropic({ apiKey: anthropicKey }) : null;

  const sessionId = randomUUID();
  // CQ_CAPTURE_DIR lets a deployment redirect the on-disk capture artifact off the (often read-only) app
  // root — e.g. a serverless host where only /tmp is writable. Default unchanged (<cwd>/data/sessions).
  const captureDir = process.env["CQ_CAPTURE_DIR"] ?? path.join(process.cwd(), "data", "sessions");
  const outputFile = path.join(captureDir, `session-${sessionId}.json`);

  // BOTH paths get the retry/backoff policy (429 Retry-After / 5xx jitter / one network retry), now over the
  // router-backed forward (the apiKey arg is ignored — each provider resolves its own creds from the model).
  const forward = withRetry(createRoutedForward());
  const forwardStream = withStreamRetry(createRoutedStreamForward());
  const counter = createRoutedCounter(client);

  return {
    apiKey: anthropicKey ?? "", // vestigial under multi-provider routing (kept for the MessagesDeps contract)
    forward,
    forwardStream,
    countTokens: (body) => counter.count(body),
    capture: createCaptureStore({ sessionId, outputFile }),
    telemetry: resolveTelemetrySink(),
  };
}
