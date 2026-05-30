// Tests for the OpenAPI spec + its served route. Beyond "it returns 200", these enforce the
// invariants that make the spec trustworthy: every $ref resolves to a defined component (catches
// typos), every operation declares responses, the documented paths are a SUBSET of the real routes
// (the spec can''t advertise an endpoint that doesn''t exist), and the spec is publicly fetchable
// even when the /v1 auth gate is on (so a client can read the contract before it has a key).

import { describe, test, expect, vi } from "vitest";
import { OPENAPI_SPEC } from "../../src/proxy/openapi";

// test/setup.ts mocks fastify (capture harness). buildProxy needs the real one — unmock + dynamic import.
vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

/** Recursively collect every "#/components/.../X" $ref string in the spec. */
function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, acc);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

/** Resolve a "#/a/b/c" JSON-pointer-ish ref against the spec; returns the target or undefined. */
function resolveRef(ref: string): unknown {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = OPENAPI_SPEC;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

describe("OPENAPI_SPEC structure", () => {
  test("is OpenAPI 3.1 with info + a bearer security scheme", () => {
    expect(OPENAPI_SPEC.openapi).toBe("3.1.0");
    expect(OPENAPI_SPEC.info.title).toMatch(/Stratum/i);
    expect(OPENAPI_SPEC.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });

  test("every $ref resolves to a defined component (no typos)", () => {
    const refs = collectRefs(OPENAPI_SPEC);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolveRef(ref), `dangling $ref: ${ref}`).toBeDefined();
    }
  });

  test("every operation declares at least one response", () => {
    for (const [path, item] of Object.entries(OPENAPI_SPEC.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, { responses?: object }>)) {
        const responses = op.responses ?? {};
        expect(Object.keys(responses).length, `${method.toUpperCase()} ${path} has no responses`).toBeGreaterThan(0);
      }
    }
  });

  test("/health and /openapi-served paths opt out of auth (security: [])", () => {
    // /health is documented as public (no key needed). Asserting it keeps the doc honest.
    expect((OPENAPI_SPEC.paths["/health"].get as { security?: unknown[] }).security).toEqual([]);
  });
});

describe("documented paths are a subset of the real routes", () => {
  test("each spec path+method is actually registered (build the full app, fake every dep)", async () => {
    // Fake every route dep so buildProxy registers the entire surface. The fakes never run (we only
    // inspect the route table), so trivial stubs suffice.
    const anyFake = {} as never;
    const app = buildProxy({
      cors: false,
      rateLimit: false,
      messages: anyFake,
      billing: anyFake,
      config: anyFake,
      memory: anyFake,
      sessions: anyFake,
      webhooks: anyFake,
      tokens: anyFake,
    });
    await app.ready();
    // Probe each documented route with app.inject and assert it is NOT 404. (404 = Fastify has no
    // such route; any other status = the route exists and ran/short-circuited on the empty deps.)
    const registered = new Set<string>();
    for (const [path, item] of Object.entries(OPENAPI_SPEC.paths)) {
      for (const method of Object.keys(item as Record<string, unknown>)) {
        const url = path.replace(/\{(\w+)\}/g, "test-$1"); // {id} → test-id
        const res = await app.inject({ method: method.toUpperCase() as "GET", url });
        registered.add(`${method} ${path}`);
        expect(res.statusCode, `${method.toUpperCase()} ${path} is documented but Fastify returns 404 (route missing)`).not.toBe(404);
      }
    }
    expect(registered.size).toBe(Object.values(OPENAPI_SPEC.paths).reduce((n, item) => n + Object.keys(item as object).length, 0));
    await app.close();
  });
});

describe("GET /openapi.json", () => {
  test("serves the spec as JSON, no auth required", async () => {
    const app = buildProxy({ cors: false, rateLimit: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths)).toContain("/v1/messages");
    await app.close();
  });

  test("remains public even with the /v1 auth gate enabled", async () => {
    // With auth gating /v1/*, a request with no key to /v1/* is 401 — but /openapi.json must still
    // serve (a client reads the contract to learn how to authenticate in the first place).
    const app = buildProxy({
      cors: false,
      rateLimit: false,
      auth: { resolve: async () => null, protectedPrefixes: ["/v1/"] },
    });
    await app.ready();
    const spec = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(spec.statusCode).toBe(200);
    const gated = await app.inject({ method: "GET", url: "/v1/config" });
    expect(gated.statusCode).toBe(401); // proves the gate is actually on
    await app.close();
  });
});
