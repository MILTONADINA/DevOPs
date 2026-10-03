// AC-B7/B8/B13: synthetic inputs through shipped writers, with no protected read
// or fixture-side enrollment. Only the separate operator verifier reads content.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { createKnowledgeGraph } from "../../src/memory/cold/graph";
import { createVectorStore } from "../../src/memory/cold/vectors";
import { createPruningLogStore } from "../../src/memory/warm/pruning-log";
import { recordUsage } from "../../src/usage/recorder";
import type { AnyFact, BaseFact } from "../../src/types/facts";

export const EXPECTED_DELETED = {
  sessions: 1,
  billing_records: 1,
  pruning_logs: 1,
  function_changes: 1,
  tech_decisions: 2,
  policy_updates: 1,
  todos: 1,
  variable_changes: 1,
  operational_references: 1,
  audit_conflicts: 2,
  audit_statuses: 1,
  knowledge_entities: 2,
  knowledge_edges: 1,
  knowledge_entity_sessions: 4,
  knowledge_edge_sessions: 2,
  source_fact_links: 3,
  memory_vectors: 3,
};
export const EXPECTED_RETAINED = {
  knowledge_entities: 2,
  knowledge_edges: 1,
  knowledge_entity_sessions: 2,
  knowledge_edge_sessions: 1,
  source_fact_links: 1,
  memory_vectors: 1,
  erasure_deployment: 1,
  erasure_org_coverage: 1,
  session_erasure_state: 1,
  erased_fact_ids: 7,
  erased_entity_ids: 2,
};

export interface ErasureApiFixture {
  org: string;
  target: string;
  survivor: string;
  facts: Record<string, string[]>;
  survivorFact: string;
  privateFile: string;
  privateFunction: string;
  privateEdge: string;
  sharedFile: string;
  sharedFunction: string;
  sharedEdge: string;
  conflict: string;
  ownAudit: string;
  pruning: string;
  usage: string;
}

function base(session: string, date = "2026-01-01T00:00:00.000Z"): Omit<BaseFact, "fact_type"> {
  return { id: randomUUID(), session_id: session, created_at: date, confidence: 1, is_verified: false, is_suppressed: false };
}

