/**
 * Memory API endpoints (Phase 3) — read/suppress structured facts + list drift conflicts.
 *
 *   GET    /v1/memory/facts[?org-id&limit]          → the org's recent Tier-2 facts.
 *   DELETE /v1/memory/facts/:id?table=<fact_table>  → suppress a fact (is_suppressed = true).
 *   GET    /v1/memory/conflicts[?org-id&limit]      → the org's unacknowledged Historical-Drift conflicts.
 *   GET    /v1/memory/audit-statuses[?org-id&limit] → the org's latest persisted audit outcomes.
 *   GET    /v1/memory/graph[?org-id&limit]          → bounded org-scoped entities and edges.
 *   GET    /v1/memory/graph/search?q=...             → bounded fuzzy matches and neighbors.
 *   GET    /v1/memory/graph/files|dependencies       → scoped source-graph pages.
 *
 * Org scope comes from req.orgId (the auth gate) with a ?org-id fallback. The store is INJECTED
 * (MemoryDeps) so the route is testable via app.inject() with no DB; createSupabaseMemoryDeps wires
 * the Tier-2 warm adapter + audit_conflicts. Suppress is the spec's fact-suppression; the fact
 * `table` is validated against the known fact tables (a clean 400, not a DB error).
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { posix } from "node:path";
import type { AnyFact } from "../../types/facts";
import { createWarmMemory, FACT_TABLES } from "../../memory/warm/tier2";
import { graphEncoder } from "../../memory/graph-embedding";

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

export interface GraphFilePage {
  files: GraphSnapshot["entities"];
  next: string | null;
}

export interface GraphDependencyPage {
  edges: GraphSnapshot["edges"];
  next: string | null;
}

export interface GraphRelatedFact {
  id: string;
  kind: "FunctionChange" | "TechDecision";
  summary: string;
  created_at: string;
}

export interface MemoryDeps {
  listFacts: (orgId: string, limit: number, projectScope?: string | null) => Promise<AnyFact[]>;
  /** Suppress fact `id` in `table` for `orgId`; returns whether a row was affected. */
  suppressFact: (orgId: string, id: string, table: string, projectScope?: string | null) => Promise<boolean>;
  listConflicts: (orgId: string, limit: number, projectScope?: string | null) => Promise<ConflictSummary[]>;
  listAuditStatuses: (orgId: string, limit: number, projectScope?: string | null) => Promise<AuditStatusSummary[]>;
  listGraph: (orgId: string, limit: number, projectScope?: string | null) => Promise<GraphSnapshot>;
  searchGraph: (orgId: string, query: string, mode: "name" | "semantic", projectScope?: string | null) => Promise<GraphSearchResult>;
  listGraphFiles: (orgId: string, limit: number, after?: string, projectScope?: string | null) => Promise<GraphFilePage>;
  listGraphDependencies: (orgId: string, limit: number, after?: string, projectScope?: string | null) => Promise<GraphDependencyPage>;
  listRelatedFacts: (orgId: string, file: string, projectScope?: string | null) => Promise<GraphRelatedFact[] | null>;
}

const VALID_FACT_TABLES = new Set(Object.values(FACT_TABLES));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  // Auth ENFORCED (commercial): the org comes from the key, never a client-supplied ?org-id (cross-tenant
  // guard if the gate is ever bypassed). Personal mode (authEnforced unset) keeps the ?org-id convenience.
  if (req.authEnforced === true) return undefined;
  const v = (req.query as Record<string, unknown>)["org-id"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function authenticatedProjectScope(req: FastifyRequest): string | null | undefined {
  if (req.authEnforced !== true) return undefined;
  if (req.projectScopeId === undefined) return null;
  if (!req.orgId || !req.projectScopeId.startsWith(`${req.orgId}/`)) throw new Error("invalid authenticated project scope");
  return req.projectScopeId.slice(req.orgId.length + 1);
}

function intParam(req: FastifyRequest, name: string, def: number): number {
  const v = (req.query as Record<string, unknown>)[name];
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : def; // cap (mirrors billing) — no unbounded ?limit
}

function pageParams(req: FastifyRequest, cursorKind: "name" | "uuid"): { limit: number; after?: string } | null {
  const query = req.query as Record<string, unknown>;
  const rawLimit = query["limit"];
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9][0-9]*$/.test(rawLimit))) return null;
  const limit = rawLimit === undefined ? 500 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 500) return null;
  const after = query["after"];
  if (after === undefined) return { limit };
  if (typeof after !== "string" || !after || (cursorKind === "uuid" ? !UUID.test(after) : after.length > 1024)) return null;
  return { limit, after };
}

function validSourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !posix.isAbsolute(value) &&
    value === posix.normalize(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
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
      return { facts: await deps.listFacts(orgId, intParam(req, "limit", 50), authenticatedProjectScope(req)) };
    });

    app.delete("/v1/memory/facts/:id", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const id = (req.params as { id: string }).id;
      const table = (req.query as Record<string, unknown>)["table"];
      if (typeof table !== "string" || !VALID_FACT_TABLES.has(table)) {
        return err(reply, 400, `?table is required and must be one of: ${[...VALID_FACT_TABLES].join(", ")}`);
      }
      const suppressed = await deps.suppressFact(orgId, id, table, authenticatedProjectScope(req));
      if (!suppressed) return err(reply, 404, "fact not found (or already gone) in that table for this org");
      return { id, table, suppressed: true };
    });

    app.get("/v1/memory/conflicts", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { conflicts: await deps.listConflicts(orgId, intParam(req, "limit", 50), authenticatedProjectScope(req)) };
    });

    app.get("/v1/memory/audit-statuses", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return { statuses: await deps.listAuditStatuses(orgId, intParam(req, "limit", 50), authenticatedProjectScope(req)) };
    });

    app.get("/v1/memory/graph", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      return deps.listGraph(orgId, intParam(req, "limit", 100), authenticatedProjectScope(req));
    });

    app.get("/v1/memory/graph/search", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const raw = (req.query as Record<string, unknown>)["q"];
      const query = typeof raw === "string" ? raw.trim() : "";
      if (query.length < 2 || query.length > 100) return err(reply, 400, "q must be 2 to 100 characters");
      const mode = (req.query as Record<string, unknown>)["mode"] ?? "name";
      if (mode !== "name" && mode !== "semantic") return err(reply, 400, "mode must be name or semantic");
      return deps.searchGraph(orgId, query, mode, authenticatedProjectScope(req));
    });

    app.get("/v1/memory/graph/files", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const page = pageParams(req, "name");
      if (!page) return err(reply, 400, "invalid graph page limit or after cursor");
      return deps.listGraphFiles(orgId, page.limit, page.after, authenticatedProjectScope(req));
    });

    app.get("/v1/memory/graph/dependencies", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const page = pageParams(req, "uuid");
      if (!page) return err(reply, 400, "invalid graph page limit or after cursor");
      return deps.listGraphDependencies(orgId, page.limit, page.after, authenticatedProjectScope(req));
    });

    app.get("/v1/memory/graph/related-facts", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const file = (req.query as Record<string, unknown>)["file"];
      if (!validSourcePath(file)) return err(reply, 400, "file must be a project-relative source path");
      const facts = await deps.listRelatedFacts(orgId, file, authenticatedProjectScope(req));
      if (facts === null) return err(reply, 404, "indexed File not found in this organization");
      return { facts };
    });

    done();
  };
}

