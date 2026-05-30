// Tests for POST /v1/webhooks/test via app.inject() with injected fake webhook deps.

import { describe, test, expect, vi } from "vitest";
import type { WebhookDeps } from "../../src/proxy/routes/webhooks";
import { SAMPLE_EVENT_DATA } from "../../src/webhooks/events";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");

function fakeDeps(opts: { noConfig?: boolean; fail?: boolean } = {}): { deps: WebhookDeps; captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {};
  const deps: WebhookDeps = {
    getWebhookConfig: (orgId) => {
      captured["org"] = orgId;
      return Promise.resolve(opts.noConfig ? null : { url: "https://api.customer.com/cq", secret: "whsec_s" });
    },
    deliver: (url, payload, secret) => {
      captured["deliver"] = { url, payload, secret };
      return Promise.resolve(opts.fail ? { delivered: false, status: 500 } : { delivered: true, status: 200 });
    },
  };
  return { deps, captured };
}

const post = (event_type: unknown) => ({ method: "POST" as const, url: "/v1/webhooks/test?org-id=o1", headers: { "content-type": "application/json" }, payload: { event_type } });

describe("POST /v1/webhooks/test", () => {
  test("builds + signs + delivers a sample event of the requested type", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, webhooks: deps });
    await app.ready();
    const res = await app.inject(post("conflict.detected"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ event_type: "conflict.detected", sent_to: "https://api.customer.com/cq", delivered: true, status: 200 });
    const sent = JSON.parse((captured["deliver"] as { payload: string }).payload);
    expect(sent).toMatchObject({ event: "conflict.detected", org_id: "o1", data: SAMPLE_EVENT_DATA["conflict.detected"] });
    expect(sent.id).toMatch(/^evt_/);
    await app.close();
  });

  test("400 with no org", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, webhooks: fakeDeps().deps });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/test", headers: { "content-type": "application/json" }, payload: { event_type: "invoice.ready" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  test("400 for an unknown event_type (never reaches delivery)", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, webhooks: deps });
    await app.ready();
    expect((await app.inject(post("bogus.event"))).statusCode).toBe(400);
    expect(captured["deliver"]).toBeUndefined();
    await app.close();
  });

  test("400 when the org has no webhook configured", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, webhooks: fakeDeps({ noConfig: true }).deps });
    await app.ready();
    expect((await app.inject(post("invoice.ready"))).statusCode).toBe(400);
    await app.close();
  });

  test("502 when delivery fails", async () => {
    const app = buildProxy({ rateLimit: false, cors: false, webhooks: fakeDeps({ fail: true }).deps });
    await app.ready();
    const res = await app.inject(post("fact.suppressed"));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ delivered: false });
    await app.close();
  });

  test("uses the AUTHENTICATED org when auth is on", async () => {
    const { deps, captured } = fakeDeps();
    const app = buildProxy({ rateLimit: false, cors: false, auth: { resolve: (r) => Promise.resolve(r === "k" ? { orgId: "o5", keyId: "i" } : null) }, webhooks: deps });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/test", headers: { "content-type": "application/json", authorization: "Bearer k" }, payload: { event_type: "session.ended" } });
    expect(res.statusCode).toBe(200);
    expect(captured["org"]).toBe("o5");
    await app.close();
  });
});
