// Unit tests for the audit-conflicts alert surface's pure seams (parseArgs,
// renderConflictRow). The live Supabase read/ack path is exercised by running
// `npm run audit:conflicts` against the DB (and is gated on creds).

import { describe, test, expect } from "vitest";
import { parseArgs, renderConflictRow, type ConflictRow } from "../../scripts/audit-conflicts";

describe("parseArgs", () => {
  test("defaults: no org, limit 50, not all, no ack", () => {
    const a = parseArgs([]);
    expect(a).toEqual({ limit: 50, all: false });
  });

  test("parses all flags", () => {
    const a = parseArgs(["--org-id", "o1", "--limit", "10", "--all", "--ack", "c1", "--by", "dev1"]);
    expect(a).toMatchObject({ orgId: "o1", limit: 10, all: true, ackId: "c1", by: "dev1" });
  });

  test("a non-numeric / non-positive --limit falls back sanely (never 0 / NaN)", () => {
    expect(parseArgs(["--limit", "abc"]).limit).toBe(50);
    expect(parseArgs(["--limit", "0"]).limit).toBe(50); // max(1, 0||50)=50
    expect(parseArgs(["--limit", "-3"]).limit).toBe(1); // max(1, -3)=1
  });

  test("a flag missing its value does not crash (empty string)", () => {
    expect(parseArgs(["--ack"]).ackId).toBe("");
  });
});

describe("renderConflictRow", () => {
  const base: ConflictRow = {
    id: "11111111-2222-3333-4444-555555555555",
    detected_at: "2026-05-29T12:00:00Z",
    fact_table: "function_change_facts",
    fact_id: "abcdef01-0000-0000-0000-000000000000",
    claimed_state: "getUser → fetchUser (renamed)",
    actual_state: "fetchUser was deleted in commit deadbeef after the claimed change",
    conflict_commit: "deadbeefcafebabe1234",
    acknowledged: false,
  };

  test("renders claimed/actual with a shortened commit and fact id", () => {
    const s = renderConflictRow(base);
    expect(s).toContain("function_change_facts/abcdef01");
    expect(s).toContain("@deadbeefca"); // commit shortened to 10 chars
    expect(s).toContain("claimed: getUser → fetchUser (renamed)");
    expect(s).toContain("actual:  fetchUser was deleted");
    expect(s).not.toContain("[acknowledged]");
  });

  test("marks acknowledged rows and tolerates a null commit", () => {
    const s = renderConflictRow({ ...base, acknowledged: true, conflict_commit: null });
    expect(s).toContain("[acknowledged]");
    expect(s).not.toContain("@"); // no commit suffix when null
  });

  test("truncates very long state with an ellipsis", () => {
    const s = renderConflictRow({ ...base, claimed_state: "x".repeat(200) });
    const claimedLine = s.split("\n").find((l) => l.includes("claimed:"))!;
    expect(claimedLine).toContain("…");
    expect(claimedLine.length).toBeLessThan(120); // 90-cap + label, not 200
  });
});
