// Unit tests for the /understand-codebase render layer + CLI arg parser (pure —
// no DB, no model, no API). The live graph/vector wiring is exercised separately
// (guarded smoke against the live Supabase project).

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderUnderstanding, renderMatches } from "../../src/memory/understand-render";
import { parseArgs, main } from "../../scripts/understand-codebase";
import type { EntityUnderstanding } from "../../src/memory/understand";
import type { VectorMatch } from "../../src/memory/cold/vectors";

const base: EntityUnderstanding = {
  name: "getUser",
  isSuperseded: false,
  supersededBy: [],
  supersedes: [],
  deprecatedBy: [],
  referencedBy: [],
};

describe("renderUnderstanding", () => {
  test("a superseded entity reports SUPERSEDED + who supersedes it", () => {
    const r = renderUnderstanding({ ...base, isSuperseded: true, supersededBy: ["fetchUser"] });
    expect(r).toContain("Entity: getUser");
    expect(r).toContain("Status: SUPERSEDED");
    expect(r).toContain("Superseded by: fetchUser");
  });

  test("a current entity with relations lists supersedes/deprecated/referenced", () => {
    const r = renderUnderstanding({
      ...base,
      name: "fetchUser",
      supersedes: ["getUser"],
      deprecatedBy: ["fetchUserV3"],
      referencedBy: ["authMiddleware"],
    });
    expect(r).toContain("Status: current");
    expect(r).toContain("Supersedes: getUser");
    expect(r).toContain("Deprecated by: fetchUserV3");
    expect(r).toContain("Referenced by: authMiddleware");
    expect(r).not.toContain("Superseded by:"); // not superseded → line omitted
  });

  test("an entity with no relations says so", () => {
    expect(renderUnderstanding(base)).toContain("(no graph relations recorded for this entity)");
  });

  test("semantic neighbours render when present", () => {
    const related: VectorMatch[] = [{ id: "v1", sourceType: "fact", sourceRef: "f-123", similarity: 0.873 }];
    const r = renderUnderstanding({ ...base, related });
    expect(r).toContain("Related (semantic):");
    expect(r).toContain("fact:f-123  (similarity 0.87)");
  });

  test("empty related list renders the em-dash, not a crash", () => {
    expect(renderUnderstanding({ ...base, related: [] })).toContain("Related (semantic): —");
  });

  test("related neighbours show resolved fact content when a content map is supplied", () => {
    const related: VectorMatch[] = [{ id: "v1", sourceType: "fact", sourceRef: "f-1", similarity: 0.8 }];
    const content = new Map([["f-1", "function getUser → fetchUser (renamed)"]]);
    const r = renderUnderstanding({ ...base, related }, content);
    expect(r).toContain("fact:f-1  (similarity 0.80) — function getUser → fetchUser (renamed)");
  });
});

describe("renderMatches (query-only mode)", () => {
  test("lists matches with similarity", () => {
    const r = renderMatches("where do we deploy?", [
      { id: "v1", sourceType: "fact", sourceRef: "f-9", similarity: 0.91 },
      { id: "v2", sourceType: "fact", sourceRef: null, similarity: 0.4 },
    ]);
    expect(r).toContain('Semantic search: "where do we deploy?"');
    expect(r).toContain("fact:f-9  (similarity 0.91)");
    expect(r).toContain("fact:?  (similarity 0.40)"); // null sourceRef → "?"
  });
  test("empty result set is reported, not silent", () => {
    expect(renderMatches("q", [])).toContain("no neighbours found");
  });
  test("resolves content-free hits to fact content when a content map is supplied", () => {
    const matches: VectorMatch[] = [
      { id: "v1", sourceType: "fact", sourceRef: "f-9", similarity: 0.91 },
      { id: "v2", sourceType: "fact", sourceRef: "f-unknown", similarity: 0.5 },
    ];
    const content = new Map([["f-9", "decision: use Supabase [db]"]]);
    const r = renderMatches("where do we deploy?", matches, content);
    expect(r).toContain("fact:f-9  (similarity 0.91) — decision: use Supabase [db]"); // resolved
    expect(r).toContain("fact:f-unknown  (similarity 0.50)"); // unresolved → bare, no trailing dash content
    expect(r).not.toContain("f-unknown  (similarity 0.50) —");
  });
});

