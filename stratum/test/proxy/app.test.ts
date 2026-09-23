// Integration tests for the proxy app factory (src/proxy/app.ts) via app.inject().
// Phase 1 core: /health liveness + the error-handler shape. The /v1/messages
// route + its forward/capture wiring land (with their own tests) in the next
// §2d increment.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// The global test/setup.ts mocks `fastify` (for the capture-session handler
// tests). These proxy tests need the REAL Fastify so app.inject() works —
// opt out of the mock for this file.
vi.unmock("fastify");
vi.unmock("@fastify/cors");

const { buildProxy } = await import("../../src/proxy/app");

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("buildProxy — /health", () => {
  test("GET /health returns 200 with phase + uptime + version", async () => {
    app = buildProxy({ cors: false });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.phase).toBe("1-measurement-proxy");
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.version).toBe("string");
  });
});

describe("buildProxy — factory contract", () => {
  test("returns an injectable instance that is not yet listening", async () => {
    app = buildProxy({ cors: false });
    await app.ready();
    // No server address until listen() is called — the factory must not listen.
    expect(app.server.listening).toBe(false);
  });

  test("unknown route returns Fastify 404 (app is wired)", async () => {
    app = buildProxy({ cors: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });
});
