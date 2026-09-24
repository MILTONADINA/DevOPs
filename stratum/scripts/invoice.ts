/**
 * Invoice runner (Phase 6 / v1.0.0) — compute an org's token-arbitrage invoice.
 *
 * Reads the org's append-only billing_records (FREE, read-only) and prints the CFO report —
 * savings, the 20%-of-savings fee, the plan's monthly-minimum floor, and the amount due. With
 * --csv it writes the signed-hash audit trail; with --send it finalizes through the Stripe sink
 * (createStripeInvoiceSink → customer → invoiceitem → invoice → finalize). --send needs STRIPE_SECRET_KEY
 * (a sk_test_ key; sk_live_ is refused until verified) and exits 2 if finalization is unavailable — the
 * engine still ran. NO Anthropic; gated only on Supabase creds (+ a Stripe key for --send).
 *
 *   npm run invoice -- --org-id <uuid> [--since <iso> --until <iso>] [--csv <path>] [--send | --reconcile <in_id>]
 */

import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { generateInvoice, toAuditCsv, renderInvoice } from "../src/billing/invoice";
import { createSupabaseBillingDeps } from "../src/proxy/routes/billing";
import { createStripeInvoiceSink, defaultStripeFetch } from "../src/billing/stripe-sink";
import { verifyStripeInvoiceForReconciliation } from "../src/billing/stripe";
import { claimAndFinalizeInvoice, createSupabaseInvoiceLedger, reconcileClaimedInvoice } from "../src/billing/invoice-ledger";

interface Args {
  orgId?: string;
  since?: string;
  until?: string;
  csv?: string;
  send: boolean;
  reconcile?: string;
  /** Legacy flag; rejected for sends because it bypasses the local dedup guard. */
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
      case "--reconcile":
        out.reconcile = val();
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
    out("usage: npm run invoice -- --org-id <uuid> [--since <iso> --until <iso>] [--csv <path>] [--send | --reconcile <in_id>]");
    return 1;
  }

  if (args.send || args.reconcile !== undefined) {
    if (args.reconcile !== undefined && (args.send || args.reconcile === "")) {
      out("--reconcile requires an invoice ID and cannot be combined with --send.");
      return 2;
    }
    if (args.force) {
      out("Invoice finalization and reconciliation refuse --force: reconcile the prior Stripe invoice and local claim before any re-issue.");
      return 2;
    }
    const start = Date.parse(args.since ?? "");
    const end = Date.parse(args.until ?? "");
    if (!args.since || !args.until || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      out("Invoice finalization or reconciliation requires valid increasing --since and --until period bounds.");
      return 2;
    }
    if (!process.env["STRIPE_SECRET_KEY"]?.startsWith("sk_test_")) {
      out("Invoice finalization or reconciliation requires a Stripe test-mode key.");
      return 2;
    }
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out(`invoice requires ${[!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_KEY"].filter(Boolean).join(" and ")} to read billing_records.`);
    return 1;
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

  if (args.reconcile !== undefined) {
    try {
      const receipt = await reconcileClaimedInvoice(
        createSupabaseInvoiceLedger(client),
        () => verifyStripeInvoiceForReconciliation({ secretKey: process.env["STRIPE_SECRET_KEY"]!, doFetch: defaultStripeFetch }, args.reconcile!, invoice),
        args.orgId,
        args.since!,
        args.until!,
        args.reconcile,
        invoice,
      );
      out(`Reconciled Stripe invoice ${receipt.id} (${receipt.status}, $${receipt.amountUsd.toFixed(2)}); period claim retained.`);
      return 0;
    } catch (error) {
      out(`--reconcile refused: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.send) {
    out("");
    // A $0 amount-due (starter/custom org with no savings yet) is "nothing to bill", an EXPECTED state —
    // not a finalization failure. Skip Stripe cleanly (exit 0) instead of letting the sink throw.
    if (!(invoice.amountDueUsd > 0)) {
      out(`--send skipped: amount due is $${invoice.amountDueUsd.toFixed(2)} — nothing to charge for org ${args.orgId}.`);
      return 0;
    }
    const ledger = createSupabaseInvoiceLedger(client);
    const periodStart = args.since!;
    const periodEnd = args.until!;
    const existing = await ledger.findActiveForPeriod(args.orgId, periodStart, periodEnd);
    if (existing !== null) {
      out(`--send refused: invoice ${existing.stripe_invoice_id} (${existing.status}) already recorded for org ${args.orgId} over ${periodStart} → ${periodEnd}.`);
      return 2;
    }
    try {
      const receipt = await claimAndFinalizeInvoice(ledger, createStripeInvoiceSink({ secretKey: process.env["STRIPE_SECRET_KEY"] ?? "" }), args.orgId, periodStart, periodEnd, invoice);
      out(`Finalized: ${receipt.id} (${receipt.status}, $${receipt.amountUsd.toFixed(2)}).`);
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
