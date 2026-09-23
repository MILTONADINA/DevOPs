/**
 * Invoice runner (Phase 6 / v1.0.0) — compute an org's token-arbitrage invoice.
 *
 * Reads the org's append-only billing_records (FREE, read-only) and prints the CFO report —
 * savings, the 20%-of-savings fee, the plan's monthly-minimum floor, and the amount due. With
 * --csv it writes the signed-hash audit trail; with --send it delivers through the REAL Stripe sink
 * (createStripeInvoiceSink → customer → invoiceitem → invoice → finalize). --send needs STRIPE_SECRET_KEY
 * (a sk_test_ key; sk_live_ is refused until verified) and exits 2 if that delivery is unavailable — the
 * engine still ran. NO Anthropic; gated only on Supabase creds (+ a Stripe key for --send).
 *
 *   npm run invoice -- --org-id <uuid> [--since <iso>] [--until <iso>] [--csv <path>] [--send]
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { generateInvoice, toAuditCsv, renderInvoice } from "../src/billing/invoice";
import { createSupabaseBillingDeps } from "../src/proxy/routes/billing";
import { createStripeInvoiceSink } from "../src/billing/stripe-sink";
import { usdToCents } from "../src/billing/stripe";
import { createSupabaseInvoiceLedger } from "../src/billing/invoice-ledger";

interface Args {
  orgId?: string;
  since?: string;
  until?: string;
  csv?: string;
  send: boolean;
  /** Override the period-dedup guard (re-send an already-sent period). */
  force: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { send: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    switch (tok) {
      case "--org-id":
        out.orgId = val();
        break;
      case "--since":
        out.since = val();
        break;
      case "--until":
        out.until = val();
        break;
      case "--csv":
        out.csv = val();
        break;
      case "--send":
        out.send = true;
        break;
      case "--force":
        out.force = true;
        break;
      default:
        break;
    }
  }
  return out;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.orgId === undefined || args.orgId === "") {
    out("usage: npm run invoice -- --org-id <uuid> [--since <iso>] [--until <iso>] [--csv <path>] [--send]");
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("invoice SKIPPED: set SUPABASE_URL + SUPABASE_SERVICE_KEY to read billing_records. Exiting 0.");
    return 0;
  }
  const client = createClient(url, key);

  // Same source the CFO billing API uses (src/proxy/routes/billing.ts) — one read path.
  const deps = createSupabaseBillingDeps(client);
  const plan = await deps.getOrgPlan(args.orgId);
  if (plan === null) {
    out(`No organization found with id ${args.orgId}.`);
    return 1;
  }
  const records = await deps.listBillingRecords(args.orgId, args.since, args.until);

  const invoice = generateInvoice(args.orgId, plan, records, args.since ?? "(all time)", args.until ?? "(now)");
  out(renderInvoice(invoice));
  if (records.length === 0) out("\n(no billing records in range — pruning has not run in the request path yet; this is the engine, ready ahead of activation.)");

  if (args.csv !== undefined) {
    writeFileSync(args.csv, toAuditCsv(records, invoice), "utf8");
    out(`\nAudit trail (${records.length} record(s)) → ${args.csv}`);
  }

  if (args.send) {
    out("");
    // A $0 amount-due (starter/custom org with no savings yet) is "nothing to bill", an EXPECTED state —
    // not a delivery failure. Skip the Stripe send cleanly (exit 0) instead of letting the sink throw.
    if (!(invoice.amountDueUsd > 0)) {
      out(`--send skipped: amount due is $${invoice.amountDueUsd.toFixed(2)} — nothing to charge for org ${args.orgId}.`);
      return 0;
    }
    const ledger = createSupabaseInvoiceLedger(client);
    // Period-dedup: refuse a second --send for the same (org, period) — a duplicate real invoice is the
    // worst failure mode. Only when both bounds are present (an unbounded all-time invoice has no period
    // to key on; the Stripe-side idempotency key still guards it). --force overrides (e.g. a re-issue).
    if (args.since !== undefined && args.until !== undefined && !args.force) {
      const existing = await ledger.findActiveForPeriod(args.orgId, args.since, args.until);
      if (existing !== null) {
        out(`--send refused: invoice ${existing.stripe_invoice_id} (${existing.status}) already sent for org ${args.orgId} over ${args.since} → ${args.until}. Re-run with --force to re-issue.`);
        return 2;
      }
    }
    try {
      const receipt = await createStripeInvoiceSink({ secretKey: process.env["STRIPE_SECRET_KEY"] ?? "" }).send(invoice);
      out(`Sent: ${receipt.id} (${receipt.status}, $${receipt.amountUsd.toFixed(2)}).`);
      // Record the sent invoice (status 'sent') so the dashboard sees it pre-payment and a re-send is
      // deduped. A ledger failure here does NOT fail the run (the charge already happened + the Stripe
      // idempotency key still protects a retry); surface it so the operator can reconcile.
      try {
        await ledger.recordSent(args.orgId, {
          stripeInvoiceId: receipt.id,
          amountCents: usdToCents(invoice.amountDueUsd),
          currency: "usd",
          periodStart: args.since,
          periodEnd: args.until,
        });
      } catch (e) {
        out(`  (warning: invoice sent but not recorded locally: ${e instanceof Error ? e.message : String(e)})`);
      }
    } catch (e) {
      out(`--send not available: ${e instanceof Error ? e.message : String(e)}`);
      return 2; // distinct code: the engine ran, but delivery is gated
    }
  }
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("invoice.ts") || entryPath.endsWith("invoice.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`invoice failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
