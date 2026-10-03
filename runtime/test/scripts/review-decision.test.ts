import { afterEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inspectDecisionPair, main, parseReviewArgs, reviewDecisionPair, validLocalApiOrigin } from "../../scripts/review-decision";

import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";

const ORG = "11111111-1111-4111-8111-111111111111";
const OLDER = "22222222-2222-4222-8222-222222222222";
const NEWER = "33333333-3333-4333-8333-333333333333";
const args = ["--org-id", ORG, "--project-scope", "orion", "--older-id", OLDER, "--newer-id", NEWER];
const env = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_KEY: "fixture-service-key" };
const row = (id: string, day: number, change: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG,
  project_scope: "orion",
  decision_text: id === OLDER ? "Use MongoDB" : "Use PostgreSQL",
  domain: "database",
  created_at: `2026-09-${day}T00:00:00Z`,
  is_suppressed: false,
  supersedes_id: null,
  supersession_reviewed_at: null,
  ...change,
});

function fakeClient(rows = [row(OLDER, 20), row(NEWER, 24)], rpcError = false): { client: SupabaseClient; calls: unknown[][]; rpc: ReturnType<typeof vi.fn> } {
  const calls: unknown[][] = [];
  const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
    calls.push(["rpc", name, input]);
    if (name === "mark_erasure_coverage_unknown") {
      expect(input).toEqual({ p_org_id: ORG, p_reason: "protected_read" });
      return { data: true, error: null };
    }
    if (rpcError) return { data: null, error: { message: "write rejected" } };
    const newer = rows.find((entry) => entry.id === input["newer_id"]);
    if (newer) {
      newer.supersedes_id = input["older_id"] as null;
      newer.supersession_reviewed_at = "2026-09-24T12:00:00Z" as null;
    }
    return { data: input["newer_id"], error: null };
  });
  const client = {
    from: (table: string) => {
      expect(table).toBe("tech_decisions");
      const filters: Array<(value: (typeof rows)[number]) => boolean> = [];
      const query = {
        select: (columns: string) => {
          calls.push(["select", columns]);
          return query;
        },
        eq: (column: string, value: unknown) => {
          calls.push(["eq", column, value]);
          filters.push((entry) => (entry as Record<string, unknown>)[column] === value);
          return query;
        },
        is: (column: string, value: unknown) => {
          calls.push(["is", column, value]);
          filters.push((entry) => (entry as Record<string, unknown>)[column] === value);
          return query;
        },
        in: (column: string, values: unknown[]) => {
          calls.push(["in", column, values]);
          filters.push((entry) => values.includes((entry as Record<string, unknown>)[column]));
          return query;
        },
        limit: (count: number) => {
          calls.push(["limit", count]);
          return query;
        },
        then: (resolve: (value: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve({ data: rows.filter((entry) => filters.every((filter) => filter(entry))), error: null }).then(resolve),
      };
      return query;
    },
    rpc,
  } as unknown as SupabaseClient;
  return { client, calls, rpc };
}

afterEach(() => vi.restoreAllMocks());

describe("reviewed decision operator", () => {
  test("validates exact local binding before a client is created", async () => {
    expect(parseReviewArgs(args)).toMatchObject({ orgId: ORG, projectScope: "orion", olderId: OLDER, newerId: NEWER, apply: false });
    expect(parseReviewArgs(["--org-id", ORG, "--unbound", "--older-id", OLDER, "--newer-id", NEWER]).projectScope).toBeNull();
    for (const url of ["https://127.0.0.1:54321", "http://localhost:54321", "http://127.0.0.1:54321/rest/v1", "http://u@127.0.0.1:54321", "http://127.0.0.1:0"]) {
      expect(validLocalApiOrigin(url)).toBe(false);
    }
    expect(validLocalApiOrigin(env.SUPABASE_URL)).toBe(true);
    expect(() => parseReviewArgs([...args, "--unbound"])).toThrow();
    expect(() => parseReviewArgs([...args, "--newer-id", OLDER])).toThrow();
    expect(() => parseReviewArgs([...args, "--apply"])).toThrow(/reviewer/);
    const makeClient = vi.fn();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(args, { ...env, SUPABASE_URL: "http://example.com" }, { makeClient })).toBe(1);
    expect(makeClient).not.toHaveBeenCalled();
  });

  test("previews exact active ordered decisions without changing reviewed links", async () => {
    const { client, calls, rpc } = fakeClient();
    const output: string[] = [];
    expect(await main(args, env, { makeClient: () => client, out: (line) => output.push(line) })).toBe(0);
    expect(output[0]).toContain("Use PostgreSQL");
    expect(output[1]).toContain("preview only");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
    expect(calls).toContainEqual(["eq", "org_id", ORG]);
    expect(calls).toContainEqual(["eq", "project_scope", "orion"]);
  });

  test("rejects suppressed, older, foreign, and already-linked pairs before supersession RPC", async () => {
    const variants = [
      [row(OLDER, 20, { is_suppressed: true }), row(NEWER, 24)],
      [row(OLDER, 24), row(NEWER, 20)],
      [row(OLDER, 20), row(NEWER, 24, { project_scope: "vega" })],
      [row(OLDER, 20), row(NEWER, 24), row("44444444-4444-4444-8444-444444444444", 25, { supersedes_id: OLDER })],
    ];
    for (const rows of variants) {
      const { client, rpc } = fakeClient(rows);
      await expect(inspectDecisionPair(client, parseReviewArgs(args))).rejects.toThrow();
      expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
    }
  });

  test("requires explicit evidence and verifies one reviewed write without echoing it", async () => {
    const { client, rpc } = fakeClient();
    const output: string[] = [];
    const reviewer = "Milton";
    const evidence = "Reviewed the documented migration from MongoDB to PostgreSQL.";
    const makeClient = vi.fn(() => client);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main([...args, "--apply", "--reviewer", reviewer], env, { makeClient, readEvidence: () => "too short", out: (line) => output.push(line) })).toBe(1);
    expect(makeClient).not.toHaveBeenCalled();
    expect(await main([...args, "--apply", "--reviewer", reviewer], env, { makeClient, readEvidence: () => evidence, out: (line) => output.push(line) })).toBe(0);
    const writes = rpc.mock.calls.filter(([name]) => name === "review_tech_decision_supersession");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toEqual({ match_org: ORG, match_project_scope: "orion", newer_id: NEWER, older_id: OLDER, reviewer, evidence });
    expect(output.at(-1)).toContain("reviewedAt");
    expect(output.join(" ")).not.toContain(evidence);
    expect(output.join(" ")).not.toContain(env.SUPABASE_SERVICE_KEY);
  });

  test("fails closed on RPC rejection", async () => {
    const { client } = fakeClient(undefined, true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main([...args, "--apply", "--reviewer", "Milton"], env, { makeClient: () => client, readEvidence: () => "Documented and reviewed migration evidence." })).toBe(1);
  });
});

