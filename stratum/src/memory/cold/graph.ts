/**
 * Tier-3 cold memory — knowledge graph (Supabase relational implementation).
 *
 * Per ADR-0013, the blueprint's Tier-3 graph (Neo4j) is implemented on the live
 * Supabase project as relational `knowledge_entities` + `knowledge_edges` tables
 * (migration 20260529120000), because no Neo4j account is available. This module
 * is the {@link KnowledgeGraph} SEAM: a future Neo4j adapter implements the same
 * interface and drops in unchanged — the pruner + recall consume the interface,
 * not Postgres.
 *
 * The load-bearing query is {@link KnowledgeGraph.findSuperseded} — the ADR-0011
 * pruner fix: given the entities in the current context, which are SUPERSEDED (by
 * a newer entity) so the pruner can suppress the stale turn. It runs server-side
 * via the `find_superseded` SQL function (the join lives in SQL; verified live via
 * the Supabase MCP). `org_id` / `session_id` are trusted FKs supplied by the
 * caller, never derived from untrusted content (the ADR-0012 forgery model).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Knowledge-graph node kinds (CLAUDE.md node types + Project). */
export type EntityKind = "Function" | "Commit" | "Decision" | "Developer" | "Policy" | "Project";

/**
 * Edge types. NOTE: CLAUDE.md spells the supersession edge "SUPERCEDES"; this uses
 * the correct English "SUPERSEDES", consistent with `tech_decisions.supersedes_id`
 * + ADR-0011 (see ADR-0013).
 *
 * DIRECTION — read each edge as the English sentence "`from` EDGE `to`". The
 * subject (`from`) is named by the edge type; directions are NOT uniform across
 * edge types, so they are pinned here to avoid ambiguity:
 *   • SUPERSEDES   — "from supersedes to": from = SUPERSEDING (new), to = SUPERSEDED
 *                    (stale). `findSuperseded` returns the `to` side as `superseded`.
 *                    (see migration 20260529140000.)
 *   • DEPRECATED_BY — "from is deprecated by to": from = the DEPRECATED entity,
 *                    to = the DEPRECATOR. So an entity's deprecators are its
 *                    OUTGOING DEPRECATED_BY edges (what `understandEntity` reads).
 *   • REFERENCED_IN — "from is referenced in to": from = the referenced entity,
 *                    to = the referencing site. An entity's referrers are its
 *                    INCOMING REFERENCED_IN edges.
 *   • AUTHORED_BY   — "from is authored by to": from = artifact, to = developer.
 *   • APPLIES_TO    — "from applies to to": from = policy, to = target.
 */
export type EdgeType = "SUPERSEDES" | "DEPRECATED_BY" | "REFERENCED_IN" | "AUTHORED_BY" | "APPLIES_TO";

export interface EnsureEntityInput {
  orgId: string;
  kind: EntityKind;
  name: string;
  sessionId?: string;
}

export interface AddEdgeInput {
  orgId: string;
  /** Source node. For SUPERSEDES, the SUPERSEDING (newer) entity. */
  fromEntity: string;
  /** Target node. For SUPERSEDES, the SUPERSEDED (stale) entity. */
  toEntity: string;
  edgeType: EdgeType;
  sessionId?: string;
}

/** A supersession the pruner acts on: `superseded` is invalidated by `supersededBy`. */
export interface Supersession {
  superseded: string;
  supersededBy: string;
}

/**
 * One edge touching an entity (from {@link KnowledgeGraph.entityStatus}).
 * `outgoing` = the entity is the edge's `from`; `incoming` = the entity is the `to`.
 * For SUPERSEDES: outgoing → the entity supersedes `otherName`; incoming → the entity
 * is superseded by `otherName`.
 */
export interface EntityStatusEdge {
  direction: "outgoing" | "incoming";
  edgeType: EdgeType;
  otherName: string;
}

