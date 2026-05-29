// Unit tests for Tier-1 Git-Attestation (pure — no git, no DB, no LLM). Verifies the
// deterministic CONFIRMED/UNVERIFIED/CONFLICT decision over an in-memory change set.

import { describe, test, expect } from "vitest";
import { attestFact, isCodeRelated, type CodeChange } from "../../src/audit/git-attestation";
import type { AnyFact, FunctionChangeFact, VariableChangeFact, TechDecisionFact, TodoFact } from "../../src/types/facts";

const base = { id: "f1", created_at: "2026-01-01T00:00:00Z", session_id: "s", confidence: 0.9, is_verified: false, is_suppressed: false };
const fnFact = (o: Partial<FunctionChangeFact>): FunctionChangeFact => ({ ...base, fact_type: "FunctionChange", old_name: "getUser", change_type: "renamed", ...o });
const varFact = (o: Partial<VariableChangeFact>): VariableChangeFact => ({ ...base, fact_type: "VariableChange", var_name: "API_URL", new_value: "https://x", ...o });
const change = (o: Partial<CodeChange>): CodeChange => ({ entity: "getUser", changeType: "renamed", commitHash: "c0", message: "m", timestampSeconds: 1000, ...o });

describe("isCodeRelated", () => {
  test("FunctionChange + VariableChange are code-related", () => {
    expect(isCodeRelated(fnFact({}))).toBe(true);
    expect(isCodeRelated(varFact({}))).toBe(true);
  });
  test("TechDecision only when infra/database domain", () => {
    const td = (domain: string): TechDecisionFact => ({ ...base, fact_type: "TechDecision", decision_text: "x", domain });
    expect(isCodeRelated(td("infrastructure"))).toBe(true);
    expect(isCodeRelated(td("database"))).toBe(true);
    expect(isCodeRelated(td("product"))).toBe(false);
  });
  test("Todo is not code-related", () => {
    const todo: TodoFact = { ...base, fact_type: "Todo", description: "x", status: "open" };
    expect(isCodeRelated(todo)).toBe(false);
  });
});

