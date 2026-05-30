// Unit test for the invoice runner's arg parser (pure seam). The live read +
// gated --send are exercised by `npm run invoice` against the DB.

import { describe, test, expect } from "vitest";
import { parseArgs } from "../../scripts/invoice";

describe("invoice parseArgs", () => {
  test("defaults: no org/since/until/csv, send false", () => {
    expect(parseArgs([])).toEqual({ send: false });
  });
  test("parses all flags", () => {
    expect(parseArgs(["--org-id", "o1", "--since", "2026-05-01", "--until", "2026-05-31", "--csv", "/tmp/a.csv", "--send"])).toEqual({
      orgId: "o1",
      since: "2026-05-01",
      until: "2026-05-31",
      csv: "/tmp/a.csv",
      send: true,
    });
  });
  test("a flag missing its value does not crash", () => {
    expect(parseArgs(["--org-id"]).orgId).toBe("");
  });
});