/** Called only after normal HTTP session creation in a manifest-bound producer. */
export async function populateErasureApiFixture(db: SupabaseClient, org: string, target: string, survivor: string): Promise<ErasureApiFixture> {
  const graph = createKnowledgeGraph(db);
  const entity = (sessionId: string, name: string, kind: "File" | "Function") =>
    graph.ensureEntity({
      orgId: org,
      sessionId,
      projectScope: null,
      kind,
      name,
      ...(kind === "File" ? { filePath: name } : {}),
    });
  const edge = (sessionId: string, fromEntity: string, toEntity: string) =>
    graph.addEdge({
      orgId: org,
      sessionId,
      projectScope: null,
      fromEntity,
      toEntity,
      edgeType: "DECLARES",
    });
  const privateFile = await entity(target, "private.ts", "File");
  const privateFunction = await entity(target, "private_fn", "Function");
  const privateEdge = await edge(target, privateFile, privateFunction);
  const sharedFile = await entity(survivor, "shared.ts", "File");
  const sharedFunction = await entity(survivor, "shared_fn", "Function");
  const sharedEdge = await edge(survivor, sharedFile, sharedFunction);
  assert.equal(await entity(target, "shared.ts", "File"), sharedFile);
  assert.equal(await entity(target, "shared_fn", "Function"), sharedFunction);
  assert.equal(await edge(target, sharedFile, sharedFunction), sharedEdge);

  const facts: AnyFact[] = [
    { ...base(target), fact_type: "FunctionChange", old_name: "private_fn", change_type: "deprecated", file_path: "private.ts" },
    { ...base(target), fact_type: "TechDecision", decision_text: "Original private decision", domain: "private.ts" },
    { ...base(target, "2026-02-01T00:00:00.000Z"), fact_type: "TechDecision", decision_text: "Replacement private decision", domain: "private.ts" },
    { ...base(target), fact_type: "PolicyUpdate", policy_name: "Private policy", new_value: "required", policy_type: "process" },
    { ...base(target), fact_type: "Todo", description: "Private task", status: "open" },
    { ...base(target), fact_type: "VariableChange", var_name: "private_variable", new_value: "value" },
    { ...base(target), fact_type: "OperationalReference", subject: "Private runbook", reference: "private.md" },
  ];
  const warm = createWarmMemory(db);
  assert.deepEqual(await warm.persist(facts, { orgId: org, sessionId: target, projectScope: null }), { persisted: 7, skipped: 0, errors: [] });
  const ids = (type: AnyFact["fact_type"]) => facts.filter((fact) => fact.fact_type === type).map((fact) => fact.id);
  const fc = ids("FunctionChange")[0]!;
  const decisions = ids("TechDecision");
  const policy = ids("PolicyUpdate")[0]!;
  const todo = ids("Todo")[0]!;
  const reviewed = await db.rpc("review_tech_decision_supersession", {
    match_org: org,
    match_project_scope: null,
    newer_id: decisions[1],
    older_id: decisions[0],
    reviewer: "API fixture operator",
    evidence: "Reviewed synthetic replacement decision evidence",
  });
  assert.equal(reviewed.error, null, "normal decision review failed");
  assert.equal(reviewed.data, decisions[1]);

  const survivingFact: AnyFact = { ...base(survivor), fact_type: "FunctionChange", old_name: "shared_fn", change_type: "deprecated", file_path: "shared.ts" };
  assert.deepEqual(await warm.persist([survivingFact], { orgId: org, sessionId: survivor, projectScope: null }), { persisted: 1, skipped: 0, errors: [] });
  const conflict = randomUUID();
  const audited = await db.rpc("persist_audit_results", {
    p_org_id: org,
    p_session_id: survivor,
    p_rows: [
      { id: conflict, fact_table: "todos", fact_id: todo, status: "CONFLICT", claimed_state: "Private task complete", actual_state: "Private task pending", conflict_commit: "synthetic-api-fixture" },
    ],
  });
  assert.equal(audited.error, null, "normal audit writer failed");
  assert.equal(audited.data, 1);
  const ownAudit = randomUUID();
  const own = await db.from("audit_conflicts").insert({
    id: ownAudit,
    org_id: org,
    session_id: target,
    fact_table: "function_changes",
    fact_id: survivingFact.id,
    claimed_state: "Shared claimed",
    actual_state: "Shared actual",
  });
  assert.equal(own.error, null, "ordinary scoped audit insert failed");

  const embedding = [1, ...Array<number>(383).fill(0)];
  assert.equal(
    await createVectorStore(db).upsert([
      { orgId: org, sourceType: "fact", sourceRef: fc, embedding },
      { orgId: org, sessionId: survivor, sourceType: "fact", sourceRef: policy, embedding },
      { orgId: org, sourceType: "entity", sourceRef: privateFunction, embedding },
      { orgId: org, sessionId: survivor, sourceType: "entity", sourceRef: sharedFile, embedding },
    ]),
    4,
  );
  const pruning = await createPruningLogStore(db).recordPruning(target, {
    spans: [
      [0, 0],
      [2, 2],
    ],
    selectedIndices: [0, 2],
    prunedIndices: [1],
    decayedScores: [1, -1, 1],
    normalizedScores: [1, -1, 1],
    normalizationSkipped: false,
    params: { lambda: 0.97, gainShift: 0, theta: 1, nowSeconds: 1_700_000_000 },
  });
  const usage = await recordUsage(
    { client: db },
    {
      orgId: org,
      sessionId: target,
      originalTokens: 120,
      quarantinedTokens: 20,
      apiPricePerToken: 0.00001,
      pruningLogId: pruning,
    },
  );
  return {
    org,
    target,
    survivor,
    privateFile,
    privateFunction,
    privateEdge,
    sharedFile,
    sharedFunction,
    sharedEdge,
    facts: { function_changes: [fc], tech_decisions: decisions, policy_updates: [policy], todos: [todo], variable_changes: ids("VariableChange"), operational_references: ids("OperationalReference") },
    survivorFact: survivingFact.id,
    conflict,
    ownAudit,
    pruning,
    usage: usage.id,
  };
}
