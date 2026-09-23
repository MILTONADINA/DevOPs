// Unit test for the api-keys management script's arg parser. The live list/revoke is
// exercised by the create→list→revoke→resolve round-trip (see the commit's notes).

import { describe, test, expect } from "vitest";
import { parseArgs } from "../../scripts/api-keys";

describe("api-keys parseArgs", () => {
  test("defaults: no org, not list, no revoke", () => {
    expect(parseArgs([])).toEqual({ list: false });
  });
  test("--list", () => {
    expect(parseArgs(["--org-id", "o1", "--list"])).toEqual({ orgId: "o1", list: true });
  });
  test("--revoke <id>", () => {
    expect(parseArgs(["--org-id", "o1", "--revoke", "k1"])).toMatchObject({ orgId: "o1", revoke: "k1" });
  });
  test("a flag missing its value does not crash", () => {
    expect(parseArgs(["--revoke"]).revoke).toBe("");
  });
});
