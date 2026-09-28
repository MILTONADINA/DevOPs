import { describe, expect, test } from "vitest";
import { parseBoundArgs, runBoundUnderstand, type BoundOptions } from "../../scripts/understand-codebase-bound";

const bound: BoundOptions = {
  projectRoot: "/project",
  boundRoot: "/project",
  orgId: "11111111-1111-4111-8111-111111111111",
  supabaseUrl: "http://127.0.0.1:54321",
  serviceKey: "secret",
  allowlistText: "127.0.0.1\n",
};

describe("bound understand-codebase", () => {
  test("passes only the trusted org and requested read options", async () => {
    const calls: string[][] = [];
    const code = await runBoundUnderstand(bound, ["--entity", "getUser", "--query", "auth flow", "--k", "8"], async (args) => {
      calls.push(args);
      return 0;
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["--org-id", bound.orgId, "--entity", "getUser", "--query", "auth flow", "--k", "8"]]);
  });

  test("rejects untrusted binding before CLI invocation", async () => {
    for (const change of [
      { boundRoot: "/other" },
      { orgId: "wrong" },
      { supabaseUrl: "http://localhost:54321" },
      { serviceKey: "" },
      { allowlistText: "github.com\n" },
    ]) {
      let calls = 0;
      const code = await runBoundUnderstand({ ...bound, ...change }, ["--entity", "x"], async () => { calls++; return 0; });
      expect(code).not.toBe(0);
      expect(calls).toBe(0);
    }
  });

  test("rejects caller organization and unknown options", () => {
    expect(() => parseBoundArgs(["--org-id", "foreign", "--query", "x"])).toThrow();
    expect(() => parseBoundArgs(["--org", "foreign", "--query", "x"])).toThrow();
    expect(() => parseBoundArgs(["--unexpected", "x"])).toThrow();
    expect(() => parseBoundArgs(["--query", ""])).toThrow();
  });
});
