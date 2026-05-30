/**
 * Session API (Phase 1) — list an org's sessions + per-session token stats.
 *
 *   GET /v1/sessions[?org-id&limit]   → the org's sessions (newest first).
 *   GET /v1/sessions/:id[?org-id]     → one session's metadata (org-scoped; 404 otherwise).
 *   GET /v1/sessions/:id/stats[?org-id] → that session's token totals + savings (from billing_records).
 *
 * Org scope comes from req.orgId (the auth gate) with a ?org-id fallback. The store is INJECTED
 * (SessionsDeps) so the route is testable via app.inject() with no DB; createSupabaseSessionsDeps
 * wires the sessions table + billing_records. A session is only ever returned to its OWNING org.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { planLimits } from "../rate-limit-tiers";

export interface SessionSummary {
  id: string;
  created_at: string;
  ended_at: string | null;
  model: string;
  lambda: number;
  gain_shift: number;
  theta: number;
  zk_enabled: boolean;
  audit_enabled: boolean;
}

export interface SessionStats {
  sessionId: string;
  billingRecords: number;
  originalTokens: number;
  quarantinedTokens: number;
  savingsUsd: number;
  feeUsd: number;
}

export interface SessionsDeps {
  listSessions: (orgId: string, limit: number) => Promise<SessionSummary[]>;
  getSession: (orgId: string, id: string) => Promise<SessionSummary | null>;
  /** Token stats for a session, or null if the session is not in this org. */
  getSessionStats: (orgId: string, id: string) => Promise<SessionStats | null>;
  /** End a session (set ended_at); returns the updated session, or null if not in this org. */
  endSession: (orgId: string, id: string) => Promise<SessionSummary | null>;
  /** The org's plan (drives the concurrent-session cap), or null if the org is unknown. */
  getPlan: (orgId: string) => Promise<string | null>;
  /** Count the org's currently-active (not-yet-ended) sessions. */
  countActiveSessions: (orgId: string) => Promise<number>;
  /** Create a new session for the org; returns it. */
  createSession: (orgId: string, model: string) => Promise<SessionSummary>;
}

function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  const v = (req.query as Record<string, unknown>)["org-id"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function intParam(req: FastifyRequest, name: string, def: number): number {
  const v = (req.query as Record<string, unknown>)[name];
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

function err(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type: "request_error", message } });
}

/**
 * Build the sessions API plugin.
 *
 * @param deps - the session store (a fake in tests, Supabase in prod).
 * @returns a plugin registering the session routes.
 */
export function makeSessionsRoute(deps: SessionsDeps): FastifyPluginCallback {
  return function sessionsPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/v1/sessions", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { sessions: await deps.listSessions(orgId, intParam(req, "limit", 50)) };
    });

    app.get("/v1/sessions/:id", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const session = await deps.getSession(orgId, (req.params as { id: string }).id);
      if (session === null) return err(reply, 404, "session not found for this org");
      return session;
    });

    // POST /v1/sessions — start a session, enforcing the plan's concurrent-session cap
    // (docs/RATE_LIMITS.md). 429 when the org is already at its limit.
    app.post("/v1/sessions", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const plan = await deps.getPlan(orgId);
      if (plan === null) return err(reply, 404, "organization not found");
      const limit = planLimits(plan).concurrentSessions;
      const active = await deps.countActiveSessions(orgId);
      if (active >= limit) {
        return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: `concurrent session limit (${limit}) reached for plan '${plan}'`, limit_type: "concurrent_sessions" } });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const model = typeof body["model"] === "string" && body["model"] !== "" ? body["model"] : "claude-opus-4-8";
      const session = await deps.createSession(orgId, model);
      return reply.code(201).send(session);
    });

    app.get("/v1/sessions/:id/stats", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const stats = await deps.getSessionStats(orgId, (req.params as { id: string }).id);
      if (stats === null) return err(reply, 404, "session not found for this org");
      return stats;
    });

    // DELETE /v1/sessions/:id — end a session (set ended_at); the session.ended trigger (WEBHOOKS.md).
    app.delete("/v1/sessions/:id", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const session = await deps.endSession(orgId, (req.params as { id: string }).id);
      if (session === null) return err(reply, 404, "session not found for this org");
      return { ended: true, session };
    });

    done();
  };
}

const SESSION_COLS = "id, created_at, ended_at, model, lambda, gain_shift, theta, zk_enabled, audit_enabled";

/** Live session store over Supabase (sessions table + billing_records). */
export function createSupabaseSessionsDeps(client: SupabaseClient): SessionsDeps {
  const getSession = async (orgId: string, id: string): Promise<SessionSummary | null> => {
    const { data, error } = await client.from("sessions").select(SESSION_COLS).eq("id", id).eq("org_id", orgId).limit(1);
    if (error) throw new Error(`getSession failed: ${error.message}`);
    return ((data ?? [])[0] as SessionSummary | undefined) ?? null;
  };
  return {
    async listSessions(orgId, limit) {
      const { data, error } = await client.from("sessions").select(SESSION_COLS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`listSessions failed: ${error.message}`);
      return (data ?? []) as SessionSummary[];
    },
    getSession,
    async getPlan(orgId) {
      const { data, error } = await client.from("organizations").select("plan").eq("id", orgId).limit(1);
      if (error) throw new Error(`getPlan failed: ${error.message}`);
      const row = (data ?? [])[0] as { plan: string } | undefined;
      return row ? row.plan : null;
    },
    async countActiveSessions(orgId) {
      const { count, error } = await client.from("sessions").select("id", { count: "exact", head: true }).eq("org_id", orgId).is("ended_at", null);
      if (error) throw new Error(`countActiveSessions failed: ${error.message}`);
      return count ?? 0;
    },
    async createSession(orgId, model) {
      const { data, error } = await client.from("sessions").insert({ org_id: orgId, model }).select(SESSION_COLS).limit(1);
      if (error) throw new Error(`createSession failed: ${error.message}`);
      const row = (data ?? [])[0] as SessionSummary | undefined;
      if (!row) throw new Error("createSession returned no row");
      return row;
    },
    async endSession(orgId, id) {
      // Scope-check first so a cross-org id is a clean 404, not a silent no-op update.
      if ((await getSession(orgId, id)) === null) return null;
      const { data, error } = await client
        .from("sessions")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", id)
        .eq("org_id", orgId)
        .select(SESSION_COLS)
        .limit(1);
      if (error) throw new Error(`endSession failed: ${error.message}`);
      return ((data ?? [])[0] as SessionSummary | undefined) ?? null;
    },
    async getSessionStats(orgId, id) {
      // Scope check first: only an org's own session yields stats (no cross-tenant peeking).
      if ((await getSession(orgId, id)) === null) return null;
      const { data, error } = await client.from("billing_records").select("original_tokens, quarantined_tokens, cost_delta_usd, cq_fee_usd").eq("org_id", orgId).eq("session_id", id);
      if (error) throw new Error(`getSessionStats failed: ${error.message}`);
      const rows = (data ?? []) as { original_tokens: number; quarantined_tokens: number; cost_delta_usd: number; cq_fee_usd: number }[];
      const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
      return {
        sessionId: id,
        billingRecords: rows.length,
        originalTokens: rows.reduce((s, r) => s + r.original_tokens, 0),
        quarantinedTokens: rows.reduce((s, r) => s + r.quarantined_tokens, 0),
        savingsUsd: round2(rows.reduce((s, r) => s + r.cost_delta_usd, 0)),
        feeUsd: round2(Math.max(0, rows.reduce((s, r) => s + r.cq_fee_usd, 0))),
      };
    },
  };
}
