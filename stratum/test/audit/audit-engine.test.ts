// Unit tests for the deterministic audit orchestration: attest a fact set + persist
// CONFLICTs to audit_conflicts (fake Supabase — no real DB/git/LLM).

import { describe, test, expect } from "vitest";
import { auditFacts, summarizeAudit, persistConflicts, persistAuditResults } from "../../src/audit/audit-engine";
import type { CodeChange } from "../../src/audit/git-attestation";
import type { AnyFact, FunctionChangeFact } from "../../src/types/facts";
import type { SupabaseClient } from "@supabase/supabase-js";

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

test("persistAuditResults sends every Tier-1 outcome to one scoped transaction", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: 1, error: null };
  } } as unknown as SupabaseClient;
  expect(await persistAuditResults(client, auditFacts(FACTS, CHANGES), { orgId: "org-9", sessionId: "sess-9" })).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("persist_audit_results");
  expect(calls[0]?.args).toMatchObject({ p_org_id: "org-9", p_session_id: "sess-9" });
  const rows = calls[0]?.args["p_rows"] as { status: string; fact_table: string; fact_id: string }[];
  expect(rows.map((r) => [r.fact_id, r.status])).toEqual([["f1", "CONFIRMED"], ["f2", "CONFLICT"], ["f3", "UNVERIFIED"]]);
  expect(rows[1]).toMatchObject({ fact_table: "function_changes", fact_id: "f2" });
});

describe("persistConflicts", () => {
  function auditDb(failInsert = false) {
    const store: Record<string, Record<string, unknown>[]> = {
      function_changes: [
        { id: "f2", org_id: "org-9", is_suppressed: false },
        { id: "f2", org_id: "org-10", is_suppressed: false },
      ],
      audit_conflicts: [],
    };
    const calls: Record<string, unknown>[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, ...args });
        if (name !== "persist_audit_results") return { data: null, error: { message: "wrong RPC" } };
        const rows = args["p_rows"] as Record<string, unknown>[];
        const org = args["p_org_id"];
        const pendingFacts = store["function_changes"]!.map((r) => ({ ...r }));
        const pendingConflicts = store["audit_conflicts"]!.map((r) => ({ ...r }));
        let inserted = 0;
        for (const row of rows) {
          if (row["fact_table"] !== "function_changes" || row["status"] !== "CONFLICT") return { data: null, error: { message: "unsupported table or status" } };
          const fact = pendingFacts.find((r) => r["id"] === row["fact_id"] && r["org_id"] === org);
          if (!fact) return { data: null, error: { message: "missing fact in organization" } };
          fact["is_suppressed"] = true;
          if (failInsert) return { data: null, error: { message: "insert failed" } };
          if (!pendingConflicts.some((r) => r["id"] === row["id"])) {
            pendingConflicts.push({ ...row, org_id: org, session_id: args["p_session_id"], suppressed: true });
            inserted++;
          }
        }
        store["function_changes"] = pendingFacts;
        store["audit_conflicts"] = pendingConflicts;
        return { data: inserted, error: null };
      },
    } as unknown as SupabaseClient;
    return { client, store, calls };
  }

  test("repeat audit preserves one acknowledged alert; new evidence and org create separate alerts", async () => {
    const { client, store } = auditDb();
    const audited = auditFacts(FACTS, CHANGES);
    await persistConflicts(client, audited, { orgId: "org-9", sessionId: "sess-9" });
    const first = store["audit_conflicts"]![0]!;
    first["acknowledged"] = true;
    first["detected_at"] = "2026-01-01T00:00:00Z";

    expect(await persistConflicts(client, audited, { orgId: "org-9", sessionId: "sess-10" })).toBe(0);
    expect(store["audit_conflicts"]).toHaveLength(1);
    expect(store["audit_conflicts"]![0]).toMatchObject({ acknowledged: true, detected_at: "2026-01-01T00:00:00Z", session_id: "sess-9" });

    const changed = audited.map((a) => a.result.status === "CONFLICT"
      ? { ...a, result: { ...a.result, conflictCommit: "c4" } }
      : a);
    await persistConflicts(client, changed, { orgId: "org-9", sessionId: "sess-11" });
    const changedDetail = audited.map((a) => a.result.status === "CONFLICT"
      ? { ...a, result: { ...a.result, conflictDetail: "a different contradiction" } }
      : a);
    await persistConflicts(client, changedDetail, { orgId: "org-9", sessionId: "sess-11" });
    await persistConflicts(client, audited, { orgId: "org-10", sessionId: "sess-12" });
    expect(store["audit_conflicts"]).toHaveLength(4);
    expect(new Set(store["audit_conflicts"]!.map((r) => r["id"])).size).toBe(4);
  });

  test("writes ONLY conflicts to audit_conflicts with the right shape + trusted FKs", async () => {
    const { client, store, calls } = auditDb();
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
    expect(rows[0]!["id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(String(rows[0]!["claimed_state"])).toContain("oldFn"); // factToText of the conflicting fact
    expect(String(rows[0]!["actual_state"])).toContain("newFn"); // the conflict detail
    expect(store["function_changes"]![0]!["is_suppressed"]).toBe(true);
    expect(calls[0]).toMatchObject({ name: "persist_audit_results", p_org_id: "org-9", p_session_id: "sess-9" });
  });

  test("no conflicts → no write, returns 0", async () => {
    const { client, store, calls } = auditDb();
    const confirmedOnly = auditFacts([fn("f1", { old_name: "getUser", new_name: "fetchUser" })], CHANGES);
    expect(await persistConflicts(client, confirmedOnly, { orgId: "o", sessionId: "s" })).toBe(0);
    expect(store["audit_conflicts"]).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a failed insert rolls back fact suppression and reports the error", async () => {
    const { client, store } = auditDb(true);
    await expect(persistConflicts(client, auditFacts(FACTS, CHANGES), { orgId: "o", sessionId: "s" })).rejects.toThrow(/persistAuditResults failed/);
    expect(store["function_changes"]![0]!["is_suppressed"]).toBe(false);
    expect(store["audit_conflicts"]).toEqual([]);
  });

  test("a missing fact in the trusted organization cannot create an alert", async () => {
    const { client, store } = auditDb();
    await expect(persistConflicts(client, auditFacts(FACTS, CHANGES), { orgId: "org-other", sessionId: "s" })).rejects.toThrow(/missing fact/);
    expect(store["function_changes"]!.every((r) => r["is_suppressed"] === false)).toBe(true);
    expect(store["audit_conflicts"]).toEqual([]);
  });
});
