// Unit tests for the webhook signer, event envelope, and SSRF-guarded delivery.

import { describe, test, expect } from "vitest";
import { signWebhook, verifyWebhook, SIGNATURE_HEADER } from "../../src/webhooks/sign";
import { buildEvent, isWebhookEventType, SAMPLE_EVENT_DATA, WEBHOOK_EVENT_TYPES } from "../../src/webhooks/events";
import { isSafeWebhookUrl, deliverWebhook, type DeliveryFetch } from "../../src/webhooks/deliver";

const SECRET = "whsec_test_please_rotate_32chars_min";

describe("signWebhook / verifyWebhook", () => {
  test("deterministic sha256=<hex>; round-trips; throws on empty secret", () => {
    const sig = signWebhook('{"a":1}', SECRET);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook('{"a":1}', SECRET)).toBe(sig);
    expect(verifyWebhook('{"a":1}', sig, SECRET)).toBe(true);
    expect(verifyWebhook('{"a":1}', sig.replace("sha256=", ""), SECRET)).toBe(true); // prefix optional
    expect(() => signWebhook("x", "")).toThrow(/secret/);
  });
  test("rejects a tampered body, the wrong secret, and an empty secret", () => {
    const sig = signWebhook('{"a":1}', SECRET);
    expect(verifyWebhook('{"a":2}', sig, SECRET)).toBe(false);
    expect(verifyWebhook('{"a":1}', sig, "other")).toBe(false);
    expect(verifyWebhook('{"a":1}', sig, "")).toBe(false);
  });
});

describe("events", () => {
  test("isWebhookEventType guards the known set", () => {
    expect(isWebhookEventType("conflict.detected")).toBe(true);
    expect(isWebhookEventType("nope")).toBe(false);
    expect(isWebhookEventType(42)).toBe(false);
  });
  test("buildEvent assembles the envelope; every event type has sample data", () => {
    expect(buildEvent("invoice.ready", "o1", { x: 1 }, "evt_1", "2026-05-01T00:00:00Z")).toEqual({
      event: "invoice.ready",
      id: "evt_1",
      created_at: "2026-05-01T00:00:00Z",
      org_id: "o1",
      data: { x: 1 },
    });
    for (const t of WEBHOOK_EVENT_TYPES) expect(SAMPLE_EVENT_DATA[t]).toBeTypeOf("object");
  });
});

describe("isSafeWebhookUrl (SSRF guard)", () => {
  test("allows a public https URL", () => {
    expect(isSafeWebhookUrl("https://api.customer.com/webhooks/cq")).toEqual({ ok: true });
    expect(isSafeWebhookUrl("http://example.com:8080/hook")).toEqual({ ok: true });
  });
  test("blocks localhost, private/loopback IPv4 + the cloud-metadata IP, private IPv6, and bad schemes", () => {
    for (const bad of [
      "http://localhost/x",
      "https://app.localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.10/x",
      "http://172.16.4.4/x",
      "http://169.254.169.254/latest/meta-data", // cloud metadata
      "http://[::1]/x",
      "http://[fc00::1]/x",
      "ftp://example.com/x",
      "not-a-url",
    ]) {
      expect(isSafeWebhookUrl(bad).ok).toBe(false);
    }
  });
});

describe("deliverWebhook", () => {
  test("signs (X-CQ-Signature) + POSTs to a safe URL; 2xx → delivered", async () => {
    let seen: { url: string; init: { headers: Record<string, string>; body: string } } | undefined;
    const fakeFetch: DeliveryFetch = (url, init) => {
      seen = { url, init };
      return Promise.resolve({ status: 200 });
    };
    const res = await deliverWebhook("https://api.customer.com/cq", '{"event":"x"}', SECRET, fakeFetch);
    expect(res).toEqual({ delivered: true, status: 200 });
    expect(seen!.url).toBe("https://api.customer.com/cq");
    expect(seen!.init.headers[SIGNATURE_HEADER]).toBe(signWebhook('{"event":"x"}', SECRET));
    expect(seen!.init.body).toBe('{"event":"x"}');
  });
  test("non-2xx → not delivered (status preserved)", async () => {
    const res = await deliverWebhook("https://api.customer.com/cq", "{}", SECRET, () => Promise.resolve({ status: 500 }));
    expect(res).toEqual({ delivered: false, status: 500 });
  });
  test("an unsafe URL is never fetched", async () => {
    let called = false;
    const res = await deliverWebhook("http://169.254.169.254/x", "{}", SECRET, () => {
      called = true;
      return Promise.resolve({ status: 200 });
    });
    expect(called).toBe(false);
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/IPv4/);
  });
  test("a fetch error → not delivered, with the reason", async () => {
    const res = await deliverWebhook("https://api.customer.com/cq", "{}", SECRET, () => Promise.reject(new Error("ECONNREFUSED")));
    expect(res).toEqual({ delivered: false, reason: "ECONNREFUSED" });
  });
});
