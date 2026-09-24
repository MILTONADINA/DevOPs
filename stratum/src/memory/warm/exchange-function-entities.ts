import type { SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../../proxy/auth";

/** Resolve unambiguous function names from trusted commercial exchange IDs. */
export function createExchangeFunctionLookup(client: SupabaseClient) {
  return async (orgId: string, sessionId: string, projectScope: string | null, exchangeIds: string[]): Promise<Map<string, string>> => {
    if (projectScope !== null && !validProjectScope(projectScope)) throw new Error("invalid project scope for exchange lookup");
    if (exchangeIds.length === 0) return new Map();
    const { data, error } = await client.rpc("find_exchange_function_entities", {
      match_org: orgId,
      match_session: sessionId,
      match_project_scope: projectScope,
      exchange_ids: exchangeIds,
    });
    if (error) throw new Error(`find_exchange_function_entities failed: ${error.message}`);
    return new Map(((data ?? []) as { exchange_id: string; entity_name: string }[]).map((row) => [row.exchange_id, row.entity_name]));
  };
}

/** Graph relation for Function nodes only; same project/provenance rules as the generic lookup. */
export function createProjectFunctionSupersessionLookup(client: SupabaseClient) {
  return async (orgId: string, projectScope: string | null, names: string[]): Promise<{ superseded: string; supersededBy: string }[]> => {
    if (projectScope !== null && !validProjectScope(projectScope)) throw new Error("invalid project scope for function supersession lookup");
    if (names.length === 0) return [];
    const { data, error } = await client.rpc("find_project_function_superseded", { match_org: orgId, match_project_scope: projectScope, names });
    if (error) throw new Error(`find_project_function_superseded failed: ${error.message}`);
    return ((data ?? []) as { superseded: string; superseded_by: string }[]).map((row) => ({ superseded: row.superseded, supersededBy: row.superseded_by }));
  };
}
