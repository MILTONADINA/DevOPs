// Tests for multi-tenant API-key auth: pure helpers (hash/generate/extract), the
// Supabase-backed resolver (fake client), and the gate end-to-end via buildProxy + inject.

import { describe, test, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashApiKey, generateApiKey, extractApiKey, resolveApiKeyVia, type ApiKeyResolver } from "../../src/proxy/auth";

// The global test/setup.ts mocks `fastify`; these gate tests need the REAL Fastify so
// app.inject() works (same opt-out as test/proxy/app.test.ts). The pure auth helpers above
// have no runtime fastify import, so they're unaffected by the mock.
vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

describe("hashApiKey / generateApiKey", () => {
  test("hash is deterministic 64-hex SHA-256; differs for different inputs", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey("abc")).not.toBe(hashApiKey("abd"));
  });
  test("generated keys are prefixed, unique, and self-consistent (hash(raw) === hash)", () => {
    const a = generateApiKey("test");
    const b = generateApiKey("test");
    expect(a.raw).toMatch(/^cq_test_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url = 43 chars
    expect(a.raw).not.toBe(b.raw); // 256-bit random
    expect(hashApiKey(a.raw)).toBe(a.hash);
    expect(generateApiKey("live").raw.startsWith("cq_live_")).toBe(true);
  });
});

describe("extractApiKey", () => {
  test("reads Bearer and x-api-key; case-insensitive scheme; ignores empties", () => {
    expect(extractApiKey({ authorization: "Bearer k1" })).toBe("k1");
    expect(extractApiKey({ authorization: "bearer k2" })).toBe("k2");
    expect(extractApiKey({ "x-api-key": "k3" })).toBe("k3");
    expect(extractApiKey({ authorization: "Bearer " })).toBeUndefined();
    expect(extractApiKey({})).toBeUndefined();
    expect(extractApiKey({ authorization: "Basic xxx" })).toBeUndefined(); // wrong scheme
  });
});

describe("resolveApiKeyVia", () => {
  const fakeClient = (rows: { id: string; org_id: string }[], err?: string): SupabaseClient => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      limit: () => Promise.resolve(err ? { data: null, error: { message: err } } : { data: rows, error: null }),
    };
    return { from: () => builder } as unknown as SupabaseClient;
  };

  test("an active key resolves to its org", async () => {
    const resolved = await resolveApiKeyVia(fakeClient([{ id: "k1", org_id: "o1" }]))("cq_live_whatever");
    expect(resolved).toEqual({ orgId: "o1", keyId: "k1" });
  });
  test("an unknown/inactive key → null", async () => {
    expect(await resolveApiKeyVia(fakeClient([]))("nope")).toBeNull();
  });
  test("a query error throws (distinct from not-found)", async () => {
    await expect(resolveApiKeyVia(fakeClient([], "boom"))("x")).rejects.toThrow(/api key lookup failed: boom/);
  });
});

describe("auth gate via buildProxy", () => {
  const resolve: ApiKeyResolver = (raw) => Promise.resolve(raw === "good-key" ? { orgId: "org-x", keyId: "key-1" } : null);

  async function appWithAuth() {
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve } });
    app.get("/v1/echo-org", (req) => ({ orgId: req.orgId ?? null, keyId: req.apiKeyId ?? null }));
    await app.ready();
    return app;
  }

  test("/health bypasses auth (public)", async () => {
    const app = await appWithAuth();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  test("a guarded path with no key → 401", async () => {
    const app = await appWithAuth();
    const res = await app.inject({ method: "GET", url: "/v1/echo-org" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { type: "authentication_error" } });
    await app.close();
  });

  test("an invalid key → 401", async () => {
    const app = await appWithAuth();
    const res = await app.inject({ method: "GET", url: "/v1/echo-org", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  test("a valid key passes and attaches the org to the request", async () => {
    const app = await appWithAuth();
    const res = await app.inject({ method: "GET", url: "/v1/echo-org", headers: { authorization: "Bearer good-key" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: "org-x", keyId: "key-1" });
    await app.close();
  });

  test("without auth deps the proxy is unauthenticated (personal-use default unchanged)", async () => {
    const app = buildProxy({ rateLimit: false, cors: false }); // no auth
    app.get("/v1/echo-org", (req) => ({ orgId: req.orgId ?? null }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/echo-org" }); // no key, but no gate
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: null });
    await app.close();
  });
});
