/**
 * Billing-record source that exists only for the invoice CLI (scripts/invoice.ts): an organization's plan and its billing records,
 * read from Supabase. Nothing in src/proxy imports this module or registers a route from it; the usage read API
 * (GET /v1/billing/summary and GET /v1/billing/records) is in ./usage (specs/ops/payment-removal.md REQ-3).
 * listBillingRecords still selects cq_fee_usd and signed_hash, which the invoice engine and its audit CSV need. The CLI stays until
 * REQ-7 of that spec (cycle C3) deletes it, and this file goes in the same commit: the CLI is its only importer outside its own
 * test, and its import of ../../billing/invoice is one REQ-7 forbids once src/billing/ is gone. Read-only; no Anthropic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillableRecord } from "../../billing/invoice";

export interface BillingDeps {
  /** The org's billing records in [since, until] (ISO bounds optional) — the invoice CLI's source. */
  listBillingRecords: (orgId: string, since?: string, until?: string) => Promise<BillableRecord[]>;
  /** The org's plan (drives the monthly-minimum floor), or null if the org is unknown. */
  getOrgPlan: (orgId: string) => Promise<string | null>;
}

/** Live billing source over Supabase (service-role). */
export function createSupabaseBillingDeps(client: SupabaseClient): BillingDeps {
  return {
    async getOrgPlan(orgId: string): Promise<string | null> {
      const { data, error } = await client.from("organizations").select("plan").eq("id", orgId).limit(1);
      if (error) throw new Error(`getOrgPlan failed: ${error.message}`);
      const row = (data ?? [])[0] as { plan: string } | undefined;
      return row ? row.plan : null;
    },
    async listBillingRecords(orgId: string, since?: string, until?: string): Promise<BillableRecord[]> {
      const rows: BillableRecord[] = [];
      let expected: number | undefined;
      do {
        let q = client.from("billing_records").select("session_id, original_tokens, quarantined_tokens, cost_delta_usd, cq_fee_usd, signed_hash", { count: "exact" }).eq("org_id", orgId);
        if (since !== undefined) q = q.gte("created_at", since);
        if (until !== undefined) q = q.lt("created_at", until);
        const { data, error, count } = await q.order("id", { ascending: true }).range(rows.length, rows.length + 499);
        if (error) throw new Error(`listBillingRecords failed: ${error.message}`);
        if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error("listBillingRecords failed: exact count unavailable");
        if (expected !== undefined && count !== expected) throw new Error("listBillingRecords failed: row count changed during paging");
        expected = count;
        const page = (data ?? []) as BillableRecord[];
        if (page.length === 0 && rows.length < expected) throw new Error("listBillingRecords failed: empty page before exact row count");
        rows.push(...page);
        if (rows.length > expected) throw new Error("listBillingRecords failed: page exceeded exact row count");
      } while (rows.length < expected);
      return rows;
    },
  };
}
