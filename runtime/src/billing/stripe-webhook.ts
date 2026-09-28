/**
 * Stripe INBOUND webhook verification + event routing (Phase 6 / v1.0.0).
 *
 * The other half of billing: sendStripeInvoice (stripe.ts) SENDS an invoice; this RECEIVES
 * Stripe's `invoice.paid` callback — the literal "paid by design partner" signal that closes
 * the v1.0.0 loop. Stripe signs every webhook with `Stripe-Signature: t=<unix>,v1=<hex-hmac>`;
 * the HMAC is over `"<t>.<rawBody>"` keyed by the endpoint's signing secret (whsec_…). We MUST
 * verify it on the RAW bytes (a re-serialized JSON body would not match) and reject stale
 * timestamps (replay defense) — otherwise anyone could POST a forged "you got paid" event.
 *
 * Pure (node:crypto only — no network, no SDK, no DB): the verification + the event→action
 * routing are fully unit-tested by constructing a payload + a real HMAC with a test secret. The
 * route (routes/stripe-webhook.ts) wires the raw body + persistence; the REAL receipt is gated on
 * a Stripe endpoint + its whsec_ (external), exactly like sendStripeInvoice's test-key gate.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The minimal shape of a Stripe event we consume (Stripe sends much more; we read what we need). */
export interface StripeWebhookEvent {
  /** Stripe event id (evt_…) — used for idempotent persistence. */
  id: string;
  /** Event type, e.g. "invoice.paid". */
  type: string;
  /** The event's primary object (an invoice, for the events we handle). */
  data: { object: Record<string, unknown> };
}

/** Parse a `Stripe-Signature` header into its timestamp + the v1 HMAC signature(s). */
function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  if (typeof header !== "string" || header === "") return null;
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("="); // the hex value contains no '=', so first '=' splits cleanly
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t") t = Number(val);
    else if (key === "v1" && val !== "") v1.push(val);
  }
  if (!Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

export interface VerifyOptions {
  /** Max age of the signed timestamp, seconds (replay window). Default 300 (Stripe's recommendation). */
  toleranceSec?: number;
  /** Current unix time, seconds — injected for deterministic tests. Default Date.now()/1000. */
  nowSec?: number;
}

/**
 * Verify a Stripe webhook signature against the RAW request body (constant-time).
 *
 * @param payload - the EXACT raw request body bytes (string). Re-serialized JSON will NOT verify.
 * @param header - the `Stripe-Signature` header value.
 * @param secret - the endpoint signing secret (whsec_…).
 * @param opts - tolerance + injectable clock.
 * @returns true iff a v1 signature matches AND the timestamp is within tolerance.
 */
export function verifyStripeSignature(payload: string, header: string, secret: string, opts: VerifyOptions = {}): boolean {
  if (secret === "") return false; // no secret ⇒ cannot verify ⇒ fail closed (never accept unsigned)
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.t) > tolerance) return false; // stale/future ⇒ replay defense
  const expected = createHmac("sha256", secret).update(`${parsed.t}.${payload}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  // Constant-time compare against each provided v1 (Stripe may send several during secret rotation).
  return parsed.v1.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

/**
 * Verify + parse a Stripe webhook into an event (the `stripe.webhooks.constructEvent` equivalent).
 *
 * @param payload - the raw request body.
 * @param header - the `Stripe-Signature` header.
 * @param secret - the endpoint signing secret.
 * @param opts - verification options.
 * @returns the parsed {@link StripeWebhookEvent}.
 * @throws {Error} if the signature is invalid or the body is not a well-formed event.
 */
export function constructStripeEvent(payload: string, header: string, secret: string, opts: VerifyOptions = {}): StripeWebhookEvent {
  if (!verifyStripeSignature(payload, header, secret, opts)) {
    throw new Error("invalid Stripe webhook signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Stripe webhook body is not valid JSON");
  }
  const p = parsed as { id?: unknown; type?: unknown; data?: { object?: unknown } };
  if (typeof p.type !== "string" || typeof p.id !== "string" || !p.data || typeof p.data.object !== "object" || p.data.object === null) {
    throw new Error("Stripe webhook body is not a well-formed event (missing id/type/data.object)");
  }
  return { id: p.id, type: p.type, data: { object: p.data.object as Record<string, unknown> } };
}

/** What a received event means for our billing state — pure, so it is fully unit-tested. */
export type StripeWebhookAction =
  | {
      kind: "payment";
      /** Whether the invoice was paid or the payment failed. */
      status: "paid" | "failed";
      /** Stripe invoice id (in_…) — the idempotency key for persistence. */
      stripeInvoiceId: string;
      /** Our org id, read from the invoice's metadata.org_id (set by sendStripeInvoice); null if absent. */
      orgId: string | null;
      /** Amount in integer cents (amount_paid for paid; amount_due otherwise). */
      amountCents: number;
      /** Stripe event id (evt_…) — recorded for idempotency + audit. */
      eventId: string;
      eventType: string;
    }
  | { kind: "ignore"; eventType: string };

function readOrgId(obj: Record<string, unknown>): string | null {
  const md = obj["metadata"];
  if (md && typeof md === "object") {
    const v = (md as Record<string, unknown>)["org_id"];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

function readInt(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * Map a verified Stripe event to the billing action it implies.
 *
 * Handles the invoice lifecycle events that matter for "invoice sent + paid":
 * `invoice.paid` / `invoice.payment_succeeded` → a paid payment; `invoice.payment_failed`
 * → a failed one. Everything else is ignored (returned, not thrown — Stripe sends many event
 * types and a 200 ack is expected for all). The caller persists `payment` actions idempotently.
 *
 * @param event - a verified {@link StripeWebhookEvent}.
 * @returns the {@link StripeWebhookAction}.
 */
export function stripeEventToAction(event: StripeWebhookEvent): StripeWebhookAction {
  const obj = event.data.object;
  const base = { stripeInvoiceId: typeof obj["id"] === "string" ? obj["id"] : "", orgId: readOrgId(obj), eventId: event.id, eventType: event.type };
  switch (event.type) {
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return { kind: "payment", status: "paid", amountCents: readInt(obj, "amount_paid", "amount_due", "total"), ...base };
    case "invoice.payment_failed":
      return { kind: "payment", status: "failed", amountCents: readInt(obj, "amount_due", "total"), ...base };
    default:
      return { kind: "ignore", eventType: event.type };
  }
}
