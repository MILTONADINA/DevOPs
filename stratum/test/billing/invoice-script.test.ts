// Unit test for the invoice runner's arg parser (pure seam). The live read +
// gated --send are exercised by `npm run invoice` against the DB.

import { describe, test, expect, vi, afterEach } from "vitest";
import { main, parseArgs } from "../../scripts/invoice";

afterEach(() => vi.unstubAllEnvs());

test("missing explicit database credentials fail before billing or Stripe access", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
  expect(await main(["--org-id", "00000000-0000-4000-8000-000000000001", "--since", "2026-05-01", "--until", "2026-06-01", "--send"])).toBe(1);
});

test("sending without exact increasing bounds refuses before credential or database access", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "");
  const base = ["--org-id", "00000000-0000-4000-8000-000000000001", "--send"];
  expect(await main(base)).toBe(2);
  expect(await main([...base, "--since", "2026-06-01", "--until", "2026-05-01"])).toBe(2);
  expect(await main([...base, "--since", "bad", "--until", "2026-06-01"])).toBe(2);
});

test("--force cannot bypass period dedup before credential or database access", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "");
  expect(await main(["--org-id", "00000000-0000-4000-8000-000000000001", "--since", "2026-05-01", "--until", "2026-06-01", "--send", "--force"])).toBe(2);
});

test("a missing Stripe test key refuses before taking a durable claim", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  expect(await main(["--org-id", "00000000-0000-4000-8000-000000000001", "--since", "2026-05-01", "--until", "2026-06-01", "--send"])).toBe(2);
});

describe("invoice parseArgs", () => {
  test("defaults: no org/since/until/csv, send + force false", () => {
    expect(parseArgs([])).toEqual({ send: false, force: false });
  });
  test("parses all flags", () => {
    expect(parseArgs(["--org-id", "o1", "--since", "2026-05-01", "--until", "2026-05-31", "--csv", "/tmp/a.csv", "--send", "--force"])).toEqual({
      orgId: "o1",
      since: "2026-05-01",
      until: "2026-05-31",
      csv: "/tmp/a.csv",
      send: true,
      force: true,
    });
  });
  test("--force defaults false when absent (dedup guard active)", () => {
    expect(parseArgs(["--org-id", "o1", "--send"]).force).toBe(false);
  });
  test("a flag missing its value does not crash", () => {
    expect(parseArgs(["--org-id"]).orgId).toBe("");
  });
});
