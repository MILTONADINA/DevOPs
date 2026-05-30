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

/** A full billing record row (the audit shape, docs/API_REFERENCE.md GET /v1/billing/records). */
export interface BillingRecordFull {
  id: string;
  created_at: string;
  session_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  token_delta: number;
  cost_delta_usd: number;
  cq_fee_usd: number;
  signed_hash: string;
}

export interface RecordsQuery {
  since?: string | undefined;
  until?: string | undefined;
  sessionId?: string | undefined;
  limit: number;
  offset: number;
}

/** Per-developer cost attribution (docs/API_REFERENCE.md GET /v1/billing/summary §by_developer). */
export interface DeveloperBreakdown {
  developer_id: string | null;
  name: string | null;
  token_delta: number;
  cq_fee_usd: number;
}

/** An invoice's lifecycle row (the `invoices` table — sent → paid/failed via the Stripe webhook). */
export interface InvoiceRow {
  id: string;
  created_at: string;
  stripe_invoice_id: string;
  amount_cents: number;
  currency: string;
  status: "sent" | "paid" | "failed";
  paid_at: string | null;
}

export interface InvoicesQuery {
  /** Filter by lifecycle status (validated against sent|paid|failed). */
  status?: string | undefined;
  limit: number;
  offset: number;
}

export interface BillingDeps {
  /** The org's billing records in [since, until] (ISO bounds optional) — the invoice/summary source. */
  listBillingRecords: (orgId: string, since?: string, until?: string) => Promise<BillableRecord[]>;
  /** Paginated full records for the audit endpoint, + the total count for the page metadata. */
  listRecords: (orgId: string, q: RecordsQuery) => Promise<{ records: BillingRecordFull[]; total: number }>;
  /** Per-developer token_delta + cq_fee for the summary (null developer = unattributed). */
  developerBreakdown: (orgId: string, since?: string, until?: string) => Promise<DeveloperBreakdown[]>;
  /** The org's plan (drives the monthly-minimum floor), or null if the org is unknown. */
  getOrgPlan: (orgId: string) => Promise<string | null>;
  /** The org's invoices (sent/paid/failed) + total count — surfaces the Stripe webhook's records. */
  listInvoices: (orgId: string, q: InvoicesQuery) => Promise<{ invoices: InvoiceRow[]; total: number }>;
}

function round2cents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Convert a YYYY-MM month into [since, until) ISO bounds, or null if malformed. */
export function monthBounds(month: string): { since: string; until: string } | null {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const since = `${m[1]}-${m[2]}-01T00:00:00.000Z`;
  const nextY = mo === 12 ? y + 1 : y;
  const nextMo = mo === 12 ? 1 : mo + 1;
  const until = `${String(nextY).padStart(4, "0")}-${pad(nextMo)}-01T00:00:00.000Z`;
  return { since, until };
}

/**
 * The org for this request: the authenticated org, else ?org-id (unauthenticated/personal proxy ONLY).
 * Exported for the cross-tenant security regression test. The same pattern is used by every commercial
 * route (sessions/memory/config/webhooks); when `req.authEnforced` is set (the auth gate is registered),
 * the ?org-id fallback is REFUSED so a client can never read another tenant by supplying a UUID.
 */
export function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  // Auth ENFORCED (commercial mode): the org MUST come from the authenticated key — never a client-supplied
  // ?org-id (which would be an unauthenticated cross-tenant read if the gate were ever bypassed). Personal/
  // unauthenticated mode (authEnforced unset) keeps the ?org-id convenience for the local dashboard.
  if (req.authEnforced === true) return undefined;
  const q = req.query as Record<string, unknown>;
  const fromQuery = q["org-id"];
  return typeof fromQuery === "string" && fromQuery !== "" ? fromQuery : undefined;
}