describe("decision review copy boundary", () => {
  test("inspect waits for marker before pair and successor queries", async () => {
    const { client, calls, rpc } = fakeClient();
    let release!: (result: { data: boolean; error: null }) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const operation = inspectDecisionPair(client, parseReviewArgs(args));
    try {
      expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
      expect(calls).toEqual([]);
    } finally {
      release?.({ data: true, error: null });
    }
    const pair = await operation;
    expect(pair.older.decision_text).toBe("Use MongoDB");
    expect(pair.newer.decision_text).toBe("Use PostgreSQL");
    expect(calls.filter(([kind]) => kind === "select")).toHaveLength(2);
    expect(calls).toContainEqual(["eq", "supersedes_id", OLDER]);
  });

  test.each(["inspect", "review"])("direct %s denial performs no protected query or link write", async (entry) => {
    const { client, calls, rpc } = fakeClient();
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const parsed = parseReviewArgs([...args, "--apply", "--reviewer", "Milton"]);
    const operation = entry === "inspect" ? inspectDecisionPair(client, parsed) : reviewDecisionPair(client, parsed, "Reviewed concrete migration evidence.");
    await expect(operation).rejects.toBeInstanceOf(ErasureCoverageUnavailableError);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
    expect(calls).toEqual([]);
  });

  test.each([false, true])("CLI denial emits no retained pair or fallback, apply=%s", async (apply) => {
    const { client, calls, rpc } = fakeClient();
    rpc.mockRejectedValueOnce(new Error("private database detail"));
    const output = vi.fn();
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await main([...args, ...(apply ? ["--apply", "--reviewer", "Milton"] : [])], env, {
        makeClient: () => client,
        readEvidence: () => "Reviewed concrete migration evidence.",
        out: output,
      }),
    ).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledExactlyOnceWith("review-decision failed: Session erasure coverage could not be invalidated\n");
  });

  test("direct review waits before mutation and keeps scoped verification", async () => {
    const { client, calls, rpc } = fakeClient();
    let release!: (result: { data: boolean; error: null }) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const parsed = parseReviewArgs([...args, "--apply", "--reviewer", "Milton"]);
    const operation = reviewDecisionPair(client, parsed, "Reviewed concrete migration evidence.");
    // Keep a failed ordering assertion from leaving the baseline write rejection unhandled.
    void operation.catch(() => undefined);
    try {
      expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
      expect(calls).toEqual([]);
    } finally {
      release?.({ data: true, error: null });
    }
    expect(await operation).toBe("2026-09-24T12:00:00Z");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["mark_erasure_coverage_unknown", "review_tech_decision_supersession"]);
    expect(calls).toContainEqual(["select", "id,supersedes_id,supersession_reviewed_at"]);
    expect(calls).toContainEqual(["eq", "org_id", ORG]);
    expect(calls).toContainEqual(["eq", "project_scope", "orion"]);
  });
});
