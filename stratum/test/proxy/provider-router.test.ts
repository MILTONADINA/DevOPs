// Tests for the multi-provider router (ADR-0019): model→provider resolution, credential resolution,
// the routed counter (estimate for non-Anthropic), and the unconfigured/unknown-provider error path.
// The provider-call happy paths are covered by each adapter's own tests (with a fake fetch).

import { describe, test, expect } from "vitest";
import { resolveProviderName, resolveCredentials, resolveRoute, createRoutedForward, createRoutedStreamForward, createRoutedCounter } from "../../src/proxy/providers/router";
import type { MessagesBody } from "../../src/proxy/forward";

const BODY = (model: string): MessagesBody => ({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 16 });

describe("resolveProviderName", () => {
  test("explicit provider/ prefix wins and is stripped", () => {
    expect(resolveProviderName("openai/gpt-4o", {})).toEqual({ name: "openai", nativeModel: "gpt-4o" });
    expect(resolveProviderName("gemini/gemini-2.5-pro", {})).toEqual({ name: "gemini", nativeModel: "gemini-2.5-pro" });
    expect(resolveProviderName("local/llama3.1", {})).toEqual({ name: "local", nativeModel: "llama3.1" });
    expect(resolveProviderName("google/gemini-2.5-flash", {})).toEqual({ name: "gemini", nativeModel: "gemini-2.5-flash" }); // alias
  });

  test("OpenRouter keeps its native vendor/model intact after the openrouter/ prefix", () => {
    expect(resolveProviderName("openrouter/anthropic/claude-3.5-sonnet", {})).toEqual({ name: "openrouter", nativeModel: "anthropic/claude-3.5-sonnet" });
  });

  test("bare model name → heuristic", () => {
    expect(resolveProviderName("claude-opus-4-8", {}).name).toBe("anthropic");
    expect(resolveProviderName("gpt-4o", {}).name).toBe("openai");
    expect(resolveProviderName("o1-preview", {}).name).toBe("openai");
    expect(resolveProviderName("chatgpt-4o-latest", {}).name).toBe("openai");
    expect(resolveProviderName("gemini-2.5-pro", {}).name).toBe("gemini");
  });

  test("unknown bare model → CQ_DEFAULT_PROVIDER, defaulting to anthropic", () => {
    expect(resolveProviderName("llama3.1", {}).name).toBe("anthropic"); // no default set
    expect(resolveProviderName("llama3.1", { CQ_DEFAULT_PROVIDER: "local" }).name).toBe("local");
    expect(resolveProviderName("mixtral", { CQ_DEFAULT_PROVIDER: "openrouter" }).name).toBe("openrouter");
  });
});

describe("resolveCredentials", () => {
  test("reads each provider's env key/base URL; null when unset", () => {
    expect(resolveCredentials("openai", {})).toBeNull();
    expect(resolveCredentials("openai", { OPENAI_API_KEY: "sk-x" })).toMatchObject({ apiKey: "sk-x", baseUrl: "https://api.openai.com/v1" });
    expect(resolveCredentials("openai", { OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "http://localhost:1234/v1/" })).toMatchObject({ baseUrl: "http://localhost:1234/v1" }); // trailing slash stripped
    expect(resolveCredentials("gemini", { GOOGLE_API_KEY: "g" })).toMatchObject({ apiKey: "g" }); // GOOGLE_API_KEY alias
    expect(resolveCredentials("openrouter", { OPENROUTER_API_KEY: "or", OPENROUTER_TITLE: "Stratum" })).toMatchObject({ apiKey: "or", extraHeaders: { "X-Title": "Stratum" } });
    expect(resolveCredentials("local", { CQ_LOCAL_BASE_URL: "http://localhost:11434/v1" })).toMatchObject({ apiKey: "", baseUrl: "http://localhost:11434/v1" });
    expect(resolveCredentials("local", {})).toBeNull(); // local requires a base URL
  });
});

describe("resolveRoute", () => {
  test("anthropic configured → ok route", () => {
    const r = resolveRoute("claude-opus-4-8", { ANTHROPIC_API_KEY: "sk-ant" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider.name).toBe("anthropic");
      expect(r.model).toBe("claude-opus-4-8");
    }
  });

  test("openai configured → ok route to the OpenAI-compatible adapter", () => {
    const r = resolveRoute("gpt-4o", { OPENAI_API_KEY: "sk-x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider.name).toBe("openai-compatible");
      expect(r.model).toBe("gpt-4o");
    }
  });

  test("openrouter + local share the OpenAI-compatible adapter (only creds differ)", () => {
    const or = resolveRoute("openrouter/meta-llama/llama-3.1-70b-instruct", { OPENROUTER_API_KEY: "or" });
    expect(or.ok).toBe(true);
    if (or.ok) {
      expect(or.provider.name).toBe("openai-compatible");
      expect(or.model).toBe("meta-llama/llama-3.1-70b-instruct"); // OpenRouter's native vendor/model preserved
    }
    const local = resolveRoute("local/llama3.1", { CQ_LOCAL_BASE_URL: "http://localhost:11434/v1" });
    expect(local.ok).toBe(true);
    if (local.ok) expect(local.provider.name).toBe("openai-compatible");
  });

  test("registered-but-unconfigured provider → clean 400", () => {
    const r = resolveRoute("claude-opus-4-8", {}); // anthropic registered, but no key
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not configured/);
  });
});

describe("createRoutedForward / Stream — error route returns an Anthropic-shaped error result", () => {
  test("unconfigured provider → status 400 + Anthropic error body (the route passes it through)", async () => {
    const fwd = createRoutedForward({}); // nothing configured
    const res = await fwd(BODY("claude-opus-4-8"), "ignored");
    expect(res.status).toBe(400);
    expect(res.data).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });

    const sfwd = createRoutedStreamForward({});
    const sres = await sfwd(BODY("gpt-4o"), "ignored");
    expect(sres.status).toBe(400);
    expect(sres.stream).toBeUndefined();
  });
});

describe("createRoutedCounter — provider-aware", () => {
  test("non-Anthropic model → honest estimate (no Anthropic SDK call)", async () => {
    const counter = createRoutedCounter(null, {});
    const r = await counter.count(BODY("gpt-4o"));
    expect(r.token_count_method).toBe("estimated");
    expect(r.input_tokens).toBeGreaterThan(0);
  });

  test("Anthropic model with NO client (no key) → estimate, never a false 'exact'", async () => {
    const counter = createRoutedCounter(null, {});
    const r = await counter.count(BODY("claude-opus-4-8"));
    expect(r.token_count_method).toBe("estimated");
  });
});
