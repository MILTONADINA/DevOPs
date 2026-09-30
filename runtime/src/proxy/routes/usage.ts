/**
 * Usage read API — an organization's usage summary and usage records, under /v1/billing/. The API reports token counts, pruning effectiveness and an estimated USD cost difference,
 * and nothing else about money (specs/ops/payment-removal.md REQ-3, REQ-6). It imports nothing under src/billing/.
 *
 *   GET /v1/billing/summary[?org-id&month | since&until]  → token totals, effectiveness and the per-developer breakdown for a month or window.
 *   GET /v1/billing/records[?org-id&since&until&session_id&limit&offset] → the paginated usage records.
 *
 * When the auth gate is on, both need an organization-level key (a project-bound key gets 403). Org scope comes from req.orgId (set by the auth gate) and falls back to ?org-id
 * when the proxy runs unauthenticated (./org-scope). The record source is INJECTED (UsageDeps) so the routes are testable via app.inject() with no DB; createSupabaseUsageDeps wires
 * the live source. The summary's totals come from the pure summarizeUsage (src/usage/summary.ts). FREE (read-only); no Anthropic.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOrg } from "./org-scope";
import { summarizeUsage, type UsageRecord } from "../../usage/summary";

/** A usage record as GET /v1/billing/records returns it: token counts and the estimated USD cost difference. */
export interface UsageRecordFull {
  id: string;
  created_at: string;
  session_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  token_delta: number;
  /** Estimated USD cost difference, for information only. */
  cost_delta_usd: number;
}

/** The filters and the page window of GET /v1/billing/records. */
export interface UsageRecordsQuery {
  since?: string | undefined;
  until?: string | undefined;
  sessionId?: string | undefined;
  limit: number;
  offset: number;
}

/** Per-developer token attribution (GET /v1/billing/summary, by_developer); a null developer is unattributed usage. */
export interface DeveloperUsage {
  developer_id: string | null;
  name: string | null;
  token_delta: number;
}

export interface UsageDeps {
  /** The org's usage records from `since` (inclusive) to `until` (exclusive), each bound optional: the summary's source. */
  listUsageRecords: (orgId: string, since?: string, until?: string) => Promise<UsageRecord[]>;
  /** One page of full usage records for the records endpoint, plus the total count for the page metadata. */
  listRecords: (orgId: string, q: UsageRecordsQuery) => Promise<{ records: UsageRecordFull[]; total: number }>;
  /** Per-developer token_delta for the summary (null developer = unattributed). */
  developerBreakdown: (orgId: string, since?: string, until?: string) => Promise<DeveloperUsage[]>;
  /** The org's plan, or null if the org is unknown. The summary reads it only to answer 404 for an unknown org. */
  getOrgPlan: (orgId: string) => Promise<string | null>;
}

/**
 * Convert a YYYY-MM month into [since, until) ISO bounds.
 *
 * @param month - the month, as YYYY-MM.
 * @returns the first instant of the month and of the next one, or null if `month` is malformed.
 */
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

/**
 * Build the usage read API plugin bound to a record source.
 *
 * @param deps - the usage record + plan source (a fake in tests, Supabase in prod).
 * @returns a plugin registering GET /v1/billing/summary and /v1/billing/records.
 */
