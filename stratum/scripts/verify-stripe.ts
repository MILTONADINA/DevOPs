/**
 * Stripe TEST-MODE verification (MANUAL — the verify-* entry point for the Stripe integration).
 *
 * Every external integration in this repo has a one-command verifier (verify-tier2, verify-billing,
 * verify-encoder, smoke:live, smoke:judge); this is Stripe's. Given a TEST key it exercises the REAL
 * send flow against Stripe test mode (customer → invoiceitem → invoice → finalize) and round-trips
 * the inbound-webhook signature + routing locally — so the moment a `sk_test_` key arrives, the whole
 * Stripe gate is checkable with `npm run verify-stripe`.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npm run verify-stripe
 *
 * Honesty contract (stratum CLAUDE.md): never fabricates a PASS. No key → gated-skip (exit 0). A LIVE
 * key is REFUSED (test mode first — no real charges). The REAL inbound receipt still needs the deployed
 * /stripe/webhook registered in the Stripe Dashboard with its whsec; this proves send + verification logic.
 */

import "dotenv/config";
import { createHmac } from "node:crypto";
import { createStripeInvoiceSink } from "../src/billing/stripe-sink";
import { constructStripeEvent, stripeEventToAction } from "../src/billing/stripe-webhook";
import type { Invoice } from "../src/types/billing";

/** Classify the configured key without exposing it: missing/placeholder, a test key, or a live key. */
export function classifyStripeKey(key: string | undefined): "missing" | "test" | "live" {
  if (!key || key.trim() === "" || key.includes("...")) return "missing";
  if (key.startsWith("sk_live_")) return "live";
  return "test";
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

export async function main(nowMs: number = Date.now()): Promise<number> {
  const key = process.env["STRIPE_SECRET_KEY"];
  out("Stripe TEST-MODE verification (real send + local webhook-signature round-trip)");
  out("=".repeat(64));

  const mode = classifyStripeKey(key);
  if (mode === "missing") {
    out("  STRIPE_SECRET_KEY: NO  (set a TEST key sk_test_… in .env)");
    out("Gated — supply a Stripe test key to run the live send. Refusing to fabricate a PASS. Exiting 0.");
    return 0;
  }
  if (mode === "live") {
    out("  REFUSING a LIVE key (sk_live_): verify in TEST MODE first — this script will not move real money. Exiting 1.");
    return 1;
  }
  out(`  STRIPE_SECRET_KEY: yes (${(key as string).slice(0, 8)}…, test mode)`);

  const orgId = `verify-${nowMs}`;
  const invoice: Invoice = {
    orgId,
    plan: "starter",
    periodStart: "(verify)",
    periodEnd: "(verify)",
    recordCount: 1,
    totalOriginalTokens: 1000,
    totalQuarantinedTokens: 500,
    totalSavingsUsd: 5.0,
    rawFeeUsd: 1.0,
    monthlyMinimumUsd: 0,
    amountDueUsd: 1.0,
    effectivenessPct: 50,
    lineItems: [],
  };

  out("\n[1/2] Sending a $1.00 test invoice via the real Stripe API (customer → invoiceitem → invoice → finalize)…");
  const receipt = await createStripeInvoiceSink({ secretKey: key as string }).send(invoice);
  out(`  ✓ Stripe accepted it: invoice ${receipt.id}, status "${receipt.status}", $${receipt.amountUsd.toFixed(2)}`);

  out("\n[2/2] Round-tripping the inbound webhook signature + routing (local — the real receipt needs the deployed endpoint)…");
  const whsec = "whsec_verify_local";
  const t = Math.floor(nowMs / 1000);
  const event = JSON.stringify({ id: "evt_verify", type: "invoice.paid", data: { object: { id: receipt.id, amount_paid: 100, metadata: { org_id: orgId } } } });
  const sig = `t=${t},v1=${createHmac("sha256", whsec).update(`${t}.${event}`, "utf8").digest("hex")}`;
  const action = stripeEventToAction(constructStripeEvent(event, sig, whsec, { nowSec: t }));
  if (action.kind !== "payment" || action.status !== "paid" || action.orgId !== orgId) {
    out("  ✗ webhook routing did not produce the expected paid action for the org");
    return 1;
  }
  out(`  ✓ signed invoice.paid → paid action for org ${action.orgId} ($${(action.amountCents / 100).toFixed(2)})`);

  out("\nPASS — Stripe send works in test mode AND the webhook verification logic round-trips.");
  out("To complete a REAL paid invoice: deploy /stripe/webhook, register it in the Stripe Dashboard, set");
  out("its whsec as STRIPE_WEBHOOK_SECRET, send a design partner the invoice, and watch invoice.paid arrive.");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("verify-stripe.ts") || entryPath.endsWith("verify-stripe.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`verify-stripe failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
