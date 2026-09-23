// Tests for /health dependency reporting + the cached Supabase health check.

import { describe, test, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseHealthCheck } from "../../src/proxy/routes/health";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

describe("GET /health dependency reporting", () => {
  test("liveness-only by default (no dependencies block)", async () => {
    const app = buildProxy({ cors: false, rateLimit: false });
    await app.ready();
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.status).toBe("ok");
    expect(body.dependencies).toBeUndefined();
    await app.close();
  });

  test("reports database:ok when the checker passes", async () => {
    const app = buildProxy({ cors: false, rateLimit: false, health: { checkDatabase: () => Promise.resolve(true) } });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", dependencies: { database: "ok" } });
    await app.close();
  });

  test("database:error when the checker fails/throws, but status stays ok (liveness)", async () => {
    const app = buildProxy({ cors: false, rateLimit: false, health: { checkDatabase: () => Promise.reject(new Error("down")) } });
    await app.ready();
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body).toMatchObject({ status: "ok", dependencies: { database: "error" } });
    await app.close();
  });
});

describe("createSupabaseHealthCheck", () => {
  function fakeClient(errSeq: (null | { message: string })[]): { client: SupabaseClient; calls: () => number } {
    let calls = 0;
    const builder = {
      select: () => builder,
      limit: () => {
        const e = errSeq[calls] ?? null;
        calls++;
        return Promise.resolve({ error: e });
      },
    };
    return { client: { from: () => builder } as unknown as SupabaseClient, calls: () => calls };
  }

  test("caches the result within the TTL, re-queries after it expires", async () => {
    let t = 0;
    const fc = fakeClient([null, null]);
    const check = createSupabaseHealthCheck(fc.client, 5_000, () => t);
    expect(await check()).toBe(true);
    expect(fc.calls()).toBe(1);
    expect(await check()).toBe(true); // cached
    expect(fc.calls()).toBe(1); // no new query
    t += 5_001;
    expect(await check()).toBe(true); // TTL expired → re-query
    expect(fc.calls()).toBe(2);
  });

  test("a query error → false", async () => {
    const fc = fakeClient([{ message: "unreachable" }]);
    expect(await createSupabaseHealthCheck(fc.client, 5_000, () => 0)()).toBe(false);
  });
});
