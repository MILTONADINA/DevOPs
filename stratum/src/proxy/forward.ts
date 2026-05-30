/**
 * Anthropic forwarding + exact token counting for the Phase 1 proxy.
 *
 * Phase 1 forwards requests UNCHANGED to the upstream Anthropic Messages API
 * over the same axios transport the capture script proved, and counts tokens
 * with the SDK's exact countTokens endpoint (NEVER tiktoken, never silently
 * estimated — the billing model depends on provable counts). The base URL is
 * env-configurable (Q4) with fail-fast validation.
 *
 * Everything here is exported as small functions + a default-deps factory so
 * the route (routes/messages.ts) can take injectable deps and be tested
 * hermetically (no real network/SDK) via app.inject().
 */

import axios from "axios";
import { getAnthropicClient } from "../lib/anthropic";
import { createCaptureStore, type CaptureStore } from "./capture";
import { withRetry, withStreamRetry } from "./retry";
import { createTokenCounter } from "./token-count";
import { forwardStreamToAnthropic, type StreamForwardResult } from "./stream-forward";
import { resolveTelemetrySink, type TelemetrySink } from "./telemetry";
import type { TokenBudget } from "./token-budget";
import type { UsageEvent } from "../billing/usage-recorder";
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Anthropic-compatible request body the proxy forwards. */
export interface MessagesBody {
  model: string;
  messages: { role: string; content: unknown }[];
  system?: unknown;
  tools?: unknown[];
  max_tokens: number;
  /** Set by the client (or injected on the streaming path so the upstream actually returns SSE). */
  stream?: boolean;
}

export interface ForwardResult {
  status: number;
  data: unknown;
  /** Lower-cased response headers (used by retry/backoff to honor Retry-After). */
  headers?: Record<string, string>;
}

/**
 * Client request headers a TRANSPARENT proxy must pass through to Anthropic: the API version the
 * client targets, and any `anthropic-beta` opt-ins (dropping these silently degrades a partner's
 * beta features). The proxy supplies its own auth (`x-api-key`); these are the client's intent.
 */
export interface ForwardHeaders {
  /** Client's `anthropic-version` (defaults to "2023-06-01" upstream when absent). */
  anthropicVersion?: string;
  /** Client's `anthropic-beta` (comma-joined if the client sent several). */
  anthropicBeta?: string;
}

export interface TokenCountResult {
  input_tokens: number;
  /** "exact" (SDK countTokens) or "estimated" (fallback). Never silently exact. */
  token_count_method: "exact" | "estimated";
  message_breakdown: { role: string; token_count: number }[];
}

/** Deps the /v1/messages route needs — injectable so tests avoid real network. */
export interface MessagesDeps {
  forward: (body: MessagesBody, apiKey: string, passthrough?: ForwardHeaders) => Promise<ForwardResult>;
  /** Streaming forward (axios responseType:'stream'); used when the client asks for SSE. */
  forwardStream: (body: MessagesBody, apiKey: string, passthrough?: ForwardHeaders) => Promise<StreamForwardResult>;
  countTokens: (body: MessagesBody) => Promise<TokenCountResult>;
  capture: CaptureStore;
  apiKey: string;
  /** Per-turn telemetry sink (Q7 soft-dep). Default: structured-log fallback. */
  telemetry?: TelemetrySink;
  /** Optional per-org token-budget limiter (commercial mode); checked before forwarding. */
  tokenBudget?: TokenBudget;
  /**
   * Optional commercial usage persistence (writes a signed billing_record per request to Supabase so a
   * design partner sees their usage + the invoice has a basis). Best-effort + fail-open — never blocks
   * or fails a proxied response. Only meaningful with an authenticated org (req.orgId).
   */
  recordUsage?: (event: UsageEvent) => Promise<void>;
}

/**
 * Resolve + validate the upstream base URL (Q4). Env-var primary, safe default,
 * http(s)-only. Throws on an invalid value (the entry point turns this into a
 * fail-fast exit; a thrown error keeps this module testable).
 *
 * @param raw - the candidate base URL (defaults to process.env.ANTHROPIC_BASE_URL).
 * @returns the validated base URL with any trailing slashes stripped.
 * @throws {Error} if the URL is unparseable or not http(s).
 */
export function resolveAnthropicBaseUrl(raw: string = process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com"): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ANTHROPIC_BASE_URL is not a parseable URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`ANTHROPIC_BASE_URL must use http:// or https://; got: ${parsed.protocol} (${raw})`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Total request timeout (ms) for the NON-streaming upstream call. Env CQ_UPSTREAM_TIMEOUT_MS (default
 * 120s). A non-streaming response is bounded, so a whole-request cap is correct: it prevents a hung
 * upstream (no response, no close) from pinning a worker indefinitely. Surfaces as a network error →
 * one retry (withRetry) → 502. NOT used on the streaming path (a long stream would tripwire a total cap).
 *
 * @returns the timeout in ms.
 */
