/**
 * Multi-provider router (ADR-0019).
 *
 * Resolves an inbound (Anthropic-shaped) model id to a concrete {provider, native model, credentials},
 * and builds the router-backed `forward` / `forwardStream` / token-counter the message route consumes.
 * Routing order: an explicit `provider/` prefix → a bare-model-name heuristic → the env default
 * (CQ_DEFAULT_PROVIDER, default "anthropic"). A bare `claude-*` model therefore still routes to Anthropic
 * exactly as before — zero behavior change for existing clients.
 */

import type AnthropicSdk from "@anthropic-ai/sdk";
import { resolveAnthropicBaseUrl, type ForwardHeaders, type ForwardResult, type MessagesBody, type TokenCountResult } from "../forward";
import type { ForwardFn, StreamForwardFn } from "../retry";
import type { StreamForwardResult } from "../stream-forward";
import { createTokenCounter, type TokenCounter } from "../token-count";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { openAIProvider } from "./openai";
import type { Provider, ProviderCredentials } from "./types";

type Env = Record<string, string | undefined>;

/** Provider ids understood as a `provider/model` prefix or as CQ_DEFAULT_PROVIDER. */
const KNOWN = new Set(["anthropic", "openai", "openrouter", "gemini", "google", "local"]);

/** Canonicalize aliases ("google" → "gemini"). */
function canon(name: string): string {
  return name === "google" ? "gemini" : name;
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Split an optional, KNOWN `provider/` prefix off the model id (OpenRouter's own `vendor/model` is kept intact). */
function splitPrefix(model: string): { hint?: string; rest: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const head = model.slice(0, slash).toLowerCase();
    if (KNOWN.has(head)) return { hint: canon(head), rest: model.slice(slash + 1) };
  }
  return { rest: model };
}

/** Best-effort provider from a bare model name (no prefix). Undefined → fall back to the env default. */
function heuristic(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("chatgpt") || /^o[0-9]/.test(m) || m.startsWith("text-") || m.startsWith("davinci")) return "openai";
  if (m.startsWith("gemini")) return "gemini";
  return undefined;
}

/**
 * Resolve which provider handles `model` and the provider-native model id.
 *
 * @param model - the inbound model id (may carry a `provider/` prefix).
 * @param env - environment (reads CQ_DEFAULT_PROVIDER).
 * @returns the provider name + the native model id to send upstream.
 */
export function resolveProviderName(model: string, env: Env = process.env): { name: string; nativeModel: string } {
  const { hint, rest } = splitPrefix(model);
  if (hint !== undefined) return { name: hint, nativeModel: rest };
  const h = heuristic(model);
  if (h !== undefined) return { name: h, nativeModel: model };
  const dflt = canon((env["CQ_DEFAULT_PROVIDER"] ?? "anthropic").toLowerCase());
  return { name: KNOWN.has(dflt) ? dflt : "anthropic", nativeModel: model };
}

/**
 * Resolve a provider's upstream credentials/endpoint from env, or null if it is not configured.
 *
 * @param name - the (canonical) provider name.
 * @param env - environment.
 * @returns credentials, or null when the provider's key/base URL is unset.
 */
