// Tests for the org config API (GET + PATCH /v1/config): pure validation + the
// route end-to-end via app.inject() with injected fake deps (no DB).

import { describe, test, expect, vi } from "vitest";
import { validateConfigPatch, DEFAULT_ORG_CONFIG, type ConfigDeps, type OrgConfig, type OrgConfigPatch } from "../../src/proxy/routes/config";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

describe("validateConfigPatch", () => {
  test("accepts valid fields and ignores unknown ones", () => {
    const r = validateConfigPatch({ lambda: 0.9, theta: 2, gain_shift: -0.5, zk_enabled: true, audit_enabled: false, webhook_url: "https://x", bogus: 1 });
    expect(r.ok && r.patch).toEqual({ lambda: 0.9, theta: 2, gain_shift: -0.5, zk_enabled: true, audit_enabled: false, webhook_url: "https://x" });
  });
  test("enforces the DB CHECKs (lambda ∈ (0,1], theta > 0)", () => {
    expect(validateConfigPatch({ lambda: 1.5 })).toMatchObject({ ok: false });
    expect(validateConfigPatch({ lambda: 0 })).toMatchObject({ ok: false });
    expect(validateConfigPatch({ theta: 0 })).toMatchObject({ ok: false });
    expect(validateConfigPatch({ theta: -1 })).toMatchObject({ ok: false });
  });
  test("rejects wrong types, non-objects, and empty/unknown-only patches", () => {
    expect(validateConfigPatch({ zk_enabled: "yes" })).toMatchObject({ ok: false });
    expect(validateConfigPatch({ gain_shift: Infinity })).toMatchObject({ ok: false });
    expect(validateConfigPatch(null)).toMatchObject({ ok: false });
    expect(validateConfigPatch({})).toMatchObject({ ok: false });
    expect(validateConfigPatch({ unknown: 1 })).toMatchObject({ ok: false });
  });
});

function fakeDeps(stored?: OrgConfig): { deps: ConfigDeps; captured: { orgId?: string; patch?: OrgConfigPatch } } {
  const captured: { orgId?: string; patch?: OrgConfigPatch } = {};
  const deps: ConfigDeps = {
    getConfig: (orgId) => Promise.resolve(orgId === "o1" && stored ? stored : null),
    upsertConfig: (orgId, patch) => {
      captured.orgId = orgId;
      captured.patch = patch;
      return Promise.resolve({ ...DEFAULT_ORG_CONFIG, ...patch });
    },
  };
  return { deps, captured };
}

describe("GET /v1/config", () => {
  test("returns the stored config", async () => {
    const stored: OrgConfig = { lambda: 0.9, gain_shift: 0.1, theta: 2, zk_enabled: true, audit_enabled: false, webhook_url: "https://x" };
    const app = buildProxy({ rateLimit: false, cors: false, config: fakeDeps(stored).deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/config?org-id=o1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stored);
    await app.close();
  });

  test("returns defaults when the org has no config row", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, config: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/config?org-id=fresh" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_ORG_CONFIG);
    await app.close();
  });

  test("400 when no org can be resolved", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, config: fakeDeps().deps });
    await app.ready();
    expect((await app.inject({ method: "GET", url: "/v1/config" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("PATCH /v1/config", () => {
  test("validates + upserts the patch and returns the updated config", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, config: deps });
    await app.ready();
    const res = await app.inject({ method: "PATCH", url: "/v1/config?org-id=o1", headers: { "content-type": "application/json" }, payload: { lambda: 0.9, theta: 2 } });
    expect(res.statusCode).toBe(200);
    expect(captured).toEqual({ orgId: "o1", patch: { lambda: 0.9, theta: 2 } });
    expect(res.json()).toMatchObject({ lambda: 0.9, theta: 2, audit_enabled: true });
    await app.close();
  });

  test("400 on an invalid value (does not reach the store)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, config: deps });
    await app.ready();
    const res = await app.inject({ method: "PATCH", url: "/v1/config?org-id=o1", headers: { "content-type": "application/json" }, payload: { lambda: 1.5 } });
    expect(res.statusCode).toBe(400);
    expect(captured.orgId).toBeUndefined(); // never upserted
    await app.close();
  });

  test("uses the AUTHENTICATED org when auth is on (no ?org-id)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (raw) => Promise.resolve(raw === "k" ? { orgId: "o1", keyId: "id" } : null) }, config: deps });
    await app.ready();
    const res = await app.inject({ method: "PATCH", url: "/v1/config", headers: { "content-type": "application/json", authorization: "Bearer k" }, payload: { theta: 3 } });
    expect(res.statusCode).toBe(200);
    expect(captured.orgId).toBe("o1");
    await app.close();
  });
});
