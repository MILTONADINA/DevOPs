// Unit tests for pruning-log persistence: the pure PruneDecision→row mapping
// (incl. int4range span formatting) + the recordPruning insert against the fake
// Supabase client. The live int4range[] encoding is verified via the Supabase MCP
// + scripts/verify-tier2.ts (gated on the service key).

import { describe, test, expect } from "vitest";
import { spanToRange, pruneDecisionToRow, createPruningLogStore } from "../../src/memory/warm/pruning-log";
import type { PruneDecision } from "../../src/pruner/kadanedial";
import { makeFakeSupabase } from "./fake-supabase";

const decision: PruneDecision = {
  spans: [
    [0, 2],
    [4, 4],
  ],
  selectedIndices: [0, 1, 2, 4],
  prunedIndices: [3],
  decayedScores: [0.9, 0.8, 0.7, 0.2, 0.1],
  normalizedScores: [0.1, 1.4, 1.2, -0.5, -0.6],
  params: { lambda: 0.97, gainShift: 0, theta: 1.0, nowSeconds: 1000 },
  normalizationSkipped: false,
};

describe("pruning-log mapping", () => {
  test("spanToRange formats an inclusive int4range literal", () => {
    expect(spanToRange([0, 2])).toBe("[0,2]");
    expect(spanToRange([4, 4])).toBe("[4,4]");
  });

  test("pruneDecisionToRow projects all columns with the trusted session FK", () => {
    const row = pruneDecisionToRow("sess-1", decision);
    expect(row["session_id"]).toBe("sess-1");
    expect(row["turns_total"]).toBe(5); // 4 selected + 1 pruned
    expect(row["turns_selected"]).toEqual([0, 1, 2, 4]);
    expect(row["turns_pruned"]).toEqual([3]);
    expect(row["relevance_scores"]).toEqual([0.1, 1.4, 1.2, -0.5, -0.6]);
    expect(row["spans_selected"]).toEqual(["[0,2]", "[4,4]"]);
    expect(row["lambda_used"]).toBe(0.97);
    expect(row["gain_shift_used"]).toBe(0);
    expect(row["theta_used"]).toBe(1.0);
  });

  test("empty decision → turns_total 0, empty arrays", () => {
    const empty: PruneDecision = { spans: [], selectedIndices: [], prunedIndices: [], decayedScores: [], normalizedScores: [], params: { lambda: 0.97, gainShift: 0, theta: 1, nowSeconds: 0 }, normalizationSkipped: false };
    const row = pruneDecisionToRow("s", empty);
    expect(row["turns_total"]).toBe(0);
    expect(row["spans_selected"]).toEqual([]);
  });
});

describe("createPruningLogStore.recordPruning (fake client)", () => {
  test("inserts a row into pruning_logs and returns its id", async () => {
    const { client, store } = makeFakeSupabase();
    const plog = createPruningLogStore(client);
    const id = await plog.recordPruning("sess-1", decision);
    expect(id).toBeTruthy();
    expect(store["pruning_logs"]).toHaveLength(1);
    expect(store["pruning_logs"]![0]!["session_id"]).toBe("sess-1");
    expect(store["pruning_logs"]![0]!["spans_selected"]).toEqual(["[0,2]", "[4,4]"]);
  });

  test("throws when the insert errors", async () => {
    const { client } = makeFakeSupabase({}, { insertError: new Set(["pruning_logs"]) });
    const plog = createPruningLogStore(client);
    await expect(plog.recordPruning("sess-1", decision)).rejects.toThrow(/recordPruning failed/);
  });
});