export function resolveCredentials(name: string, env: Env = process.env): ProviderCredentials | null {
  switch (name) {
    case "anthropic": {
      const apiKey = env["ANTHROPIC_API_KEY"];
      if (apiKey === undefined || apiKey === "") return null;
      return { apiKey, baseUrl: resolveAnthropicBaseUrl(env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com") };
    }
    case "openai": {
      const apiKey = env["OPENAI_API_KEY"];
      if (apiKey === undefined || apiKey === "") return null;
      return { apiKey, baseUrl: stripSlash(env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1") };
    }
    case "openrouter": {
      const apiKey = env["OPENROUTER_API_KEY"];
      if (apiKey === undefined || apiKey === "") return null;
      const extraHeaders: Record<string, string> = {};
      const referer = env["OPENROUTER_REFERER"];
      const title = env["OPENROUTER_TITLE"];
      if (referer !== undefined && referer !== "") extraHeaders["HTTP-Referer"] = referer;
      if (title !== undefined && title !== "") extraHeaders["X-Title"] = title;
      return { apiKey, baseUrl: stripSlash(env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1"), extraHeaders };
    }
    case "gemini": {
      const apiKey = env["GEMINI_API_KEY"] ?? env["GOOGLE_API_KEY"];
      if (apiKey === undefined || apiKey === "") return null;
      return { apiKey, baseUrl: stripSlash(env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta") };
    }
    case "local": {
      // A local OpenAI-compatible server (Ollama/LM Studio/vLLM/llama.cpp) needs only a base URL; the key
      // is usually a placeholder, so it defaults to "" (sent as an empty Bearer, which these servers ignore).
      const baseUrl = env["CQ_LOCAL_BASE_URL"];
      if (baseUrl === undefined || baseUrl === "") return null;
      return { apiKey: env["CQ_LOCAL_API_KEY"] ?? "", baseUrl: stripSlash(baseUrl) };
    }
    default:
      return null;
  }
}

/**
 * The adapters available in this build:
 *   - anthropic: identity adapter (native shape, no translation)
 *   - openai / openrouter / local: ONE OpenAI-compatible adapter (creds differ by base URL/key/headers)
 *   - gemini: the Gemini generateContent adapter
 */
const REGISTRY: Record<string, Provider> = {
  anthropic: anthropicProvider,
  openai: openAIProvider,
  openrouter: openAIProvider,
  local: openAIProvider,
  gemini: geminiProvider,
};

/** The provider names that are BOTH enabled in this build AND configured with credentials. */
export function configuredProviders(env: Env = process.env): string[] {
  return Object.keys(REGISTRY).filter((name) => resolveCredentials(name, env) !== null);
}

export type RouteResult = { ok: true; provider: Provider; model: string; creds: ProviderCredentials } | { ok: false; status: number; message: string };

/**
 * Resolve an inbound model id to a concrete route, or a clean (non-throwing) error.
 *
 * @param model - the inbound model id.
 * @param env - environment.
 * @returns the resolved {provider, native model, creds}, or an error with an HTTP status + message.
 */
export function resolveRoute(model: string, env: Env = process.env): RouteResult {
  const { name, nativeModel } = resolveProviderName(model, env);
  const provider = REGISTRY[name];
  if (provider === undefined) {
    return { ok: false, status: 400, message: `model '${model}' routes to provider '${name}', which is not enabled in this build` };
  }
  const creds = resolveCredentials(name, env);
  if (creds === null) {
    return { ok: false, status: 400, message: `model '${model}' routes to provider '${name}', which is not configured (set its API key / base URL in the environment)` };
  }
  return { ok: true, provider, model: nativeModel, creds };
}

/** An Anthropic-shaped error body (so the route passes it through verbatim like any upstream 4xx). */
function anthropicError(message: string): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type: "invalid_request_error", message } };
}

/**
 * Build the router-backed non-streaming forward (the `apiKey` arg is ignored — each provider's creds are
 * resolved from `body.model`). Wrap the result in {@link withRetry} exactly as the Anthropic path was.
 *
 * @param env - environment (read per call so config changes are picked up; cheap).
 * @returns a {@link ForwardFn}.
 */
export function createRoutedForward(env: Env = process.env): ForwardFn {
  return async (body: MessagesBody, _apiKey: string, passthrough?: ForwardHeaders): Promise<ForwardResult> => {
    const r = resolveRoute(body.model, env);
    if (!r.ok) return { status: r.status, data: anthropicError(r.message) };
    return r.provider.forward(r.model, body, r.creds, passthrough);
  };
}

/**
 * Build the router-backed streaming forward (Anthropic SSE out, regardless of backend).
 *
 * @param env - environment.
 * @returns a {@link StreamForwardFn}.
 */
export function createRoutedStreamForward(env: Env = process.env): StreamForwardFn {
  return async (body: MessagesBody, _apiKey: string, passthrough?: ForwardHeaders): Promise<StreamForwardResult> => {
    const r = resolveRoute(body.model, env);
    if (!r.ok) return { status: r.status, data: anthropicError(r.message) };
    return r.provider.forwardStream(r.model, body, r.creds, passthrough);
  };
}

/** Coarse fallback estimate (~chars/4) — flagged "estimated", never "exact". */
function estimate(body: MessagesBody): TokenCountResult {
  const text = JSON.stringify(body.messages ?? "") + JSON.stringify(body.system ?? "") + JSON.stringify(body.tools ?? "");
  return { input_tokens: Math.ceil(text.length / 4), token_count_method: "estimated", message_breakdown: [] };
}

/**
 * Build a provider-aware pre-flight token counter: the exact Anthropic SDK count for Anthropic models
 * (when an Anthropic client is available), an honest "estimated" heuristic otherwise. Billing never relies
 * on this number — it uses the upstream-confirmed usage the adapter normalizes — so an estimate for a
 * non-Anthropic budget-gate input is acceptable and clearly flagged (CLAUDE.md exact-counts rule holds).
 *
 * @param client - the Anthropic SDK client, or null when no Anthropic key is configured.
 * @param env - environment.
 * @returns a {@link TokenCounter}.
 */
export function createRoutedCounter(client: AnthropicSdk | null, env: Env = process.env): TokenCounter {
  const anthropicCounter = client !== null ? createTokenCounter(client) : null;
  return {
    async count(body: MessagesBody): Promise<TokenCountResult> {
      const { name } = resolveProviderName(body.model, env);
      if (name === "anthropic" && anthropicCounter !== null) return anthropicCounter.count(body);
      return estimate(body);
    },
  };
}