/** Live memory store over Supabase (Tier-2 warm adapter + audit_conflicts). */
export function createSupabaseMemoryDeps(client: SupabaseClient, encodeQuery?: (query: string) => Promise<number[]>): MemoryDeps {
  const warm = createWarmMemory(client);
  const encode =
    encodeQuery ??
    (async (query: string): Promise<number[]> => {
      const [embedding] = await (await graphEncoder()).encode([query]);
      if (!embedding) throw new Error("graph query encoding returned no vector");
      return Array.from(embedding);
    });
  const expandMatches = async (orgId: string, matches: GraphSnapshot["entities"], projectScope?: string | null): Promise<GraphSearchResult> => {
    if (!matches.length) return { matches: [], entities: [], edges: [] };
    const ids = matches.map((entity) => entity.id);
    let outgoingQuery = client.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", orgId).in("from_entity", ids);
    let incomingQuery = client.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", orgId).in("to_entity", ids);
    if (projectScope !== undefined) {
      outgoingQuery = outgoingQuery.eq("scope_verified", true);
      incomingQuery = incomingQuery.eq("scope_verified", true);
      if (projectScope === null) {
        outgoingQuery = outgoingQuery.is("project_scope", null);
        incomingQuery = incomingQuery.is("project_scope", null);
      } else {
        outgoingQuery = outgoingQuery.eq("project_scope", projectScope);
        incomingQuery = incomingQuery.eq("project_scope", projectScope);
      }
    }
    const [outgoing, incoming] = await Promise.all([outgoingQuery.limit(100), incomingQuery.limit(100)]);
    if (outgoing.error || incoming.error) throw new Error(`searchGraph edges failed: ${outgoing.error?.message ?? incoming.error?.message}`);
    const edges = [...new Map([...(outgoing.data ?? []), ...(incoming.data ?? [])].map((edge) => [edge.id, edge] as const)).values()] as GraphSnapshot["edges"];
    const neighbors = [...new Set(edges.flatMap((edge) => [edge.from_entity, edge.to_entity]))].filter((id) => !ids.includes(id));
    const related = neighbors.length
      ? projectScope === undefined
        ? await client.rpc("list_graph_neighbor_entities", { match_org: orgId, entity_ids: neighbors })
        : await client.rpc("list_project_graph_neighbor_entities", { match_org: orgId, match_project_scope: projectScope, entity_ids: neighbors })
      : null;
    if (related?.error) throw new Error(`searchGraph neighbors failed: ${related.error.message}`);
    const entities = [...matches, ...((related?.data ?? []) as GraphSnapshot["entities"])];
    const known = new Set(entities.map((entity) => entity.id));
    return { matches: ids, entities, edges: edges.filter((edge) => known.has(edge.from_entity) && known.has(edge.to_entity)) };
  };
  return {
    listFacts: (orgId, limit, projectScope) => warm.queryRecent(orgId, { limit, ...(projectScope !== undefined ? { projectScope } : {}) }),
    async suppressFact(orgId, id, table, projectScope) {
      if (!VALID_FACT_TABLES.has(table)) throw new Error(`unknown fact table: ${table}`);
      let request = client.from(table).update({ is_suppressed: true }).eq("id", id).eq("org_id", orgId);
      if (projectScope === null) request = request.is("project_scope", null);
      else if (projectScope !== undefined) request = request.eq("project_scope", projectScope);
      const { data, error } = await request.select("id");
      if (error) throw new Error(`suppressFact failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async listConflicts(orgId, limit, projectScope) {
      if (projectScope !== undefined) {
        const { data, error } = await client.rpc("list_project_audit_conflicts", { match_org: orgId, match_project_scope: projectScope, result_limit: limit });
        if (error) throw new Error(`listConflicts failed: ${error.message}`);
        return (data ?? []) as ConflictSummary[];
      }
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
    async listAuditStatuses(orgId, limit, projectScope) {
      if (projectScope !== undefined) {
        const { data, error } = await client.rpc("list_project_audit_statuses", { match_org: orgId, match_project_scope: projectScope, result_limit: limit });
        if (error) throw new Error(`listAuditStatuses failed: ${error.message}`);
        return (data ?? []) as AuditStatusSummary[];
      }
      const { data, error } = await client
        .from("audit_statuses")
        .select("fact_table, fact_id, status, audited_at, evidence_commit, detail")
        .eq("org_id", orgId)
        .order("audited_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listAuditStatuses failed: ${error.message}`);
      return (data ?? []) as AuditStatusSummary[];
    },
    async listGraph(orgId, limit, projectScope) {
      let query = client.from("knowledge_entities").select("id,kind,name,session_id,file_path,summary").eq("org_id", orgId);
      if (projectScope !== undefined) {
        query = query.eq("scope_verified", true);
        query = projectScope === null ? query.is("project_scope", null) : query.eq("project_scope", projectScope);
      }
      const entitiesResult = await query.order("created_at", { ascending: false }).limit(limit);
      if (entitiesResult.error) throw new Error(`listGraph entities failed: ${entitiesResult.error.message}`);
      const entities = (entitiesResult.data ?? []) as GraphSnapshot["entities"];
      if (entities.length === 0) return { entities, edges: [] };
      const ids = entities.map((entity) => entity.id);
      const edgesResult =
        projectScope === undefined
          ? await client.rpc("list_graph_snapshot_edges", { match_org: orgId, entity_ids: ids, edge_limit: 500 })
          : await client.rpc("list_project_graph_snapshot_edges", { match_org: orgId, match_project_scope: projectScope, entity_ids: ids, edge_limit: 500 });
      if (edgesResult.error) throw new Error(`listGraph edges failed: ${edgesResult.error.message}`);
      return { entities, edges: (edgesResult.data ?? []) as GraphSnapshot["edges"] };
    },
    async searchGraph(orgId, query, mode, projectScope) {
      const embedding = mode === "semantic" ? await encode(query) : undefined;
      const found =
        mode === "semantic"
          ? projectScope === undefined
            ? await client.rpc("search_graph_semantic_entities", { match_org: orgId, query_embedding: embedding, result_limit: 20 })
            : await client.rpc("search_project_graph_semantic_entities", { match_org: orgId, match_project_scope: projectScope, query_embedding: embedding, result_limit: 20 })
          : projectScope === undefined
            ? await client.rpc("search_graph_entities", { match_org: orgId, search_text: query, result_limit: 20 })
            : await client.rpc("search_project_graph_entities", { match_org: orgId, match_project_scope: projectScope, search_text: query, result_limit: 20 });
      if (found.error) throw new Error(`searchGraph matches failed: ${found.error.message}`);
      const matches = (found.data ?? []) as GraphSnapshot["entities"];
      return expandMatches(orgId, matches, projectScope);
    },
    async listGraphFiles(orgId, limit, after, projectScope) {
      let request = client.from("knowledge_entities").select("id,kind,name,session_id,file_path,summary").eq("org_id", orgId).eq("kind", "File");
      if (projectScope !== undefined) {
        request = request.eq("scope_verified", true);
        request = projectScope === null ? request.is("project_scope", null) : request.eq("project_scope", projectScope);
      }
      request = request.order("name").limit(limit + 1);
      if (after !== undefined) request = request.gt("name", after);
      const result = await request;
      if (result.error) throw new Error(`listGraphFiles failed: ${result.error.message}`);
      const files = ((result.data ?? []) as GraphSnapshot["entities"]).slice(0, limit);
      return { files, next: (result.data ?? []).length > limit ? files.at(-1)!.name : null };
    },
    async listGraphDependencies(orgId, limit, after, projectScope) {
      let request = client.from("knowledge_edges").select("id,edge_type,from_entity,to_entity").eq("org_id", orgId).eq("edge_type", "DEPENDS_ON");
      if (projectScope !== undefined) {
        request = request.eq("scope_verified", true);
        request = projectScope === null ? request.is("project_scope", null) : request.eq("project_scope", projectScope);
      }
      request = request.order("id").limit(limit + 1);
      if (after !== undefined) request = request.gt("id", after);
      const result = await request;
      if (result.error) throw new Error(`listGraphDependencies failed: ${result.error.message}`);
      const edges = ((result.data ?? []) as GraphSnapshot["edges"]).slice(0, limit);
      return { edges, next: (result.data ?? []).length > limit ? edges.at(-1)!.id : null };
    },
    async listRelatedFacts(orgId, file, projectScope) {
      let query = client.from("knowledge_entities").select("id").eq("org_id", orgId).eq("kind", "File").eq("name", file).eq("file_path", file);
      if (projectScope !== undefined) {
        query = query.eq("scope_verified", true);
        query = projectScope === null ? query.is("project_scope", null) : query.eq("project_scope", projectScope);
      }
      const indexed = await query.limit(1);
      if (indexed.error) throw new Error(`listRelatedFacts File check failed: ${indexed.error.message}`);
      if (!indexed.data?.length) return null;
      const result =
        projectScope === undefined
          ? await client.rpc("list_source_related_facts", { match_org: orgId, match_file: indexed.data[0]!.id, result_limit: 50 })
          : await client.rpc("list_project_source_related_facts", { match_org: orgId, match_project_scope: projectScope, match_file: indexed.data[0]!.id, result_limit: 50 });
      if (result.error) throw new Error(`listRelatedFacts query failed: ${result.error.message}`);
      return (result.data ?? []) as GraphRelatedFact[];
    },
  };
}
