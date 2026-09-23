import type { SupabaseClient } from "@supabase/supabase-js";
import type { FactExtractor } from "../memory/warm/extractor";
import { createWarmMemory } from "../memory/warm/tier2";
import type { MessageMemoryEvent } from "./forward";

/** Persist an authenticated request's extracted facts under a fresh DB session. */
export function createSupabaseMessageMemoryRecorder(client: SupabaseClient, extractor: FactExtractor): (event: MessageMemoryEvent) => Promise<void> {
  const warm = createWarmMemory(client);
  return async ({ orgId, model, turns }) => {
    const { data, error } = await client.from("sessions").insert({ org_id: orgId, model, kind: "memory", ended_at: new Date().toISOString() }).select("id").limit(1);
    if (error) throw new Error(`memory session insert failed: ${error.message}`);
    const sessionId = (data as { id: string }[] | null)?.[0]?.id;
    if (!sessionId) throw new Error("memory session insert returned no id");
    const facts = await extractor.extract({ session_id: sessionId, turns });
    if (facts.length === 0) return;
    const result = await warm.persist(facts, { orgId, sessionId });
    if (result.errors.length > 0) throw new Error(`memory fact persistence failed: ${result.errors.map((e) => `${e.table}: ${e.message}`).join("; ")}`);
  };
}
