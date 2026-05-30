/**
 * CFO billing API (Phase 6 / v1.0.0) — the backend the CFO dashboard calls.
 *
 *   GET /v1/billing/invoice[?org-id&since&until]  → the computed Invoice JSON (savings, 20%
 *                                                    fee, plan minimum floor, line items).
 *   GET /v1/billing/audit.csv[?org-id&since&until] → the signed-hash audit trail (CSV download),
 *                                                    "the most important artifact" (BUSINESS_MODEL.md).
 *
 * Org scope comes from req.orgId (set by the auth gate) and falls back to ?org-id when the proxy
 * runs unauthenticated. The record source is INJECTED (BillingDeps) so the route is testable via
 * app.inject() with no DB; createSupabaseBillingDeps wires the live source. Composes the pure
 * invoice engine (src/billing/invoice.ts). FREE (read-only); no Anthropic.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateInvoice, toAuditCsv, type BillableRecord } from "../../billing/invoice";

export interface BillingDeps {
  /** The org's billing records in [since, until] (ISO bounds optional). */
  listBillingRecords: (orgId: string, since?: string, until?: string) => Promise<BillableRecord[]>;
  /** The org's plan (drives the monthly-minimum floor), or null if the org is unknown. */
  getOrgPlan: (orgId: string) => Promise<string | null>;
}

/** The org for this request: the authenticated org, else ?org-id (unauthenticated proxy). */
function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  const q = req.query as Record<string, unknown>;
  const fromQuery = q["org-id"];
  return typeof fromQuery === "string" && fromQuery !== "" ? fromQuery : undefined;
}

function strParam(req: FastifyRequest, name: string): string | undefined {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function err(reply: FastifyReply, code: number, type: string, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type, message } });
}

/**
 * Build the billing API plugin bound to a record source.
 *
 * @param deps - the billing record + plan source (a fake in tests, Supabase in prod).
 * @returns a plugin registering GET /v1/billing/invoice and /v1/billing/audit.csv.
 */
export function makeBillingRoute(deps: BillingDeps): FastifyPluginCallback {
  return function billingPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/v1/billing/invoice", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const since = strParam(req, "since");
      const until = strParam(req, "until");
      const records = await deps.listBillingRecords(orgId, since, until);
      return generateInvoice(orgId, plan, records, since ?? "(all time)", until ?? "(now)");
    });

    app.get("/v1/billing/audit.csv", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const records = await deps.listBillingRecords(orgId, strParam(req, "since"), strParam(req, "until"));
      void reply.header("content-type", "text/csv; charset=utf-8");
      void reply.header("content-disposition", `attachment; filename="audit-${orgId.slice(0, 8)}.csv"`);
      return reply.send(toAuditCsv(records));
    });

    done();
  };
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
      let q = client
        .from("billing_records")
        .select("session_id, original_tokens, quarantined_tokens, cost_delta_usd, cq_fee_usd, signed_hash")
        .eq("org_id", orgId);
      if (since !== undefined) q = q.gte("created_at", since);
      if (until !== undefined) q = q.lte("created_at", until);
      const { data, error } = await q;
      if (error) throw new Error(`listBillingRecords failed: ${error.message}`);
      return (data ?? []) as BillableRecord[];
    },
  };
}
