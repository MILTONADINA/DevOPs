import type { SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../../proxy/auth";

const FACT_TABLES = new Set(["function_changes", "tech_decisions", "policy_updates", "todos", "variable_changes", "operational_references"]);

/** Bounded, query-matched current facts from exact hot conversation exchanges. */
export function createQueryFactCandidateLookup(client: SupabaseClient) {
  return async (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[], query: string): Promise<Map<string, number>> => {
    if (projectScope !== null && !validProjectScope(projectScope)) throw new Error("invalid project scope for query fact lookup");
    if (exchangeIds.length > 128) throw new Error("query fact lookup exceeds hot-window bound");
    if (exchangeIds.length === 0 || query.trim() === "") return new Map();
    const { data, error } = await client.rpc("search_project_warm_facts", {
      match_org: orgId,
      match_project_scope: projectScope,
      search_text: query.slice(0, 1200),
      result_limit: 20,
    });
    if (error) throw new Error(`search_project_warm_facts failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("search_project_warm_facts returned invalid rows");
    const requested = new Set(exchangeIds);
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const hit of data.slice(0, 20) as Record<string, unknown>[]) {
      if (
        !hit ||
        typeof hit !== "object" ||
        typeof hit["fact_table"] !== "string" ||
        !FACT_TABLES.has(hit["fact_table"]) ||
        typeof hit["lexical_score"] !== "number" ||
        !Number.isFinite(hit["lexical_score"]) ||
        hit["lexical_score"] <= 0
      )
        continue;
      const row = hit["fact"];
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const fact = row as Record<string, unknown>;
      const exchangeId = fact["source_exchange_id"];
      const id = fact["id"];
      if (
        fact["org_id"] !== orgId ||
        fact["session_id"] !== sessionId ||
        fact["project_scope"] !== projectScope ||
        typeof exchangeId !== "string" ||
        !requested.has(exchangeId) ||
        typeof id !== "string" ||
        id === "" ||
        fact["is_suppressed"] !== false
      )
        continue;
      const key = `${hit["fact_table"]}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(exchangeId, (counts.get(exchangeId) ?? 0) + 1);
    }
    return counts;
  };
}
