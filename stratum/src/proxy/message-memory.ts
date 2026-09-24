import type { SupabaseClient } from "@supabase/supabase-js";
import type { FactExtractor } from "../memory/warm/extractor";
import { createWarmMemory } from "../memory/warm/tier2";
import { tableForFactType } from "../memory/warm/tier2";
import { indexRepository } from "../audit/git-indexer";
import { auditFacts, persistAuditResults } from "../audit/audit-engine";
import type { MessageMemoryEvent } from "./forward";
import { validProjectScope } from "./auth";
import { createSupabaseConversationResolver } from "./conversation";

/** Persist extracted facts under a verified conversation or a fresh legacy memory session. */
export function createSupabaseMessageMemoryRecorder(client: SupabaseClient, extractor: FactExtractor, auditRepoRoot?: string): (event: MessageMemoryEvent) => Promise<void> {
  const warm = createWarmMemory(client);
  const resolveConversation = createSupabaseConversationResolver(client);
  return async ({ orgId, projectScopeId, conversationId, keyId, exchangeId, model, turns }) => {
    const projectScope = projectScopeId === undefined ? null : projectScopeId.slice(orgId.length + 1);
    if (projectScopeId !== undefined && (!projectScopeId.startsWith(`${orgId}/`) || !validProjectScope(projectScope))) {
      throw new Error("invalid authenticated project scope for memory event");
    }
    if (Boolean(conversationId) !== Boolean(keyId)) throw new Error("incomplete authenticated conversation identity for memory event");
    if (exchangeId && !conversationId) throw new Error("exchange identity requires a verified conversation");
    let sessionId: string;
    if (conversationId && keyId) {
      sessionId = await resolveConversation({ orgId, keyId, ...(projectScopeId ? { projectScopeId } : {}), model, requestedId: conversationId });
    } else {
      const { data, error } = await client.from("sessions").insert({ org_id: orgId, project_scope: projectScope, model, kind: "memory", ended_at: new Date().toISOString() }).select("id").limit(1);
      if (error) throw new Error(`memory session insert failed: ${error.message}`);
      const inserted = (data as { id: string }[] | null)?.[0]?.id;
      if (!inserted) throw new Error("memory session insert returned no id");
      sessionId = inserted;
    }
    const facts = await extractor.extract({ session_id: sessionId, turns });
    if (facts.length === 0) return;
    // Compute audit outcomes before any fact is visible. A failed index leaves
    // no stored fact; a failed RPC leaves the inserted facts suppressed.
    const audited = auditRepoRoot === undefined ? undefined : auditFacts(facts, await indexRepository({ cwd: auditRepoRoot, maxCount: 100 }));
    const rows = audited === undefined ? facts : facts.map((fact) => ({ ...fact, is_suppressed: true }));
    const result = await warm.persist(rows, { orgId, sessionId, projectScope, ...(exchangeId ? { exchangeId } : {}) });
    if (result.errors.length > 0) throw new Error(`memory fact persistence failed: ${result.errors.map((e) => `${e.table}: ${e.message}`).join("; ")}`);
    if (result.skipped !== 0 || result.persisted !== facts.length) throw new Error("memory fact persistence omitted a validated fact");
    if (audited !== undefined) {
      await persistAuditResults(client, audited, { orgId, sessionId });
      for (const { fact, result: audit } of audited) {
        if (audit.status === "CONFLICT") continue;
        const table = tableForFactType(fact.fact_type);
        const released = await client.from(table).update({ is_suppressed: false }).eq("id", fact.id).eq("org_id", orgId).eq("session_id", sessionId).select("id");
        if (released.error || (released.data ?? []).length !== 1) throw new Error(`memory fact release failed: ${released.error?.message ?? "fact missing"}`);
      }
    }
  };
}
