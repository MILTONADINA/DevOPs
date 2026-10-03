// Unit test for the create-org arg parser (the live insert is exercised by the onboarding round-trip).

import { afterEach, describe, test, expect, vi } from "vitest";
import { main, parseArgs } from "../../scripts/create-org";

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.rpc.mockReset(); db.from.mockReset(); });

describe("create-org parseArgs", () => {
  test("defaults: no name, starter plan, no key, live env", () => {
    expect(parseArgs([])).toEqual({ plan: "starter", withKey: false, env: "live" });
  });
  test("--name + --plan", () => {
    expect(parseArgs(["--name", "Acme", "--plan", "growth"])).toMatchObject({ name: "Acme", plan: "growth" });
  });
  test("REJECTS an unknown plan (fail-closed — never silently mis-tier the org's billing)", () => {
    expect(() => parseArgs(["--name", "X", "--plan", "platinum"])).toThrow(/invalid --plan/);
  });
  test("--with-key + --env test", () => {
    expect(parseArgs(["--name", "X", "--with-key", "--env", "test"])).toMatchObject({ withKey: true, env: "test" });
  });
});

describe("create-org trusted constructor (session-erasure AC-B2)", () => {
  function setup() {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:0");
    vi.stubEnv("SUPABASE_SERVICE_KEY", "synthetic-test-credential");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    db.from.mockImplementation(() => { throw new Error("generic insertion cannot grant coverage"); });
  }
  test("uses the server-minted organization operation with name and plan only", async () => {
    setup();
    db.rpc.mockResolvedValue({ data: [{ id: "10000000-0000-4000-8000-000000000001" }], error: null });
    expect(await main(["--name", "Covered local org", "--plan", "growth"])).toBe(0);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("create_managed_organization", { p_name: "Covered local org", p_plan: "growth" });
    expect(db.from).not.toHaveBeenCalled();
  });
  test("does not fall back to generic insertion when constructor fails", async () => {
    setup();
    db.rpc.mockResolvedValue({ data: null, error: { message: "constructor unavailable" } });
    await expect(main(["--name", "Local org"])).rejects.toThrow("constructor unavailable");
    expect(db.from).not.toHaveBeenCalled();
  });
  test.each([[], [{ id: "?" }], [{ id: null }]])("rejects an absent or invalid minted identity", async (data) => {
    setup();
    db.rpc.mockResolvedValue({ data, error: null });
    await expect(main(["--name", "Local org"])).rejects.toThrow("organization constructor returned no valid identity");
    expect(db.from).not.toHaveBeenCalled();
  });
});
