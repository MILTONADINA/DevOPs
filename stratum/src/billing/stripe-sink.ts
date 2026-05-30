/**
 * Invoice delivery seam (Phase 6 / v1.0.0).
 *
 * The injectable boundary between the (pure, tested) invoice ENGINE and the external payment
 * provider — the same pattern as the LLM-judge and audit-completion seams. A {@link FakeInvoiceSink}
 * lets the pipeline be tested with no network; the real Stripe sink is an HONEST GATED STUB that
 * THROWS rather than ship unverified money-handling code (the crypto.ts precedent: do not fabricate
 * verified behavior for a sensitive integration). Wiring real Stripe requires STRIPE_SECRET_KEY +
 * verification against Stripe TEST MODE + a billing review — none of which can be faked here.
 */

import type { Invoice } from "../types/billing";
import { sendStripeInvoice, type StripeFetch } from "./stripe";

export interface InvoiceReceipt {
  /** The provider's invoice id (or a fake id under the fake sink). */
  id: string;
  /** e.g. "draft" | "open" | "paid" (fake sink returns "draft"). */
  status: string;
  amountUsd: number;
}

export interface InvoiceSink {
  send(invoice: Invoice): Promise<InvoiceReceipt>;
}

export interface FakeInvoiceSink extends InvoiceSink {
  /** Invoices captured by this fake (for assertions). */
  readonly sent: Invoice[];
}

/** A no-network sink that records what it was asked to send (for tests + dry runs). */
export function createFakeInvoiceSink(): FakeInvoiceSink {
  const sent: Invoice[] = [];
  return {
    sent,
    send(invoice: Invoice): Promise<InvoiceReceipt> {
      sent.push(invoice);
      return Promise.resolve({ id: `fake_inv_${sent.length}`, status: "draft", amountUsd: invoice.amountDueUsd });
    },
  };
}

export interface StripeSinkOptions {
  /** The Stripe secret key (an empty/absent key makes send() throw with guidance). */
  secretKey: string;
  /** Injected fetch (defaults to a global-fetch adapter). */
  doFetch?: StripeFetch;
  /** Allow a LIVE key. Default false — refuse sk_live_ until verified in test mode. */
  allowLiveKey?: boolean;
}

/** Adapt the global fetch to the {@link StripeFetch} shape. */
const defaultStripeFetch: StripeFetch = (url, init) => fetch(url, init).then((r) => ({ status: r.status, json: () => r.json() }));

/**
 * The real Stripe sink — runs the customer → invoice-item → invoice → finalize flow (src/billing/stripe.ts).
 * The request construction (incl. the dollars→cents conversion) is unit-tested via an injected fetch;
 * the live API is gated on a Stripe TEST-MODE key, and a LIVE key is refused until explicitly verified.
 *
 * @param options - secret key + optional injected fetch + live-key guard.
 * @returns an {@link InvoiceSink} backed by Stripe.
 */
export function createStripeInvoiceSink(options: StripeSinkOptions): InvoiceSink {
  return {
    send(invoice: Invoice): Promise<InvoiceReceipt> {
      return sendStripeInvoice(
        {
          secretKey: options.secretKey,
          doFetch: options.doFetch ?? defaultStripeFetch,
          ...(options.allowLiveKey !== undefined ? { allowLiveKey: options.allowLiveKey } : {}),
        },
        invoice,
      );
    },
  };
}