export interface KnowledgeGraph {
  /**
   * Create-or-get a node by (org, kind, name); returns its id.
   * @throws {Error} if the select or insert fails.
   */
  ensureEntity(input: EnsureEntityInput): Promise<string>;
  /**
   * Create-or-get a typed edge between two nodes; returns its id.
   * @throws {Error} if the select or insert fails.
   */
  addEdge(input: AddEdgeInput): Promise<string>;
  /**
   * ADR-0011 supersession lookup: of `entityNames`, which have an outgoing
   * SUPERSEDES edge, and to what.
   * @param orgId - the owning organization.
   * @param entityNames - entity names present in the current context.
   * @returns the supersessions among those names (empty if none).
   * @throws {Error} if the query fails.
   */
  findSuperseded(orgId: string, entityNames: string[]): Promise<Supersession[]>;
  /**
   * All edges touching an entity (powers /understand-codebase).
   * @param orgId - the owning organization.
   * @param name - the entity name.
   * @returns its edges (direction + type + the other entity), empty if none/unknown.
   * @throws {Error} if the query fails.
   */
  entityStatus(orgId: string, name: string): Promise<EntityStatusEdge[]>;
}

/**
 * Create a Supabase-backed knowledge graph.
 *
 * @param client - a configured Supabase client (service-role key; bypasses RLS).
 * @returns a {@link KnowledgeGraph}.
 */
export function createKnowledgeGraph(client: SupabaseClient): KnowledgeGraph {
  return {
    async ensureEntity(input: EnsureEntityInput): Promise<string> {
      const existing = await client.from("knowledge_entities").select("id").eq("org_id", input.orgId).eq("kind", input.kind).eq("name", input.name).limit(1);
      if (existing.error) throw new Error(`ensureEntity select failed: ${existing.error.message}`);
      const first = ((existing.data ?? []) as { id: string }[])[0];
      if (first) return first.id;

      const row: Record<string, unknown> = { org_id: input.orgId, kind: input.kind, name: input.name };
      if (input.sessionId !== undefined) row["session_id"] = input.sessionId;
      const created = await client.from("knowledge_entities").insert(row).select("id").single();
      if (created.error || !created.data) throw new Error(`ensureEntity insert failed: ${created.error?.message ?? "no row returned"}`);
      return (created.data as { id: string }).id;
    },

    async addEdge(input: AddEdgeInput): Promise<string> {
      const existing = await client
        .from("knowledge_edges")
        .select("id")
        .eq("org_id", input.orgId) // org-scope the existence check (no cross-tenant read)
        .eq("from_entity", input.fromEntity)
        .eq("to_entity", input.toEntity)
        .eq("edge_type", input.edgeType)
        .limit(1);
      if (existing.error) throw new Error(`addEdge select failed: ${existing.error.message}`);
      const first = ((existing.data ?? []) as { id: string }[])[0];
      if (first) return first.id;

      const row: Record<string, unknown> = {
        org_id: input.orgId,
        from_entity: input.fromEntity,
        to_entity: input.toEntity,
        edge_type: input.edgeType,
      };
      if (input.sessionId !== undefined) row["session_id"] = input.sessionId;
      const created = await client.from("knowledge_edges").insert(row).select("id").single();
      if (created.error || !created.data) throw new Error(`addEdge insert failed: ${created.error?.message ?? "no row returned"}`);
      return (created.data as { id: string }).id;
    },

    async findSuperseded(orgId: string, entityNames: string[]): Promise<Supersession[]> {
      if (entityNames.length === 0) return [];
      const { data, error } = await client.rpc("find_superseded", { match_org: orgId, names: entityNames });
      if (error) throw new Error(`findSuperseded failed: ${error.message}`);
      return ((data ?? []) as { superseded: string; superseded_by: string }[]).map((r) => ({
        superseded: r.superseded,
        supersededBy: r.superseded_by,
      }));
    },

    async entityStatus(orgId: string, name: string): Promise<EntityStatusEdge[]> {
      const { data, error } = await client.rpc("entity_status", { match_org: orgId, entity_name: name });
      if (error) throw new Error(`entityStatus failed: ${error.message}`);
      return ((data ?? []) as { direction: string; edge_type: string; other_name: string }[]).map((r) => ({
        direction: r.direction === "incoming" ? "incoming" : "outgoing",
        edgeType: r.edge_type as EdgeType,
        otherName: r.other_name,
      }));
    },
  };
}
