/**
 * Verify billing-record signatures (Phase 6 / v0.9.x) — FREE, READ-ONLY.
 *
 * Recomputes the HMAC of every billing record for an org and reports any whose stored
 * signed_hash no longer matches — i.e. the dispute-proof check (BUSINESS_MODEL.md: "they need
 * to verify every number independently"). Reads only; gated on Supabase creds + the dedicated
 * CQ_BILLING_SIGNING_SECRET (the same secret the recorder signed with).
 *
 *   npm run verify-billing -- --org-id <uuid> [--since <iso>] [--until <iso>]
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyBillingRecord, type BillingInput } from "../src/billing/recorder";

interface Args {
  orgId?: string;
  since?: string;
  until?: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const val = (): string => argv[++i] ?? "";
    if (tok === "--org-id") out.orgId = val();
    else if (tok === "--since") out.since = val();
    else if (tok === "--until") out.until = val();
  }
  return out;
}

interface BillingRow {
  id: string;
  session_id: string;
  org_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  api_price_per_token: number;
  pruning_log_id: string | null;
  signed_hash: string;
}

/** Map a stored row to its signing inputs (pure; testable). */
export function rowToInput(r: BillingRow): BillingInput {
  return {
    sessionId: r.session_id,
    orgId: r.org_id,
    originalTokens: r.original_tokens,
    quarantinedTokens: r.quarantined_tokens,
    apiPricePerToken: r.api_price_per_token,
    ...(r.pruning_log_id !== null ? { pruningLogId: r.pruning_log_id } : {}),
  };
}

/** Read the entire ordered ledger, rejecting silent REST caps and changing counts. */
export async function verifyOrgBilling(client: SupabaseClient, orgId: string, secret: string, bounds: Pick<Args, "since" | "until"> = {}): Promise<{ records: number; tampered: string[] }> {
  let records = 0;
  let expected: number | undefined;
  const tampered: string[] = [];
  while (records === 0 || records < (expected ?? 0)) {
    let query = client
      .from("billing_records")
      .select("id, session_id, org_id, original_tokens, quarantined_tokens, api_price_per_token, pruning_log_id, signed_hash", { count: "exact" })
      .eq("org_id", orgId);
    if (bounds.since !== undefined) query = query.gte("created_at", bounds.since);
    if (bounds.until !== undefined) query = query.lte("created_at", bounds.until);
    const { data, error, count } = await query.order("id", { ascending: true }).range(records, records + 499);
    if (error) throw new Error(`read billing_records failed: ${error.message}`);
    if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error("billing verification failed: exact row count unavailable");
    if (expected !== undefined && count !== expected) throw new Error("billing verification failed: row count changed during paging");
    expected = count;
    const page = (data ?? []) as BillingRow[];
    if (page.length === 0 && records < expected) throw new Error("billing verification failed: empty page before exact row count");
    for (const row of page) if (!verifyBillingRecord(rowToInput(row), row.signed_hash, secret)) tampered.push(row.id);
    records += page.length;
    if (records > expected) throw new Error("billing verification failed: page exceeded exact row count");
    if (records === expected) return { records, tampered };
  }
  throw new Error("billing verification failed: pagination ended before exact row count");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const args = parseArgs(argv);
  if (args.orgId === undefined || args.orgId === "") {
    out("usage: npm run verify-billing -- --org-id <uuid> [--since <iso>] [--until <iso>]");
    return 1;
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  const secret = process.env["CQ_BILLING_SIGNING_SECRET"];
  if (!url || !key) {
    out(`verify-billing requires ${[!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_KEY"].filter(Boolean).join(" and ")}.`);
    return 1;
  }
  if (!secret) {
    out("verify-billing requires CQ_BILLING_SIGNING_SECRET (the recorder's signing key).");
    return 1;
  }
  const client = createClient(url, key);

  const { records, tampered } = await verifyOrgBilling(client, args.orgId, secret, args);

  out(`Billing signature verification — org ${args.orgId}`);
  out("=".repeat(50));
  out(`  records:   ${records}`);
  out(`  verified:  ${records - tampered.length}`);
  out(`  TAMPERED:  ${tampered.length}`);
  if (tampered.length > 0) {
    for (const id of tampered) out(`    ✗ ${id}`);
    out("INTEGRITY FAILURE — a record's signature does not match its data.");
    return 1;
  }
  out(records === 0 ? "(no billing records yet — nothing to verify.)" : "All signatures valid ✓");
  return 0;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("verify-billing.ts") || entryPath.endsWith("verify-billing.js")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`verify-billing failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
