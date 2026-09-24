// Tests for the entry-point wiring (commercialEnabled, buildStartOptions). Importing
// index.ts does NOT boot a server (the entry guard only starts when run as the entry).

import { describe, test, expect, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuildProxyOptions } from "../../src/proxy/app";
import { commercialEnabled, buildStartOptions, resolveListenHost, assertCommercialStartup, type ClientFactory } from "../../src/proxy/index";

const base = { messages: {} as never, dashboard: { readSessions: () => [] } } as unknown as BuildProxyOptions;
const fakeClient = {} as unknown as SupabaseClient;

describe("commercialEnabled", () => {
  test("requires BOTH the flag and Supabase creds", () => {
    expect(commercialEnabled({})).toBe(false);
    expect(commercialEnabled({ CQ_COMMERCIAL: "true" })).toBe(false); // flag, no creds
    expect(commercialEnabled({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(true);
    expect(commercialEnabled({ CQ_COMMERCIAL: "1", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(true);
    expect(commercialEnabled({ CQ_COMMERCIAL: "false", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toBe(false);
    expect(commercialEnabled({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "" })).toBe(false); // empty key
  });
});

describe("assertCommercialStartup", () => {
  test("requires database credentials and signing secret only for commercial runtime", () => {
    expect(() => assertCommercialStartup({})).not.toThrow();
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true" })).toThrow(/database|Supabase/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" })).toThrow(/signing secret/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "   " })).toThrow(/signing secret/i);
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "s" })).not.toThrow();
    expect(() => assertCommercialStartup({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "s", VERCEL: "1" })).toThrow(/ephemeral|Vercel/i);
  });
});

describe("resolveListenHost", () => {
  test("defaults to loopback; HOST overrides (0.0.0.0 in a container)", () => {
    expect(resolveListenHost({})).toBe("127.0.0.1"); // private by default
    expect(resolveListenHost({ HOST: "" })).toBe("127.0.0.1"); // empty ⇒ default
    expect(resolveListenHost({ HOST: "  " })).toBe("127.0.0.1"); // whitespace ⇒ default
    expect(resolveListenHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0"); // container/PaaS: reachable
    expect(resolveListenHost({ HOST: " 0.0.0.0 " })).toBe("0.0.0.0"); // trimmed
  });
});

describe("buildStartOptions", () => {
  test("commercial billing wires a project-local outbox and rejects ephemeral Vercel runtime", async () => {
    const dir = mkdtempSync(join(process.cwd(), "data", "usage-start-test-"));
    const env = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k", CQ_BILLING_SIGNING_SECRET: "test-secret", CQ_USAGE_OUTBOX_DIR: dir };
    try {
      const opts = buildStartOptions(env, { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory);
      expect(opts.messages?.usageOutbox?.enqueue).toBeTypeOf("function");
      expect(opts.messages?.recordUsage).toBeUndefined();
      await opts.messages?.usageOutbox?.close();
      expect(() => buildStartOptions({ ...env, VERCEL: "1" }, { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory)).toThrow(/persistent|serverless|Vercel/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("local memory extraction is explicitly configured and rejects a non-loopback endpoint", () => {
    const messages = {} as NonNullable<BuildProxyOptions["messages"]>;
    const env = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k",
      CQ_MEMORY_EXTRACT_MODEL: "local/check", CQ_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1" };
    const configured = buildStartOptions(env, { messages }, (() => fakeClient) as ClientFactory);
    expect(configured.messages?.recordMemory).toBeTypeOf("function");
    const unconfigured = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" },
      { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory);
    expect(unconfigured.messages?.recordMemory).toBeUndefined();
    expect(() => buildStartOptions({ ...env, CQ_LOCAL_BASE_URL: "https://example.com/v1" },
      { messages: {} as NonNullable<BuildProxyOptions["messages"]> }, (() => fakeClient) as ClientFactory)).toThrow();
  });

  test("personal mode: returns only the base; never constructs a client", () => {
    const makeClient = vi.fn() as unknown as ClientFactory;
    const opts = buildStartOptions({}, base, makeClient);
    expect(opts.messages).toBe(base.messages);
    expect(opts.auth).toBeUndefined();
    expect(opts.config).toBeUndefined();
    expect(opts.memory).toBeUndefined();
    expect(opts.billing).toBeUndefined();
    expect(opts.sessions).toBeUndefined();
    expect(makeClient).not.toHaveBeenCalled();
  });

  test("commercial mode: builds the client ONCE and wires auth(/v1)+config+memory+billing+sessions", () => {
    const makeClient = vi.fn(() => fakeClient);
    const opts = buildStartOptions({ CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" }, base, makeClient as unknown as ClientFactory);
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledWith("u", "k");
    expect(opts.auth?.protectedPrefixes).toEqual(["/v1/"]);
    expect(opts.config).toBeDefined();
    expect(opts.memory).toBeDefined();
    expect(opts.billing).toBeDefined();
    expect(opts.sessions).toBeDefined();
    expect(opts.webhooks).toBeDefined();
    expect(opts.tokens).toBeDefined();
    expect(opts.rateLimitByPlan).toBeDefined();
    expect(opts.messages).toBe(base.messages); // base preserved
    expect(opts.dashboard).toBe(base.dashboard);
  });

  test("Stripe webhook is wired ONLY when STRIPE_WEBHOOK_SECRET is set", () => {
    const commercial = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" };
    const without = buildStartOptions(commercial, base, (() => fakeClient) as unknown as ClientFactory);
    expect(without.stripeWebhook).toBeUndefined(); // no endpoint secret ⇒ no route

    const withSecret = buildStartOptions({ ...commercial, STRIPE_WEBHOOK_SECRET: "whsec_x" }, base, (() => fakeClient) as unknown as ClientFactory);
    expect(withSecret.stripeWebhook).toBeDefined();
    expect(withSecret.stripeWebhook?.signingSecret).toBe("whsec_x");

    // personal mode never wires it even if the secret is present
    const personal = buildStartOptions({ STRIPE_WEBHOOK_SECRET: "whsec_x" }, base, (() => fakeClient) as unknown as ClientFactory);
    expect(personal.stripeWebhook).toBeUndefined();
  });
});