export function upstreamTimeoutMs(): number {
  const n = Number(process.env["CQ_UPSTREAM_TIMEOUT_MS"]);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/**
 * IDLE timeout (ms) for the STREAMING upstream call — the max gap between bytes before the connection is
 * treated as hung and aborted. Env CQ_UPSTREAM_IDLE_MS (default 60s). Re-armed on every chunk, so a
 * legitimately-long stream that keeps emitting tokens never trips it; only a genuinely stalled stream does.
 *
 * @returns the idle timeout in ms.
 */
export function upstreamIdleMs(): number {
  const n = Number(process.env["CQ_UPSTREAM_IDLE_MS"]);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Forward a request to the upstream Anthropic Messages API (unchanged).
 *
 * @param body - the Anthropic request body.
 * @param apiKey - the Anthropic API key.
 * @param baseUrl - resolved upstream base URL.
 * @returns the upstream status + response data.
 * @throws re-throws non-HTTP (network) errors for the caller to surface as 500.
 */
export async function forwardToAnthropic(body: MessagesBody, apiKey: string, baseUrl: string = resolveAnthropicBaseUrl(), passthrough?: ForwardHeaders): Promise<ForwardResult> {
  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    // Forward the CLIENT's API version (transparent proxy); default to the stable version if absent.
    "anthropic-version": passthrough?.anthropicVersion ?? "2023-06-01",
    "content-type": "application/json",
  };
  // Pass through anthropic-beta so a partner's beta opt-ins are not silently dropped.
  if (passthrough?.anthropicBeta !== undefined && passthrough.anthropicBeta !== "") {
    reqHeaders["anthropic-beta"] = passthrough.anthropicBeta;
  }
  const res = await axios.post(`${baseUrl}/v1/messages`, body, {
    headers: reqHeaders,
    // Let the caller see 4xx/5xx bodies rather than throwing on them.
    validateStatus: () => true,
    // Bound the whole request so a hung upstream can't pin a worker (non-streaming is bounded; PB-49).
    timeout: upstreamTimeoutMs(),
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((res.headers ?? {}) as Record<string, unknown>)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }
  return { status: res.status, data: res.data, headers };
}

/**
 * Exact token count via the Anthropic SDK. On failure, returns an honestly
 * flagged estimate (input_tokens 0, method "estimated") rather than throwing —
 * the hardened cache + tokenizer fallback lands in a later §2d increment.
 *
 * @param body - the Anthropic request body.
 * @param client - the Anthropic SDK client.
 * @returns the input token count + per-message breakdown + method flag.
 */
export async function countTokensExact(body: MessagesBody, client: Anthropic): Promise<TokenCountResult> {
  const result = await client.messages.countTokens({
    model: body.model,
    messages: body.messages as Anthropic.MessageParam[],
    ...(body.system !== undefined ? { system: body.system as string } : {}),
    ...(body.tools !== undefined ? { tools: body.tools as Anthropic.Tool[] } : {}),
  });
  return {
    input_tokens: result.input_tokens,
    token_count_method: "exact",
    message_breakdown: [],
  };
}

/**
 * Build the real (production) message-route deps: axios forward + SDK token
 * counter + a disk-backed capture store. Called by the entry point at start().
 *
 * @returns wired {@link MessagesDeps}.
 * @throws {Error} if ANTHROPIC_API_KEY is unset or ANTHROPIC_BASE_URL invalid.
 */
export function createDefaultMessagesDeps(): MessagesDeps {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set in environment");
  const baseUrl = resolveAnthropicBaseUrl();
  const client = getAnthropicClient();

  const sessionId = randomUUID();
  // CQ_CAPTURE_DIR lets a deployment redirect the on-disk capture artifact off the (often read-only)
  // app root — e.g. a serverless host where only /tmp is writable. Default unchanged (<cwd>/data/sessions).
  const captureDir = process.env["CQ_CAPTURE_DIR"] ?? path.join(process.cwd(), "data", "sessions");
  const outputFile = path.join(captureDir, `session-${sessionId}.json`);

  // Forward with retry/backoff (429 Retry-After / 5xx jitter / network 1-retry). BOTH paths retry —
  // the streaming path (the majority of partner traffic) used to get none, so a transient 429/5xx
  // surfaced to the partner immediately while the non-streaming path silently recovered.
  const forward = withRetry((body, key, passthrough) => forwardToAnthropic(body, key, baseUrl, passthrough));
  const forwardStream = withStreamRetry((body, key, passthrough) => forwardStreamToAnthropic(body, key, baseUrl, passthrough));
  // Exact token counting with hash-cache + flagged heuristic fallback.
  const counter = createTokenCounter(client);

  return {
    apiKey,
    forward,
    forwardStream,
    countTokens: (body) => counter.count(body),
    capture: createCaptureStore({ sessionId, outputFile }),
    telemetry: resolveTelemetrySink(),
  };
}
