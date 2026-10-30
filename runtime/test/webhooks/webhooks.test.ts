// Unit tests for the webhook signer, event envelope, and SSRF-guarded delivery.

import { describe, test, expect } from "vitest";
import { signWebhook, verifyWebhook, SIGNATURE_HEADER } from "../../src/webhooks/sign";
import { buildEvent, isWebhookEventType, SAMPLE_EVENT_DATA, WEBHOOK_EVENT_TYPES } from "../../src/webhooks/events";
import { isSafeWebhookUrl, deliverWebhook, type DeliveryDeps, type TransportRequest } from "../../src/webhooks/deliver";

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
    expect(buildEvent("session.ended", "o1", { x: 1 }, "evt_1", "2026-05-01T00:00:00Z")).toEqual({
      event: "session.ended",
      id: "evt_1",
      created_at: "2026-05-01T00:00:00Z",
      org_id: "o1",
      data: { x: 1 },
    });
    for (const t of WEBHOOK_EVENT_TYPES) expect(SAMPLE_EVENT_DATA[t]).toBeTypeOf("object");
  });

  // The four types that remain once the two payment-era types are gone, sorted so that the test pins the set and not the order it is listed in.
  const SURVIVING_TYPES = ["conflict.detected", "eval.completed", "fact.suppressed", "session.ended"];

  test("specs/ops/payment-removal.md#AC-1 — WEBHOOK_EVENT_TYPES and SAMPLE_EVENT_DATA hold exactly the four non-payment event types", () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(SURVIVING_TYPES);
    expect(Object.keys(SAMPLE_EVENT_DATA).sort()).toEqual(SURVIVING_TYPES);
  });

  test("specs/ops/payment-removal.md#AC-1 — isWebhookEventType rejects the removed invoice.ready and tee.attestation_failed types", () => {
    expect(isWebhookEventType("invoice.ready")).toBe(false);
    expect(isWebhookEventType("tee.attestation_failed")).toBe(false);
  });

  test("specs/ops/payment-removal.md#AC-1 — no sample payload has a key that matches /fee/i, so none carries cq_fee_usd", () => {
    // Every key at every depth, so a fee key nested inside a payload is found as well.
    const keysOf = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]) : []);
    const keys = Object.values(SAMPLE_EVENT_DATA).flatMap(keysOf);
    expect(keys).toContain("estimated_savings_usd"); // the walk does see keys, and the USD estimates that REQ-6 keeps are still there
    expect(keys.filter((key) => /fee/i.test(key))).toEqual([]);
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
      // IPv4-mapped / embedded IPv6 — these decode to the same private IPs and must NOT bypass the guard.
      "http://[::ffff:127.0.0.1]/x", // loopback (dotted)
      "http://[::ffff:7f00:1]/x", // loopback (hex, Node-normalized form)
      "http://[::ffff:10.0.0.1]/x", // RFC-1918
      "http://[::ffff:169.254.169.254]/x", // cloud metadata (dotted)
      "http://[::ffff:a9fe:a9fe]/x", // cloud metadata (hex, Node-normalized)
      "http://[::ffff:192.168.0.1]/x",
      "http://[::127.0.0.1]/x", // IPv4-compatible (deprecated)
      "ftp://example.com/x",
      "not-a-url",
    ]) {
      expect(isSafeWebhookUrl(bad).ok).toBe(false);
    }
  });
});

// deliverWebhook's resolve/vet/pin/redirect behaviour is covered in egress.test.ts.
describe("deliverWebhook (basic contract)", () => {
  const deps = (status: number | Error): { deps: DeliveryDeps; seen: TransportRequest[] } => {
    const seen: TransportRequest[] = [];
    return {
      seen,
      deps: {
        lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
        transport: (req) => {
          seen.push(req);
          return status instanceof Error ? Promise.reject(status) : Promise.resolve({ status });
        },
      },
    };
  };
  test("signs (X-CQ-Signature) + POSTs to a safe URL; 2xx → delivered", async () => {
    const d = deps(200);
    const res = await deliverWebhook("https://api.customer.com/cq", '{"event":"x"}', SECRET, d.deps);
    expect(res).toEqual({ delivered: true, status: 200, retryable: false });
    expect(d.seen[0]!.headers[SIGNATURE_HEADER]).toBe(signWebhook('{"event":"x"}', SECRET));
    expect(d.seen[0]!.body).toBe('{"event":"x"}');
  });
  test("non-2xx → not delivered (status preserved)", async () => {
    const res = await deliverWebhook("https://api.customer.com/cq", "{}", SECRET, deps(500).deps);
    expect(res).toMatchObject({ delivered: false, status: 500, retryable: true, reasonClass: "http_5xx" });
  });
  test("an unsafe URL is never connected", async () => {
    const d = deps(200);
    const res = await deliverWebhook("http://169.254.169.254/x", "{}", SECRET, d.deps);
    expect(d.seen).toHaveLength(0);
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/IPv4/);
  });
  test("a transport error → not delivered, with a generic reason", async () => {
    const res = await deliverWebhook("https://api.customer.com/cq", "{}", SECRET, deps(new Error("ECONNREFUSED")).deps);
    expect(res).toMatchObject({ delivered: false, reasonClass: "network", retryable: true });
  });
});