export function makeUsageRoute(deps: UsageDeps): FastifyPluginCallback {
  return function usagePlugin(app: FastifyInstance, _opts, done): void {
    // GET /v1/billing/summary — the usage summary for `?month=YYYY-MM`, or for the given ?since / ?until (default: all time).
    app.get("/v1/billing/summary", async (req, reply) => {
      if (req.authEnforced === true && req.projectScopeId !== undefined) return err(reply, 403, "permission_error", "organization-level key required");
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
      const records = await deps.listUsageRecords(orgId, since, until);
      return {
        org_id: orgId,
        period,
        ...summarizeUsage(records),
        by_developer: await deps.developerBreakdown(orgId, since, until),
      };
    });

    // GET /v1/billing/records — the paginated usage records.
    app.get("/v1/billing/records", async (req, reply) => {
      if (req.authEnforced === true && req.projectScopeId !== undefined) return err(reply, 403, "permission_error", "organization-level key required");
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

    done();
  };
}

/** Copy the allowed fields of a ledger row into a usage record. Naming each field, rather than spreading the row, keeps any other column the source returns out of the response. */
function toUsageRecordFull(row: UsageRecordFull): UsageRecordFull {
  return {
    id: row.id,
    created_at: row.created_at,
    session_id: row.session_id,
    original_tokens: row.original_tokens,
    quarantined_tokens: row.quarantined_tokens,
    token_delta: row.token_delta,
    cost_delta_usd: row.cost_delta_usd,
  };
}

/**
 * Live usage source over Supabase (service-role). Every read selects token counts, and the estimated USD cost difference where it reports one, and nothing else from the ledger.
 *
 * @param client - the service-role Supabase client.
 * @returns the {@link UsageDeps} reading the organizations and billing_records tables.
 */
export function createSupabaseUsageDeps(client: SupabaseClient): UsageDeps {
  return {
    async getOrgPlan(orgId: string): Promise<string | null> {
      const { data, error } = await client.from("organizations").select("plan").eq("id", orgId).limit(1);
      if (error) throw new Error(`getOrgPlan failed: ${error.message}`);
      const row = (data ?? [])[0] as { plan: string } | undefined;
      return row ? row.plan : null;
    },
    async listUsageRecords(orgId: string, since?: string, until?: string): Promise<UsageRecord[]> {
      const rows: UsageRecord[] = [];
      let expected: number | undefined;
      do {
        let q = client.from("billing_records").select("session_id, original_tokens, quarantined_tokens, cost_delta_usd", { count: "exact" }).eq("org_id", orgId);
        if (since !== undefined) q = q.gte("created_at", since);
        if (until !== undefined) q = q.lt("created_at", until);
        const { data, error, count } = await q.order("id", { ascending: true }).range(rows.length, rows.length + 499);
        if (error) throw new Error(`listUsageRecords failed: ${error.message}`);
        if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error("listUsageRecords failed: exact count unavailable");
        if (expected !== undefined && count !== expected) throw new Error("listUsageRecords failed: row count changed during paging");
        expected = count;
        const page = (data ?? []) as UsageRecord[];
        if (page.length === 0 && rows.length < expected) throw new Error("listUsageRecords failed: empty page before exact row count");
        rows.push(...page);
        if (rows.length > expected) throw new Error("listUsageRecords failed: page exceeded exact row count");
      } while (rows.length < expected);
      return rows;
    },
    async developerBreakdown(orgId: string, since?: string, until?: string): Promise<DeveloperUsage[]> {
      type Row = {
        original_tokens: number;
        quarantined_tokens: number;
        sessions:
          | { developer_id: string | null; developers: { name: string } | { name: string }[] | null }
          | { developer_id: string | null; developers: { name: string } | { name: string }[] | null }[]
          | null;
      };
      const map = new Map<string | null, DeveloperUsage>();
      let records = 0;
      let expected: number | undefined;
      do {
        let q = client.from("billing_records").select("original_tokens, quarantined_tokens, sessions(developer_id, developers(name))", { count: "exact" }).eq("org_id", orgId);
        if (since !== undefined) q = q.gte("created_at", since);
        if (until !== undefined) q = q.lt("created_at", until);
        const { data, error, count } = await q.order("id", { ascending: true }).range(records, records + 499);
        if (error) throw new Error(`developerBreakdown failed: ${error.message}`);
        if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error("developerBreakdown failed: exact count unavailable");
        if (expected !== undefined && count !== expected) throw new Error("developerBreakdown failed: row count changed during paging");
        expected = count;
        const page = (data ?? []) as Row[];
        if (page.length === 0 && records < expected) throw new Error("developerBreakdown failed: empty page before exact row count");
        for (const row of page) {
          const session = Array.isArray(row.sessions) ? row.sessions[0] : row.sessions;
          const devId = session?.developer_id ?? null;
          const dev = Array.isArray(session?.developers) ? session?.developers[0] : session?.developers;
          const name = dev?.name ?? null;
          const e = map.get(devId) ?? { developer_id: devId, name, token_delta: 0 };
          e.token_delta += row.original_tokens - row.quarantined_tokens;
          map.set(devId, e);
        }
        records += page.length;
        if (records > expected) throw new Error("developerBreakdown failed: page exceeded exact row count");
      } while (records < expected);
      return [...map.values()];
    },
    async listRecords(orgId: string, query: UsageRecordsQuery): Promise<{ records: UsageRecordFull[]; total: number }> {
      let q = client.from("billing_records").select("id, created_at, session_id, original_tokens, quarantined_tokens, token_delta, cost_delta_usd", { count: "exact" }).eq("org_id", orgId);
      if (query.since !== undefined) q = q.gte("created_at", query.since);
      if (query.until !== undefined) q = q.lt("created_at", query.until);
      if (query.sessionId !== undefined) q = q.eq("session_id", query.sessionId);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(query.offset, query.offset + query.limit - 1);
      if (error) throw new Error(`listRecords failed: ${error.message}`);
      return { records: ((data ?? []) as UsageRecordFull[]).map(toUsageRecordFull), total: count ?? 0 };
    },
  };
}
