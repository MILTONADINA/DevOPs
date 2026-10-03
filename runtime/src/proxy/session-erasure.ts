/** Scoped erasure RPC boundary (specs/memory/session-erasure.md REQ-10/15/16). */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = z.literal("managed_explicit_session_v1");
const identity = { scope, org_id: z.string().uuid(), session_id: z.string().uuid() };
const counts = z
  .object({
    sessions: z.literal(1),
    billing_records: count,
    pruning_logs: count,
    function_changes: count,
    tech_decisions: count,
    policy_updates: count,
    todos: count,
    variable_changes: count,
    operational_references: count,
    audit_conflicts: count,
    audit_statuses: count,
    knowledge_entities: count,
    knowledge_edges: count,
    knowledge_entity_sessions: count,
    knowledge_edge_sessions: count,
    source_fact_links: count,
    memory_vectors: count,
  })
  .strict();
const reason = z.enum([
  "deployment_unverified",
  "coverage_unknown",
  "session_not_enrolled",
  "unknown_database_class",
  "stores_not_inventoried",
  "graph_ownership_ambiguous",
  "shared_origin_unsupported",
  "incoming_reference_unsupported",
  "generic_reference_unresolved",
  "ownership_inconsistent",
  "erasure_execution_unavailable",
]);
const blocked = z
  .object({
    status: z.literal("blocked"),
    ...identity,
    reasons: z.array(reason).nonempty(),
  })
  .strict();
const prepared = z
  .object({
    status: z.literal("prepared"),
    ...identity,
    request_id: z.string().uuid(),
  })
  .strict();
const complete = z
  .object({
    status: z.literal("complete"),
    ...identity,
    request_id: z.string().uuid(),
    completed_at: z.string().datetime({ offset: true }),
    deleted: counts,
    retained: z
      .object({
        knowledge_entities: count,
        knowledge_edges: count,
        knowledge_entity_sessions: count,
        knowledge_edge_sessions: count,
        source_fact_links: count,
        memory_vectors: count,
        erasure_deployment: z.literal(1),
        erasure_org_coverage: z.literal(1),
        session_erasure_state: z.literal(1),
        erased_fact_ids: count,
        erased_entity_ids: count,
      })
      .strict(),
    exclusions: z.tuple([z.literal("client_held_responses"), z.literal("privileged_host_database_snapshots"), z.literal("physical_heap_os_remnants")]),
  })
  .strict();
const preparation = z.discriminatedUnion("status", [blocked, prepared, complete]);
const inspection = z
  .object({
    status: z.enum(["ready", "blocked"]),
    reasons: z.array(reason),
    inventory: z
      .object({
        scope: z.literal("local_database_only"),
        org_id: z.string().uuid(),
        session_id: z.string().uuid(),
        counts,
        graph_ownership: z.enum(["none", "exclusive", "shared", "ambiguous"]),
        unattributed_graph: z.literal("not_inventoried"),
        org_only_classes: z.tuple([z.literal("api_keys"), z.literal("developers"), z.literal("org_config"), z.literal("organizations")]),
        retained_metadata_classes: z.tuple([z.literal("erasure_deployment"), z.literal("erasure_org_coverage"), z.literal("session_erasure_state")]),
        external_copies: z.literal("not_inventoried"),
        backups: z.literal("not_inventoried"),
        in_memory: z.literal("not_inventoried"),
      })
      .strict(),
    classifications: z
      .object({
        scope,
        deployment: z.enum(["covered", "unknown"]),
        enrollment: z.enum(["covered", "unknown"]),
        database: z.enum(["covered", "unknown"]),
        in_memory: z.enum(["excluded", "unknown"]),
        external_copies: z.enum(["excluded", "unknown"]),
        backups: z.enum(["excluded", "unknown"]),
      })
      .strict(),
  })
  .strict()
  .refine((value) =>
    value.status === "blocked"
      ? value.reasons.length > 0
      : value.reasons.length === 0 &&
        value.inventory.graph_ownership !== "ambiguous" &&
        value.classifications.deployment === "covered" &&
        value.classifications.enrollment === "covered" &&
        value.classifications.database === "covered" &&
        value.classifications.in_memory === "excluded" &&
        value.classifications.external_copies === "excluded" &&
        value.classifications.backups === "excluded",
  );

export interface SessionErasureDeps {
  inspect(orgId: string, sessionId: string): Promise<z.infer<typeof inspection> | null>;
  erase(orgId: string, sessionId: string): Promise<z.infer<typeof blocked> | z.infer<typeof complete> | null>;
}

function canonicalUuid(value: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new Error("invalid erasure identity");
  return value.toLowerCase();
}

/** A lost prepare/execute response is resolved by the next scoped prepare call. */
export function createSessionErasureDeps(client: SupabaseClient): SessionErasureDeps {
  async function rpc(name: string, orgId: string, sessionId: string): Promise<unknown> {
    const { data, error } = await client.rpc(name, { p_org_id: orgId, p_session_id: sessionId });
    if (error) throw new Error("session erasure RPC unavailable");
    return data;
  }
  function scoped<T extends { org_id: string; session_id: string }>(value: T, orgId: string, sessionId: string): T {
    if (value.org_id !== orgId || value.session_id !== sessionId) throw new Error("invalid scoped erasure response");
    return value;
  }
  return {
    async inspect(orgId, sessionId) {
      orgId = canonicalUuid(orgId);
      sessionId = canonicalUuid(sessionId);
      const data = await rpc("inspect_managed_session_erasure", orgId, sessionId);
      if (data === null) return null;
      const parsed = inspection.safeParse(data);
      if (!parsed.success) throw new Error("invalid erasure inspection");
      scoped(parsed.data.inventory, orgId, sessionId);
      return parsed.data;
    },
    async erase(orgId, sessionId) {
      orgId = canonicalUuid(orgId);
      sessionId = canonicalUuid(sessionId);
      const data = await rpc("prepare_session_erasure", orgId, sessionId);
      if (data === null) return null;
      const parsed = preparation.safeParse(data);
      if (!parsed.success) throw new Error("invalid erasure preparation");
      const result = scoped(parsed.data, orgId, sessionId);
      if (result.status !== "prepared") return result;
      // These are deliberately separate requests: preparation commits the durable
      // fence before the content transaction can fail or lose its response.
      const executed = complete.safeParse(await rpc("execute_session_erasure", orgId, sessionId));
      if (!executed.success || executed.data.request_id !== result.request_id) throw new Error("invalid erasure completion");
      return scoped(executed.data, orgId, sessionId);
    },
  };
}
