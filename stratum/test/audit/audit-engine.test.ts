// Unit tests for the deterministic audit orchestration: attest a fact set + persist
// CONFLICTs to audit_conflicts (fake Supabase — no real DB/git/LLM).

import { describe, test, expect } from "vitest";
import { auditFacts, summarizeAudit, persistConflicts } from "../../src/audit/audit-engine";
import type { CodeChange } from "../../src/audit/git-attestation";
import type { AnyFact, FunctionChangeFact } from "../../src/types/facts";
import { makeFakeSupabase } from "../memory/fake-supabase";

const base = { created_at: "2026-01-01T00:00:00Z", session_id: "s", confidence: 0.9, is_verified: false, is_suppressed: false };
const fn = (id: string, o: Partial<FunctionChangeFact>): FunctionChangeFact => ({ id, ...base, fact_type: "FunctionChange", old_name: "getUser", change_type: "renamed", ...o });

const CHANGES: CodeChange[] = [
  { entity: "getUser", changeType: "renamed", toEntity: "fetchUser", commitHash: "c1", message: "rename", timestampSeconds: 1000 },
  { entity: "oldFn", changeType: "renamed", toEntity: "newFn", commitHash: "c2", message: "rename", timestampSeconds: 1000 },
  { entity: "newFn", changeType: "deleted", commitHash: "c3", message: "delete newFn", timestampSeconds: 2000 },
];
const FACTS: AnyFact[] = [
  fn("f1", { old_name: "getUser", new_name: "fetchUser" }), // CONFIRMED
  fn("f2", { old_name: "oldFn", new_name: "newFn" }), // CONFLICT (newFn deleted later)
  { id: "f3", ...base, fact_type: "Todo", description: "x", status: "open" }, // UNVERIFIED (not code-related)
];

describe("auditFacts + summarizeAudit", () => {
  const audited = auditFacts(FACTS, CHANGES);
  test("attests each fact deterministically", () => {
    expect(audited.map((a) => a.result.status)).toEqual(["CONFIRMED", "CONFLICT", "UNVERIFIED"]);
    expect(audited[1]!.result.conflictCommit).toBe("c3");
  });
  test("summary tallies by status", () => {
    expect(summarizeAudit(audited)).toEqual({ confirmed: 1, conflict: 1, unverified: 1 });
  });
});

describe("persistConflicts", () => {
  test("writes ONLY conflicts to audit_conflicts with the right shape + trusted FKs", async () => {
    const { client, store } = makeFakeSupabase();
    const n = await persistConflicts(client, auditFacts(FACTS, CHANGES), { orgId: "org-9", sessionId: "sess-9" });
    expect(n).toBe(1);
    const rows = store["audit_conflicts"]!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-9",
      session_id: "sess-9",
      fact_table: "function_changes",
      fact_id: "f2",
      conflict_commit: "c3",
      suppressed: true,
    });
    expect(String(rows[0]!["claimed_state"])).toContain("oldFn"); // factToText of the conflicting fact
    expect(String(rows[0]!["actual_state"])).toContain("newFn"); // the conflict detail
  });

  test("no conflicts → no write, returns 0", async () => {
    const { client, store } = makeFakeSupabase();
    const confirmedOnly = auditFacts([fn("f1", { old_name: "getUser", new_name: "fetchUser" })], CHANGES);
    expect(await persistConflicts(client, confirmedOnly, { orgId: "o", sessionId: "s" })).toBe(0);
    expect(store["audit_conflicts"]).toBeUndefined();
  });

  test("throws (no silent drop) when the insert fails", async () => {
    const { client } = makeFakeSupabase({}, { insertError: new Set(["audit_conflicts"]) });
    await expect(persistConflicts(client, auditFacts(FACTS, CHANGES), { orgId: "o", sessionId: "s" })).rejects.toThrow(/persistConflicts failed/);
  });
});
