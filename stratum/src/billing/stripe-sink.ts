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

/**
 * The real Stripe sink — an intentionally GATED STUB. Sending a real invoice moves money; we do
 * not ship that path unverified. Implement the Stripe customer→invoice-item→invoice→finalize flow
 * and verify it end-to-end in Stripe TEST MODE (then a billing review) before enabling.
 *
 * @returns an {@link InvoiceSink} whose `send` throws until that work is done.
 */
export function createStripeInvoiceSink(): InvoiceSink {
  return {
    send(): Promise<InvoiceReceipt> {
      return Promise.reject(
        new Error(
          "Stripe invoice sending is not implemented — gated on STRIPE_SECRET_KEY + verification against Stripe TEST MODE + a billing review. Refusing to ship unverified payment code (see src/pruner/crypto.ts precedent). The invoice ENGINE (generateInvoice/toAuditCsv) is complete and usable now.",
        ),
      );
    },
  };
}
