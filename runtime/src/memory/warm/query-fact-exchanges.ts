import type { SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../../proxy/auth";

/** Count current query-matched facts after exact hot-exchange filtering. */
export function createQueryFactCandidateLookup(client: SupabaseClient) {
  return async (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[], query: string): Promise<Map<string, number>> => {
    if (projectScope !== null && !validProjectScope(projectScope)) throw new Error("invalid project scope for query fact lookup");
    if (exchangeIds.length > 128) throw new Error("query fact lookup exceeds hot-window bound");
    if (exchangeIds.length === 0 || query.trim() === "") return new Map();
    const { data, error } = await client.rpc("find_query_hot_fact_exchanges", {
      match_org: orgId,
      match_session: sessionId,
      match_project_scope: projectScope,
      exchange_ids: exchangeIds,
      search_text: query.slice(0, 1200),
    });
    if (error) throw new Error(`find_query_hot_fact_exchanges failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("find_query_hot_fact_exchanges returned invalid rows");
    const requested = new Set(exchangeIds);
    const counts = new Map<string, number>();
    for (const row of data as { exchange_id: string; fact_count: number }[]) {
      if (!row || !requested.has(row.exchange_id) || !Number.isSafeInteger(row.fact_count) || row.fact_count < 1 || counts.has(row.exchange_id)) {
        throw new Error("find_query_hot_fact_exchanges returned invalid count");
      }
      counts.set(row.exchange_id, row.fact_count);
    }
    return counts;
  };
}
