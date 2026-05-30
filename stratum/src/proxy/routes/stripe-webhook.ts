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
      if (action.kind === "payment" && action.orgId !== null) {
        await deps.recordPayment({
          orgId: action.orgId,
          stripeInvoiceId: action.stripeInvoiceId,
          amountCents: action.amountCents,
          status: action.status,
          eventId: action.eventId,
        });
        return reply.code(200).send({ received: true, handled: action.eventType, status: action.status });
      }
      // Ignored event type, or a payment with no org_id metadata (can't attribute) — ACK with 200 so
      // Stripe stops retrying (it's not our job to re-handle an event we intentionally skip).
      return reply.code(200).send({ received: true, handled: null, reason: action.kind === "payment" ? "no org_id metadata" : "unhandled event type" });
    });
    done();
  };
}

/**
 * Live Stripe-webhook deps over Supabase: upsert the invoice's paid/failed state.
 *
 * @param client - a service-role Supabase client.
 * @param signingSecret - the endpoint signing secret (whsec_…).
 * @returns {@link StripeWebhookDeps}.
 */
export function createSupabaseStripeWebhookDeps(client: SupabaseClient, signingSecret: string): StripeWebhookDeps {
  return {
    signingSecret,
    async recordPayment(p: PaymentRecord): Promise<void> {
      const nowIso = new Date().toISOString();
      const { error } = await client.from("invoices").upsert(
        {
          org_id: p.orgId,
          stripe_invoice_id: p.stripeInvoiceId,
          amount_cents: p.amountCents,
          status: p.status,
          paid_at: p.status === "paid" ? nowIso : null,
          last_event_id: p.eventId,
          updated_at: nowIso,
        },
        { onConflict: "stripe_invoice_id" },
      );
      if (error) throw new Error(`recordPayment upsert failed: ${error.message}`);
    },
  };
}
