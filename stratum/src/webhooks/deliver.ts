/**
 * Webhook delivery (Phase 2+ commercial) — signed POST with an SSRF guard + timeout.
 *
 * The webhook URL is CUSTOMER-PROVIDED, so delivery is an SSRF surface: a malicious/misconfigured
 * URL must never let us POST to an internal address (cloud metadata 169.254.169.254, localhost,
 * RFC-1918, link-local). isSafeWebhookUrl blocks literal private/loopback IPs + localhost at the URL
 * layer. NOTE: this does NOT defend DNS-rebinding (a public name resolving to a private IP) — production
 * must additionally resolve + pin the address at connect time; that's documented, not silently skipped.
 *
 * Single-attempt here; the spec's exponential-backoff retry schedule needs a durable queue (a later
 * slice). The fetch is injected so this is fully testable with no network.
 */

import { signWebhook, SIGNATURE_HEADER } from "./sign";

/** Reject literal private/loopback/link-local IPv4 (incl. the 169.254 cloud-metadata range). */
const PRIVATE_V4 = [/^127\./, /^10\./, /^0\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./];

/** Validate a customer webhook URL against the SSRF guard. */
export function isSafeWebhookUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "URL must be http(s)" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return { ok: false, reason: "localhost is not an allowed webhook target" };
  if (host.includes(":")) {
    // IPv6 literal: block loopback (::1), unspecified (::), ULA (fc00::/7), link-local (fe80::/10).
    if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      return { ok: false, reason: "private/loopback IPv6 is not an allowed webhook target" };
    }
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reason: "private/loopback IPv4 is not an allowed webhook target" };
  }
  return { ok: true };
}

/** Minimal fetch shape for delivery (the global `fetch` satisfies it); injected for testability. */
export type DeliveryFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

export interface DeliveryResult {
  delivered: boolean;
  status?: number;
  reason?: string;
}

/**
 * Sign + POST a webhook payload to the customer URL (single attempt, time-bounded).
 *
 * @param url - the customer webhook URL (SSRF-checked first).
 * @param payload - the raw JSON body to send (and sign).
 * @param secret - the org's webhook secret.
 * @param doFetch - the fetch implementation (global fetch in prod, a fake in tests).
 * @param timeoutMs - per-attempt timeout (default 10s, per the spec).
 * @returns whether it was delivered (2xx) + the status, or a reason it wasn't.
 */
export async function deliverWebhook(url: string, payload: string, secret: string, doFetch: DeliveryFetch, timeoutMs = 10_000): Promise<DeliveryResult> {
  const safe = isSafeWebhookUrl(url);
  if (!safe.ok) return { delivered: false, reason: safe.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signWebhook(payload, secret) },
      body: payload,
      signal: controller.signal,
    });
    return { delivered: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    return { delivered: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
