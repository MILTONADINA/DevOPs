/**
 * Stripe INBOUND webhook route (Phase 6 / v1.0.0) — POST /stripe/webhook.
 *
 * Receives Stripe's signed `invoice.paid` (and payment_failed) callbacks, verifies the
 * `Stripe-Signature` over the RAW body, and records the payment — the "paid by design
 * partner" half of v1.0.0. PUBLIC by path (mounted OUTSIDE /v1/, so the API-key auth gate
 * exempts it, like /openapi.json): the SIGNATURE is the authentication, not an API key.
 *
 * Raw body: Stripe's HMAC is over the exact request bytes, so this plugin installs its OWN
 * (encapsulated) application/json parser that keeps req.body as the raw STRING — re-serialized
 * JSON would not verify. The signing secret + persistence are INJECTED, so the route is fully
 * testable with a constructed signature + a fake recorder (no Stripe, no DB).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { constructStripeEvent, stripeEventToAction } from "../../billing/stripe-webhook";

/** A payment to persist (idempotent on stripeInvoiceId). */
export interface PaymentRecord {
  orgId: string;
  stripeInvoiceId: string;
  amountCents: number;
  status: "paid" | "failed";
  eventId: string;
}

export interface StripeWebhookDeps {
  /** The endpoint signing secret (whsec_…); server-side only, never exposed. */
  signingSecret: string;
  /** Persist a payment (upsert by stripeInvoiceId). A fake in tests; Supabase in prod. */
  recordPayment: (p: PaymentRecord) => Promise<void>;
  /** Current unix time (seconds) — injected for deterministic tests. Default Date.now()/1000. */
  nowSec?: () => number;
}

function err(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type: "request_error", message } });
}

/**
 * Build the Stripe inbound-webhook plugin.
 *
 * @param deps - signing secret + payment recorder (+ optional clock).
 * @returns a plugin registering POST /stripe/webhook with a scoped raw-body parser.
 */
export function makeStripeWebhookRoute(deps: StripeWebhookDeps): FastifyPluginCallback {
  return function stripeWebhookPlugin(app: FastifyInstance, _opts, done): void {
    // Encapsulated parser: keep the RAW body string (the signature is over exact bytes). Scoped to
    // this plugin, so other routes' JSON parsing is unaffected. A larger limit than typical JSON —
    // Stripe invoice events can be a few KB.
    app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1_048_576 }, (_req, body, cb) => {
      cb(null, body);
    });

    app.post("/stripe/webhook", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const sig = req.headers["stripe-signature"];
      if (typeof sig !== "string" || sig === "") return err(reply, 400, "missing Stripe-Signature header");

      const opts = deps.nowSec ? { nowSec: deps.nowSec() } : {};
      let event;
      try {
        event = constructStripeEvent(raw, sig, deps.signingSecret, opts);
      } catch (e) {
        // A bad signature / malformed body is a 400 (Stripe will not retry a 4xx as a transient
        // failure; a forged event must never be acked as accepted).
        return err(reply, 400, (e as Error).message);
      }

      const action = stripeEventToAction(event);
      // Persist only an attributable payment: a real org AND a real invoice id. A missing invoice id
      // would otherwise become an empty-string idempotency key, and (since '' is a single value under
      // the UNIQUE constraint) a second empty-key event for a DIFFERENT org would overwrite the first
      // — a cross-org misattribution on a financial table. Skip + ACK 200 (don't make Stripe retry).
      if (action.kind === "payment" && action.orgId !== null && action.stripeInvoiceId !== "") {
        await deps.recordPayment({
          orgId: action.orgId,
          stripeInvoiceId: action.stripeInvoiceId,
          amountCents: action.amountCents,
          status: action.status,
          eventId: action.eventId,
        });
        return reply.code(200).send({ received: true, handled: action.eventType, status: action.status });
      }
      // Ignored event type, or an un-attributable payment (no org_id metadata / no invoice id) — ACK
      // with 200 so Stripe stops retrying (it's not our job to re-handle an event we intentionally skip).
      const reason = action.kind !== "payment" ? "unhandled event type" : action.orgId === null ? "no org_id metadata" : "missing invoice id";
      return reply.code(200).send({ received: true, handled: null, reason });
    });
    done();
  };
}

/**
 * Live Stripe-webhook deps over Supabase: record the invoice's paid/failed state via the FORWARD-ONLY
 * `record_invoice_payment` RPC (migration 20260530000000). The RPC makes the merge atomic + forward-only
 * so a stale/out-of-order `invoice.payment_failed` delivered after `invoice.paid` cannot downgrade a paid
 * invoice (Stripe is at-least-once with no ordering guarantee). A blind upsert would clobber it.
 *
 * @param client - a service-role Supabase client.
 * @param signingSecret - the endpoint signing secret (whsec_…).
 * @returns {@link StripeWebhookDeps}.
 */
export function createSupabaseStripeWebhookDeps(client: SupabaseClient, signingSecret: string): StripeWebhookDeps {
  return {
    signingSecret,
    async recordPayment(p: PaymentRecord): Promise<void> {
      const { error } = await client.rpc("record_invoice_payment", {
        p_org_id: p.orgId,
        p_stripe_invoice_id: p.stripeInvoiceId,
        p_amount_cents: p.amountCents,
        p_status: p.status,
        p_event_id: p.eventId,
      });
      if (error) throw new Error(`recordPayment failed: ${error.message}`);
    },
  };
}