describe("attestFact — FunctionChange", () => {
  test("CONFIRMED: a matching rename commit exists", () => {
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [change({ entity: "getUser", changeType: "renamed", toEntity: "fetchUser", commitHash: "a3f9b2", timestampSeconds: 1000 })]);
    expect(r.status).toBe("CONFIRMED");
    expect(r.evidence?.commitHash).toBe("a3f9b2");
  });

  test("CONFLICT: the renamed-to symbol was DELETED later (historical drift)", () => {
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [
      change({ entity: "getUser", changeType: "renamed", toEntity: "fetchUser", timestampSeconds: 1000 }),
      change({ entity: "fetchUser", changeType: "deleted", commitHash: "c7d1e4", timestampSeconds: 2000 }),
    ]);
    expect(r.status).toBe("CONFLICT");
    expect(r.conflictDetail).toContain("fetchUser");
    expect(r.conflictDetail).toContain("c7d1e4");
  });

  test("NO conflict when the symbol was deleted then RE-ADDED (current state exists)", () => {
    // Distinct commit hashes so the re-add genuinely drives the result (not hash-exclusion).
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [
      change({ entity: "getUser", changeType: "renamed", toEntity: "fetchUser", commitHash: "ren1", timestampSeconds: 1000 }),
      change({ entity: "fetchUser", changeType: "deleted", commitHash: "del2", timestampSeconds: 2000 }),
      change({ entity: "fetchUser", changeType: "added", commitHash: "add3", timestampSeconds: 3000 }),
    ]);
    expect(r.status).toBe("CONFIRMED"); // latest change leaves fetchUser present
  });

  test("UNVERIFIED: no commit evidence at all", () => {
    expect(attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), []).status).toBe("UNVERIFIED");
  });

  test("UNVERIFIED (not CONFLICT) with NO confirming commit even if a later change touches the symbol (review #1)", () => {
    // renamed getUser→fetchUser with NO rename/add evidence + an unrelated later delete of fetchUser.
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [change({ entity: "fetchUser", changeType: "deleted", commitHash: "x1", timestampSeconds: 5000 })]);
    expect(r.status).toBe("UNVERIFIED"); // no confirmation ⇒ no drift CONFLICT fabricated from thin air
  });

  test("deprecated with NO deletion evidence but a later add → UNVERIFIED, not a fabricated CONFLICT (review #1)", () => {
    expect(attestFact(fnFact({ change_type: "deprecated" }), [change({ entity: "getUser", changeType: "added", commitHash: "x1", timestampSeconds: 5000 })]).status).toBe("UNVERIFIED");
  });

  test("a contradicting change in the SAME second as the confirming commit still yields CONFLICT (review #2)", () => {
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [
      change({ entity: "getUser", changeType: "renamed", toEntity: "fetchUser", commitHash: "ren1", timestampSeconds: 5000 }),
      change({ entity: "fetchUser", changeType: "deleted", commitHash: "del1", timestampSeconds: 5000 }), // same second, DISTINCT commit
    ]);
    expect(r.status).toBe("CONFLICT");
  });

  test("signature_changed CONFLICT when the function is later deleted (review #11)", () => {
    const r = attestFact(fnFact({ change_type: "signature_changed" }), [
      change({ entity: "getUser", changeType: "modified", commitHash: "mod1", timestampSeconds: 1000 }),
      change({ entity: "getUser", changeType: "deleted", commitHash: "del2", timestampSeconds: 2000 }),
    ]);
    expect(r.status).toBe("CONFLICT");
    expect(r.conflictCommit).toBe("del2");
  });

  test("rename partial evidence → UNVERIFIED, not a false CONFIRMED (review #12)", () => {
    // only delete-old:
    expect(attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [change({ entity: "getUser", changeType: "deleted", commitHash: "d1", timestampSeconds: 1000 })]).status).toBe("UNVERIFIED");
    // only add-new:
    expect(attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [change({ entity: "fetchUser", changeType: "added", commitHash: "a1", timestampSeconds: 1000 })]).status).toBe("UNVERIFIED");
  });

  test("deprecated: CONFIRMED by a deletion; CONFLICT if re-added later", () => {
    const del = change({ entity: "getUser", changeType: "deleted", timestampSeconds: 1000 });
    expect(attestFact(fnFact({ change_type: "deprecated" }), [del]).status).toBe("CONFIRMED");
    const r = attestFact(fnFact({ change_type: "deprecated" }), [del, change({ entity: "getUser", changeType: "added", commitHash: "re1", timestampSeconds: 2000 })]);
    expect(r.status).toBe("CONFLICT");
    expect(r.conflictDetail).toContain("re-added");
  });

  test("signature_changed: CONFIRMED by a modify", () => {
    expect(attestFact(fnFact({ change_type: "signature_changed" }), [change({ entity: "getUser", changeType: "modified", timestampSeconds: 1000 })]).status).toBe("CONFIRMED");
  });

  test("renamed CONFIRMED via the diff-level signature (delete-old + add-new) the indexer emits", () => {
    // The indexer doesn't infer symbol renames; a rename is deleted getUser + added fetchUser.
    const r = attestFact(fnFact({ new_name: "fetchUser", change_type: "renamed" }), [
      change({ entity: "getUser", changeType: "deleted", timestampSeconds: 1000 }),
      change({ entity: "fetchUser", changeType: "added", commitHash: "addc", timestampSeconds: 1000 }),
    ]);
    expect(r.status).toBe("CONFIRMED");
  });
});

describe("attestFact — VariableChange + non-code", () => {
  test("VariableChange CONFIRMED by a modify on the var", () => {
    expect(attestFact(varFact({}), [change({ entity: "API_URL", changeType: "modified", timestampSeconds: 1000 })]).status).toBe("CONFIRMED");
  });
  test("VariableChange UNVERIFIED with no change", () => {
    expect(attestFact(varFact({}), []).status).toBe("UNVERIFIED");
  });
  test("TechDecision (infra) → UNVERIFIED (no deterministic git evidence → Tier-2)", () => {
    const td: TechDecisionFact = { ...base, fact_type: "TechDecision", decision_text: "use Cloudflare Workers", domain: "infrastructure" };
    expect(attestFact(td, [change({})]).status).toBe("UNVERIFIED");
  });
  test("non-code-related fact → UNVERIFIED", () => {
    const todo: AnyFact = { ...base, fact_type: "Todo", description: "x", status: "open" };
    expect(attestFact(todo, [change({})]).status).toBe("UNVERIFIED");
  });
});