function strParam(req: FastifyRequest, name: string): string | undefined {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A query param that must parse as an ISO-8601 timestamp. Throws a 400 (the global error handler honors
 *  statusCode) so a garbage `?since=foo` is a clean 400 — not a Postgres "invalid input syntax" 500 with
 *  the raw DB error leaked. (created_at is timestamptz; passing junk to .gte/.lt errors at the DB.) */
function isoParam(req: FastifyRequest, name: string): string | undefined {
  const v = strParam(req, name);
  if (v === undefined) return undefined;
  if (Number.isNaN(Date.parse(v))) throw Object.assign(new Error(`${name} must be an ISO-8601 timestamp`), { statusCode: 400 });
  return v;
}

function intParam(req: FastifyRequest, name: string, def: number): number {
  const v = (req.query as Record<string, unknown>)[name];
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

function err(reply: FastifyReply, code: number, type: string, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type, message } });
}

// The customer-facing CFO dashboard (BUSINESS_MODEL.md §The CFO Dashboard). Vanilla HTML (no
// framework); reads ?org-id and renders /v1/billing/invoice + an audit-CSV download. All dynamic
// values go through textContent (never innerHTML) — XSS-safe by construction.
const BILLING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stratum — CFO Billing Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 900px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .note { color: #888; font-size: .85rem; margin-bottom: 1.25rem; }
  .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.5rem; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; min-width: 130px; }
  .card .v { font-size: 1.5rem; font-weight: 600; } .card .k { color: #888; font-size: .8rem; }
  .due .v { color: #30a46c; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; }
  th { color: #888; font-weight: 600; }
  .empty { color: #888; font-style: italic; }
  a.btn { display: inline-block; border: 1px solid #8884; border-radius: 6px; padding: .35rem .7rem; text-decoration: none; color: inherit; }
</style></head>
<body>
  <h1>Stratum — CFO Billing Dashboard</h1>
  <div class="note" id="note">Loading…</div>
  <div class="cards" id="cards"></div>
  <h2>Per-session line items</h2>
  <table id="items"><thead><tr><th>Session</th><th>Original tok</th><th>Quarantined tok</th><th>Savings</th><th>Fee</th></tr></thead><tbody></tbody></table>
  <p id="dl"></p>
  <script>
    const org = new URLSearchParams(location.search).get('org-id') || '';
    const usd = (n) => '$' + Number(n).toFixed(2);
    const fmt = (n) => Number(n).toLocaleString();
    // textContent-only DOM helpers — no innerHTML, so org-supplied values can never inject markup.
    const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; };
    const card = (k, v, cls) => { const c = el('div', null, cls ? 'card ' + cls : 'card'); c.appendChild(el('div', v, 'v')); c.appendChild(el('div', k, 'k')); return c; };
    const note = document.getElementById('note'), cards = document.getElementById('cards'), tb = document.querySelector('#items tbody'), dl = document.getElementById('dl');
    if (!org) { note.textContent = 'Add ?org-id=<uuid> to the URL.'; }
    else fetch('/v1/billing/invoice?org-id=' + encodeURIComponent(org)).then((r) => r.ok ? r.json() : r.json().then((e) => Promise.reject(e))).then((d) => {
      note.textContent = 'Org ' + d.orgId + ' (' + d.plan + ') · ' + d.periodStart + ' -> ' + d.periodEnd;
      [['Sessions', d.recordCount], ['Original tokens', fmt(d.totalOriginalTokens)], ['Effectiveness', d.effectivenessPct.toFixed(1) + '%'], ['Customer savings', usd(d.totalSavingsUsd)], ['CQ fee (20%)', usd(d.rawFeeUsd)], ['Min (' + d.plan + ')', usd(d.monthlyMinimumUsd)]].forEach(([k, v]) => cards.appendChild(card(k, v)));
      cards.appendChild(card('AMOUNT DUE', usd(d.amountDueUsd), 'due'));
      // Records exist but 0% reduction = pruning isn't active yet (ADR-0009/0014). Explain the $0
      // savings so the partner's first view is honest, not a confusing "0 saved, plan-minimum due".
      if (d.recordCount > 0 && d.effectivenessPct === 0) { const s = el('p', 'Pruning is not yet active — these are measured usage records at 0% reduction; savings (and a usage-based fee) begin once it is enabled. Until then you are billed the ' + d.plan + ' plan minimum.', 'note'); cards.insertAdjacentElement('afterend', s); }
      if (d.lineItems.length) d.lineItems.forEach((li) => { const tr = document.createElement('tr'); [li.sessionId.slice(0, 8), fmt(li.originalTokens), fmt(li.quarantinedTokens), usd(li.savingsUsd), usd(li.feeUsd)].forEach((v) => tr.appendChild(el('td', v))); tb.appendChild(tr); });
      else { const tr = document.createElement('tr'); const td = el('td', 'No billing records yet - pruning has not run in the request path.', 'empty'); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); }
      const a = el('a', 'Download audit trail (CSV)', 'btn'); a.setAttribute('href', '/v1/billing/audit.csv?org-id=' + encodeURIComponent(org)); dl.appendChild(a);
    }).catch((e) => { note.textContent = 'Could not load invoice: ' + (e && e.error ? e.error.message : e); });
  </script>
</body></html>`;

/**
 * Build the billing API plugin bound to a record source.
 *
 * @param deps - the billing record + plan source (a fake in tests, Supabase in prod).
 * @returns a plugin registering GET /v1/billing/invoice and /v1/billing/audit.csv.
 */
export function makeBillingRoute(deps: BillingDeps): FastifyPluginCallback {
  return function billingPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/billing", async (_req, reply) => {
      void reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(BILLING_HTML);
    });

    app.get("/v1/billing/invoice", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const since = isoParam(req, "since");
      const until = isoParam(req, "until");
      const records = await deps.listBillingRecords(orgId, since, until);
      return generateInvoice(orgId, plan, records, since ?? "(all time)", until ?? "(now)");
    });

    app.get("/v1/billing/audit.csv", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const since = isoParam(req, "since");
      const until = isoParam(req, "until");
      const records = await deps.listBillingRecords(orgId, since, until);
      // Pass the computed invoice so the CSV carries the reconciliation summary (the plan-minimum floor) —
      // without it a floored invoice's fee column would not sum to the amount charged (dispute-proof contract).
      const invoice = generateInvoice(orgId, plan, records, since ?? "(all time)", until ?? "(now)");
      void reply.header("content-type", "text/csv; charset=utf-8");
      void reply.header("content-disposition", `attachment; filename="audit-${orgId.slice(0, 8)}.csv"`);
      return reply.send(toAuditCsv(records, invoice));
    });

    // GET /v1/billing/summary — the monthly summary (docs/API_REFERENCE.md). `?month=YYYY-MM`
    // (default: all time / the given since-until). by_developer is deferred (needs the sessions join).
    app.get("/v1/billing/summary", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const month = strParam(req, "month");
      let since = isoParam(req, "since");
      let until = isoParam(req, "until");
      let period = since ?? "(all time)";
      if (month !== undefined) {
        const b = monthBounds(month);
        if (b === null) return err(reply, 400, "request_error", "month must be YYYY-MM");
        since = b.since;
        until = b.until;
        period = month;
      }
      const records = await deps.listBillingRecords(orgId, since, until);
      const inv = generateInvoice(orgId, plan, records, period, until ?? "(now)");
      return {
        org_id: orgId,
        period,
        total_original_tokens: inv.totalOriginalTokens,
        total_quarantined_tokens: inv.totalQuarantinedTokens,
        total_token_delta: inv.totalOriginalTokens - inv.totalQuarantinedTokens,
        total_cost_delta_usd: inv.totalSavingsUsd,
        total_cq_fee_usd: inv.rawFeeUsd,
        total_sessions: new Set(records.map((r) => r.session_id)).size,
        average_pruning_effectiveness_pct: inv.effectivenessPct,
        by_developer: await deps.developerBreakdown(orgId, since, until),
      };
    });

    // GET /v1/billing/records — paginated raw records for programmatic CFO audit.
    app.get("/v1/billing/records", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const limit = Math.min(500, Math.max(1, intParam(req, "limit", 50)));
      const offset = Math.max(0, intParam(req, "offset", 0));
      const { records, total } = await deps.listRecords(orgId, {
        since: isoParam(req, "since"),
        until: isoParam(req, "until"),
        sessionId: strParam(req, "session_id"),
        limit,
        offset,
      });
      return { records, total, offset, limit };
    });

    // GET /v1/billing/invoices — the invoice lifecycle (sent → paid/failed), surfacing what the
    // Stripe webhook records (so "did the design partner pay?" is answerable via the API, not just SQL).
    app.get("/v1/billing/invoices", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "request_error", "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getOrgPlan(orgId);
      if (plan === null) return err(reply, 404, "request_error", "organization not found");
      const status = strParam(req, "status");
      if (status !== undefined && !["sent", "paid", "failed"].includes(status)) {
        return err(reply, 400, "request_error", "status must be one of: sent, paid, failed");
      }
      const limit = Math.min(500, Math.max(1, intParam(req, "limit", 50)));
      const offset = Math.max(0, intParam(req, "offset", 0));
      const { invoices, total } = await deps.listInvoices(orgId, { status, limit, offset });
      return { invoices, total, offset, limit };
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
      if (until !== undefined) q = q.lt("created_at", until);
      const { data, error } = await q;
      if (error) throw new Error(`listBillingRecords failed: ${error.message}`);
      return (data ?? []) as BillableRecord[];
    },
    async developerBreakdown(orgId: string, since?: string, until?: string): Promise<DeveloperBreakdown[]> {
      let q = client.from("billing_records").select("original_tokens, quarantined_tokens, cq_fee_usd, sessions(developer_id, developers(name))").eq("org_id", orgId);
      if (since !== undefined) q = q.gte("created_at", since);
      if (until !== undefined) q = q.lt("created_at", until);
      const { data, error } = await q;
      if (error) throw new Error(`developerBreakdown failed: ${error.message}`);
      type Row = { original_tokens: number; quarantined_tokens: number; cq_fee_usd: number; sessions: { developer_id: string | null; developers: { name: string } | { name: string }[] | null } | { developer_id: string | null; developers: { name: string } | { name: string }[] | null }[] | null };
      const map = new Map<string | null, DeveloperBreakdown>();
      for (const row of (data ?? []) as Row[]) {
        const session = Array.isArray(row.sessions) ? row.sessions[0] : row.sessions;
        const devId = session?.developer_id ?? null;
        const dev = Array.isArray(session?.developers) ? session?.developers[0] : session?.developers;
        const name = dev?.name ?? null;
        const e = map.get(devId) ?? { developer_id: devId, name, token_delta: 0, cq_fee_usd: 0 };
        e.token_delta += row.original_tokens - row.quarantined_tokens;
        e.cq_fee_usd += row.cq_fee_usd;
        map.set(devId, e);
      }
      return [...map.values()].map((e) => ({ ...e, cq_fee_usd: round2cents(e.cq_fee_usd) }));
    },
    async listRecords(orgId: string, query: RecordsQuery): Promise<{ records: BillingRecordFull[]; total: number }> {
      let q = client
        .from("billing_records")
        .select("id, created_at, session_id, original_tokens, quarantined_tokens, token_delta, cost_delta_usd, cq_fee_usd, signed_hash", { count: "exact" })
        .eq("org_id", orgId);
      if (query.since !== undefined) q = q.gte("created_at", query.since);
      if (query.until !== undefined) q = q.lt("created_at", query.until);
      if (query.sessionId !== undefined) q = q.eq("session_id", query.sessionId);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(query.offset, query.offset + query.limit - 1);
      if (error) throw new Error(`listRecords failed: ${error.message}`);
      return { records: (data ?? []) as BillingRecordFull[], total: count ?? 0 };
    },
    async listInvoices(orgId: string, query: InvoicesQuery): Promise<{ invoices: InvoiceRow[]; total: number }> {
      let q = client
        .from("invoices")
        .select("id, created_at, stripe_invoice_id, amount_cents, currency, status, paid_at", { count: "exact" })
        .eq("org_id", orgId);
      if (query.status !== undefined) q = q.eq("status", query.status);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(query.offset, query.offset + query.limit - 1);
      if (error) throw new Error(`listInvoices failed: ${error.message}`);
      return { invoices: (data ?? []) as InvoiceRow[], total: count ?? 0 };
    },
  };
}
