/**
 * Webhook signing (Phase 2+ commercial) — HMAC-SHA256, per docs/WEBHOOKS.md.
 *
 * Every outbound webhook carries `X-CQ-Signature: sha256=<hex>` over the RAW JSON body, so the
 * receiver can verify authenticity before processing. Same discipline as the billing recorder:
 * a dedicated per-org secret (org_config.webhook_secret), constant-time verification. PURE; tested.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The `X-CQ-Signature` header name (per the spec). */
export const SIGNATURE_HEADER = "x-cq-signature";

/** Sign a raw payload → `sha256=<hex>` (the value of X-CQ-Signature). */
export function signWebhook(payload: string, secret: string): string {
  if (secret === "") throw new Error("webhook secret must not be empty");
  return `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
}

/**
 * Constant-time verification of an `X-CQ-Signature` (the receiver-side check; we ship it so our
 * own test endpoint + docs match exactly). Accepts the header with or without the `sha256=` prefix.
 *
 * @param payload - the raw request body.
 * @param signature - the X-CQ-Signature header value.
 * @param secret - the shared webhook secret.
 * @returns true iff valid.
 */
export function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  if (secret === "") return false;
  const expected = signWebhook(payload, secret); // sha256=<hex>
  const received = signature.startsWith("sha256=") ? signature : `sha256=${signature}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
