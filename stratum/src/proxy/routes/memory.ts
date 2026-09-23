/**
 * Memory API endpoints (Phase 3) — read/suppress structured facts + list drift conflicts.
 *
 *   GET    /v1/memory/facts[?org-id&limit]          → the org's recent Tier-2 facts.
 *   DELETE /v1/memory/facts/:id?table=<fact_table>  → suppress a fact (is_suppressed = true).
 *   GET    /v1/memory/conflicts[?org-id&limit]      → the org's unacknowledged Historical-Drift conflicts.
 *   GET    /v1/memory/audit-statuses[?org-id&limit] → the org's latest persisted audit outcomes.
 *   GET    /v1/memory/graph[?org-id&limit]          → bounded org-scoped entities and edges.
 *   GET    /v1/memory/graph/search?q=...             → bounded fuzzy matches and neighbors.
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

export interface AuditStatusSummary {
  fact_table: string;
  fact_id: string;
  status: "CONFIRMED" | "UNVERIFIED" | "CONFLICT";
  audited_at: string;
  evidence_commit: string | null;
  detail: string | null;
}

export interface GraphSnapshot {
  entities: { id: string; kind: string; name: string; session_id: string | null; file_path: string | null; summary: string | null }[];
  edges: { id: string; edge_type: string; from_entity: string; to_entity: string }[];
}

export interface GraphSearchResult extends GraphSnapshot {
  matches: string[];
}

export interface MemoryDeps {
  listFacts: (orgId: string, limit: number) => Promise<AnyFact[]>;
  /** Suppress fact `id` in `table` for `orgId`; returns whether a row was affected. */
  suppressFact: (orgId: string, id: string, table: string) => Promise<boolean>;
  listConflicts: (orgId: string, limit: number) => Promise<ConflictSummary[]>;
  listAuditStatuses: (orgId: string, limit: number) => Promise<AuditStatusSummary[]>;
  listGraph: (orgId: string, limit: number) => Promise<GraphSnapshot>;
  searchGraph: (orgId: string, query: string) => Promise<GraphSearchResult>;
}

const VALID_FACT_TABLES = new Set(Object.values(FACT_TABLES));

function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  // Auth ENFORCED (commercial): the org comes from the key, never a client-supplied ?org-id (cross-tenant
  // guard if the gate is ever bypassed). Personal mode (authEnforced unset) keeps the ?org-id convenience.
  if (req.authEnforced === true) return undefined;
  const v = (req.query as Record<string, unknown>)["org-id"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function intParam(req: FastifyRequest, name: string, def: number): number {
  const v = (req.query as Record<string, unknown>)[name];
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : def; // cap (mirrors billing) — no unbounded ?limit
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

    app.get("/v1/memory/audit-statuses", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { statuses: await deps.listAuditStatuses(orgId, intParam(req, "limit", 50)) };
    });

    app.get("/v1/memory/graph", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return deps.listGraph(orgId, intParam(req, "limit", 100));
    });

    app.get("/v1/memory/graph/search", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const raw = (req.query as Record<string, unknown>)["q"];
      const query = typeof raw === "string" ? raw.trim() : "";
      if (query.length < 2 || query.length > 100) return err(reply, 400, "q must be 2 to 100 characters");
      return deps.searchGraph(orgId, query);
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
    async listAuditStatuses(orgId, limit) {
      const { data, error } = await client
        .from("audit_statuses")
        .select("fact_table, fact_id, status, audited_at, evidence_commit, detail")
        .eq("org_id", orgId)
        .order("audited_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listAuditStatuses failed: ${error.message}`);
      return (data ?? []) as AuditStatusSummary[];
    },
    async listGraph(orgId, limit) {
      const entitiesResult = await client.from("knowledge_entities").select("id,kind,name,session_id,file_path,summary").eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit);
      if (entitiesResult.error) throw new Error(`listGraph entities failed: ${entitiesResult.error.message}`);
      const entities = (entitiesResult.data ?? []) as GraphSnapshot["entities"];
      if (entities.length === 0) return { entities, edges: [] };
      const ids = entities.map((entity) => entity.id);
      const edgesResult = await client.rpc("list_graph_snapshot_edges", { match_org: orgId, entity_ids: ids, edge_limit: 500 });
      if (edgesResult.error) throw new Error(`listGraph edges failed: ${edgesResult.error.message}`);
      return { entities, edges: (edgesResult.data ?? []) as GraphSnapshot["edges"] };
    },
    async searchGraph(orgId, query) {
      const found = await client.rpc("search_graph_entities", { match_org: orgId, search_text: query, result_limit: 20 });
      if (found.error) throw new Error(`searchGraph matches failed: ${found.error.message}`);
      const matches = (found.data ?? []) as GraphSnapshot["entities"];
      if (!matches.length) return { matches: [], entities: [], edges: [] };
      const ids = matches.map((entity) => entity.id);
      const [outgoing, incoming] = await Promise.all([
        client.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", orgId).in("from_entity", ids).limit(100),
        client.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", orgId).in("to_entity", ids).limit(100),
      ]);
      if (outgoing.error || incoming.error) throw new Error(`searchGraph edges failed: ${outgoing.error?.message ?? incoming.error?.message}`);
      const edges = [...new Map([...(outgoing.data ?? []), ...(incoming.data ?? [])].map((edge) => [edge.id, edge] as const)).values()] as GraphSnapshot["edges"];
      const neighbors = [...new Set(edges.flatMap((edge) => [edge.from_entity, edge.to_entity]))].filter((id) => !ids.includes(id));
      const related = neighbors.length ? await client.rpc("list_graph_neighbor_entities", { match_org: orgId, entity_ids: neighbors }) : null;
      if (related?.error) throw new Error(`searchGraph neighbors failed: ${related.error.message}`);
      const entities = [...matches, ...((related?.data ?? []) as GraphSnapshot["entities"])];
      const known = new Set(entities.map((entity) => entity.id));
      return { matches: ids, entities, edges: edges.filter((edge) => known.has(edge.from_entity) && known.has(edge.to_entity)) };
    },
  };
}
