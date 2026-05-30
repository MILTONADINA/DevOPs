/**
 * Invoice runner (Phase 6 / v1.0.0) — compute an org's token-arbitrage invoice.
 *
 * Reads the org's append-only billing_records (FREE, read-only) and prints the CFO report —
 * savings, the 20%-of-savings fee, the plan's monthly-minimum floor, and the amount due. With
 * --csv it writes the signed-hash audit trail; with --send it attempts delivery through the
 * Stripe seam (which is a gated stub — see stripe-sink.ts — so --send fails honestly until
 * Stripe is wired + verified). NO Anthropic; gated only on Supabase creds.
 *
 *   npm run invoice -- --org-id <uuid> [--since <iso>] [--until <iso>] [--csv <path>] [--send]
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { generateInvoice, toAuditCsv, renderInvoice } from "../src/billing/invoice";
import { createSupabaseBillingDeps } from "../src/proxy/routes/billing";
import { createStripeInvoiceSink } from "../src/billing/stripe-sink";

interface Args {
  orgId?: string;
  since?: string;
  until?: string;
  csv?: string;
  send: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { send: false };
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
    writeFileSync(args.csv, toAuditCsv(records), "utf8");
    out(`\nAudit trail (${records.length} record(s)) → ${args.csv}`);
  }

  if (args.send) {
    out("");
    try {
      const receipt = await createStripeInvoiceSink().send(invoice);
      out(`Sent: ${receipt.id} (${receipt.status}, $${receipt.amountUsd.toFixed(2)}).`);
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
