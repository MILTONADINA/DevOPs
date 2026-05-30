// Rate-limit wiring test (§2d): a per-IP cap returns 429 once exceeded, and the
// limiter is disable-able for other tests. Real Fastify + @fastify/rate-limit.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ConfigDeps } from "../../src/proxy/routes/config";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
vi.unmock("@fastify/rate-limit");

const { buildProxy } = await import("../../src/proxy/app");

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("buildProxy — rate limiting", () => {
  test("exceeding the per-IP max returns 429", async () => {
    app = buildProxy({ cors: false, rateLimit: 2 });
    await app.ready();

    const r1 = await app.inject({ method: "GET", url: "/health" });
    const r2 = await app.inject({ method: "GET", url: "/health" });
    const r3 = await app.inject({ method: "GET", url: "/health" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429); // 3rd request over max:2 → rate limited
  });

  test("rateLimit:false disables the limiter (no 429 under load)", async () => {
    app = buildProxy({ cors: false, rateLimit: false });
    await app.ready();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });

  test("per-PLAN limiting: starter org capped at 20/min, per-org (commercial mode)", async () => {
    const resolve = (raw: string) => Promise.resolve(raw === "starter-key" ? { orgId: "org-s", keyId: "k" } : raw === "growth-key" ? { orgId: "org-g", keyId: "k" } : null);
    const getPlan = (orgId: string) => Promise.resolve(orgId === "org-s" ? "starter" : "growth");
    // A real in-buildProxy route (/v1/config) so it's covered by the rate-limit plugin + the auth gate.
    const config: ConfigDeps = { getConfig: () => Promise.resolve(null), upsertConfig: (_o, p) => Promise.resolve({ lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true, webhook_url: null, ...p }) };
    app = buildProxy({ cors: false, auth: { resolve }, rateLimitByPlan: { getPlan }, config });
    await app.ready();

    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await app.inject({ method: "GET", url: "/v1/config", headers: { authorization: "Bearer starter-key" } })).statusCode;
    }
    expect(last).toBe(429); // the 21st starter request exceeds the 20/min plan cap

    // A DIFFERENT org has its own counter — not affected by org-s's burst.
    const g = await app.inject({ method: "GET", url: "/v1/config", headers: { authorization: "Bearer growth-key" } });
    expect(g.statusCode).toBe(200);
  });

  test("commercial responses carry the spec's X-RateLimit-*-Requests headers (RATE_LIMITS.md)", async () => {
    const resolve = (raw: string) => Promise.resolve(raw === "k" ? { orgId: "o1", keyId: "k" } : null);
    const config: ConfigDeps = { getConfig: () => Promise.resolve(null), upsertConfig: (_o, p) => Promise.resolve({ lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true, webhook_url: null, ...p }) };
    app = buildProxy({ cors: false, auth: { resolve }, rateLimitByPlan: { getPlan: () => Promise.resolve("starter") }, config });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/config", headers: { authorization: "Bearer k" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit-requests"]).toBe("20"); // starter = 20/min
    expect(res.headers["x-ratelimit-remaining-requests"]).toBeDefined();
    expect(String(res.headers["x-ratelimit-reset-requests"])).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });
});
