/**
 * Memory API endpoints (Phase 3) — read/suppress structured facts + list drift conflicts.
 *
 *   GET    /v1/memory/facts[?org-id&limit]          → the org's recent Tier-2 facts.
 *   DELETE /v1/memory/facts/:id?table=<fact_table>  → suppress a fact (is_suppressed = true).
 *   GET    /v1/memory/conflicts[?org-id&limit]      → the org's unacknowledged Historical-Drift conflicts.
 *
 * Org scope comes from req.orgId (the auth gate) with a ?org-id fallback. The store is INJECTED
 * (MemoryDeps) so the route is testable via app.inject() with no DB; createSupabaseMemoryDeps wires
 * the Tier-2 warm adapter + audit_conflicts. Suppress is the spec's fact-suppression; the fact
 * `table` is validated against the known fact tables (a clean 400, not a DB error).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyFact } from "../../types/facts";
import { createWarmMemory, FACT_TABLES } from "../../memory/warm/tier2";

export interface ConflictSummary {
  id: string;
  detected_at: string;
  fact_table: string;
  fact_id: string;
  claimed_state: string;
  actual_state: string;
  conflict_commit: string | null;
  acknowledged: boolean;
}

export interface MemoryDeps {
  listFacts: (orgId: string, limit: number) => Promise<AnyFact[]>;
  /** Suppress fact `id` in `table` for `orgId`; returns whether a row was affected. */
  suppressFact: (orgId: string, id: string, table: string) => Promise<boolean>;
  listConflicts: (orgId: string, limit: number) => Promise<ConflictSummary[]>;
}

const VALID_FACT_TABLES = new Set(Object.values(FACT_TABLES));

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
 * Build the memory API plugin.
 *
 * @param deps - the fact/conflict store (a fake in tests, Supabase in prod).
 * @returns a plugin registering the memory routes.
 */
export function makeMemoryRoute(deps: MemoryDeps): FastifyPluginCallback {
  return function memoryPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/v1/memory/facts", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { facts: await deps.listFacts(orgId, intParam(req, "limit", 50)) };
    });

    app.delete("/v1/memory/facts/:id", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const id = (req.params as { id: string }).id;
      const table = (req.query as Record<string, unknown>)["table"];
      if (typeof table !== "string" || !VALID_FACT_TABLES.has(table)) {
        return err(reply, 400, `?table is required and must be one of: ${[...VALID_FACT_TABLES].join(", ")}`);
      }
      const suppressed = await deps.suppressFact(orgId, id, table);
      if (!suppressed) return err(reply, 404, "fact not found (or already gone) in that table for this org");
      return { id, table, suppressed: true };
    });

    app.get("/v1/memory/conflicts", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { conflicts: await deps.listConflicts(orgId, intParam(req, "limit", 50)) };
    });

    done();
  };
}

/** Live memory store over Supabase (Tier-2 warm adapter + audit_conflicts). */
export function createSupabaseMemoryDeps(client: SupabaseClient): MemoryDeps {
  const warm = createWarmMemory(client);
  return {
    listFacts: (orgId, limit) => warm.queryRecent(orgId, { limit }),
    async suppressFact(orgId, id, table) {
      if (!VALID_FACT_TABLES.has(table)) throw new Error(`unknown fact table: ${table}`);
      const { data, error } = await client.from(table).update({ is_suppressed: true }).eq("id", id).eq("org_id", orgId).select("id");
      if (error) throw new Error(`suppressFact failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async listConflicts(orgId, limit) {
      const { data, error } = await client
        .from("audit_conflicts")
        .select("id, detected_at, fact_table, fact_id, claimed_state, actual_state, conflict_commit, acknowledged")
        .eq("org_id", orgId)
        .eq("acknowledged", false)
        .order("detected_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listConflicts failed: ${error.message}`);
      return (data ?? []) as ConflictSummary[];
    },
  };
}
