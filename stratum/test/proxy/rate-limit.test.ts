// Rate-limit wiring test (§2d): a per-IP cap returns 429 once exceeded, and the
// limiter is disable-able for other tests. Real Fastify + @fastify/rate-limit.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

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
});