describe("parseArgs", () => {
  test("--flag value form", () => {
    const a = parseArgs(["--org", "My Org", "--entity", "getUser"]);
    expect(a).toMatchObject({ org: "My Org", entity: "getUser", k: 5 });
  });
  test("--flag=value form", () => {
    const a = parseArgs(["--org-id=abc-123", "--query=where do we deploy", "--k=8"]);
    expect(a).toMatchObject({ orgId: "abc-123", query: "where do we deploy", k: 8 });
  });
  test("k defaults to 5 and rejects non-positive / non-numeric", () => {
    expect(parseArgs([]).k).toBe(5);
    expect(parseArgs(["--k", "0"]).k).toBe(5);
    expect(parseArgs(["--k", "x"]).k).toBe(5);
    expect(parseArgs(["--k", "12"]).k).toBe(12);
  });
  test("unknown flags are ignored", () => {
    expect(parseArgs(["--nope", "x", "--entity", "Y"])).toMatchObject({ entity: "Y" });
  });
  test("a value-less flag does NOT swallow the following flag (review finding)", () => {
    // `--entity --query auth`: entity is value-less → "", and --query still parses.
    const a = parseArgs(["--entity", "--query", "auth"]);
    expect(a.entity).toBe("");
    expect(a.query).toBe("auth");
  });
});

// Minimal Supabase stub driving exactly the calls the CLI makes:
//   .from("organizations").select("id").eq("name",_).limit(1)  → { data: org, error }
//   .rpc("entity_status"|"match_memory_vectors", _)             → { data, error }
function fakeClient(opts: { org?: { id: string }[]; entityStatus?: unknown[]; matches?: unknown[]; facts?: unknown[] }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          // org lookup: .eq("name").limit(1) → org rows
          limit: () => Promise.resolve({ data: opts.org ?? [], error: null }),
          // getFactsByRefs: .eq("org_id").in("id", refs) → fact rows (awaited, no .limit())
          in: () => Promise.resolve({ data: opts.facts ?? [], error: null }),
        }),
      }),
    }),
    rpc: (fn: string) => Promise.resolve({ data: fn === "entity_status" ? opts.entityStatus ?? [] : opts.matches ?? [], error: null }),
  } as unknown as SupabaseClient;
}

describe("main() orchestration (injected fakes — no DB, no model, no API)", () => {
  const ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV) saved[k] = process.env[k];
    process.env["SUPABASE_URL"] = "http://stub";
    process.env["SUPABASE_SERVICE_KEY"] = "stub-key";
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function run(argv: string[], deps: Parameters<typeof main>[1]): Promise<{ code: number; output: string }> {
    let output = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array): boolean => {
      output += String(s);
      return true;
    });
    try {
      const code = await main(argv, deps);
      return { code, output };
    } finally {
      spy.mockRestore();
    }
  }

  test("GATED (no Supabase env) → exit 0 + 'GATED'", async () => {
    delete process.env["SUPABASE_URL"];
    delete process.env["SUPABASE_SERVICE_KEY"];
    const { code, output } = await run([], {});
    expect(code).toBe(0);
    expect(output).toContain("GATED");
  });

  test("missing --entity/--query → usage, exit 2", async () => {
    const { code, output } = await run(["--org", "X"], { makeClient: () => fakeClient({}) });
    expect(code).toBe(2);
    expect(output).toContain("usage");
  });

  test("missing --org/--org-id → usage, exit 2", async () => {
    const { code } = await run(["--entity", "Y"], { makeClient: () => fakeClient({}) });
    expect(code).toBe(2);
  });

  test("org not found → exit 1 + clear message", async () => {
    const { code, output } = await run(["--org", "Nope", "--entity", "getUser"], { makeClient: () => fakeClient({ org: [] }) });
    expect(code).toBe(1);
    expect(output).toContain("No organization named");
  });

  test("entity mode dispatches to understandEntity + renders status (exit 0)", async () => {
    const client = fakeClient({ org: [{ id: "o1" }], entityStatus: [{ direction: "incoming", edge_type: "SUPERSEDES", other_name: "fetchUser" }] });
    const { code, output } = await run(["--org", "X", "--entity", "getUser"], { makeClient: () => client });
    expect(code).toBe(0);
    expect(output).toContain("Status: SUPERSEDED");
    expect(output).toContain("fetchUser");
  });

  test("query-only mode dispatches to vector search + renders matches; uses injected encode (no model download)", async () => {
    const client = fakeClient({ matches: [{ id: "v1", source_type: "fact", source_ref: "f-1", similarity: 0.9 }] });
    let encoded = "";
    const { code, output } = await run(["--org-id", "o1", "--query", "where deploy"], {
      makeClient: () => client,
      encode: (t) => {
        encoded = t;
        return Promise.resolve(new Array(384).fill(0));
      },
    });
    expect(code).toBe(0);
    expect(encoded).toBe("where deploy"); // the injected encoder was used, not the real ONNX one
    expect(output).toContain("Semantic search");
    expect(output).toContain("fact:f-1");
  });
});
