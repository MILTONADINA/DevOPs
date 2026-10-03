import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "../../scripts/audit-conflicts";
import { ErasureCoverageUnavailableError } from "../../src/memory/erasure-coverage";

const { makeClient } = vi.hoisted(() => ({ makeClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: makeClient }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONFLICT = "22222222-2222-4222-8222-222222222222";
const row = {
  id: CONFLICT,
  detected_at: "2026-10-03T12:00:00Z",
  fact_table: "function_change_facts",
  fact_id: "33333333-3333-4333-8333-333333333333",
  claimed_state: "private claimed state",
  actual_state: "private actual state",
  conflict_commit: null,
  acknowledged: false,
};

function fakeClient() {
  const calls: unknown[][] = [];
  const rpc = vi.fn(async (name: string, args: unknown) => {
    calls.push(["rpc", name, args]);
    return { data: true, error: null };
  });
  const from = vi.fn((table: string) => {
    calls.push(["from", table]);
    const query = {
      select(columns: string) {
        calls.push(["select", columns]);
        return query;
      },
      update(values: unknown) {
        calls.push(["update", values]);
        return query;
      },
      eq(column: string, value: unknown) {
        calls.push(["eq", column, value]);
        return query;
      },
      order(column: string, value: unknown) {
        calls.push(["order", column, value]);
        return query;
      },
      limit(value: number) {
        calls.push(["limit", value]);
        return query;
      },
      then(resolve: (result: { data: (typeof row)[]; error: null }) => unknown) {
        return Promise.resolve({ data: [row], error: null }).then(resolve);
      },
    };
    return query;
  });
  const client = { rpc, from };
  makeClient.mockReturnValue(client);
  return { ...client, calls };
}

beforeEach(() => {
  makeClient.mockReset();
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_SERVICE_KEY", "fixture-service-key");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("audit conflict CLI copy boundary", () => {
  test.each([{ argv: [] }, { argv: ["--all"] }, { argv: ["--org-id", ""] }])("requires organization before creating a client: $argv", async ({ argv }) => {
    fakeClient();
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_KEY", undefined);
    expect(await main(argv)).toBe(1);
    expect(makeClient).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("--org-id"));
  });

  test("a scoped command retains the no-credentials skip", async () => {
    vi.stubEnv("SUPABASE_SERVICE_KEY", undefined);
    expect(await main(["--org-id", ORG])).toBe(0);
    expect(makeClient).not.toHaveBeenCalled();
  });

  test.each(["false", "error", "throw"])("denied marker %s reads and prints no protected content", async (failure) => {
    const { rpc, from } = fakeClient();
    if (failure === "throw") rpc.mockRejectedValueOnce(new Error("private database detail"));
    else rpc.mockResolvedValueOnce({ data: false, error: failure === "error" ? { message: "private database detail" } : null } as never);
    await expect(main(["--org-id", ORG])).rejects.toBeInstanceOf(ErasureCoverageUnavailableError);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
    expect(from).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  test.each([false, true])("awaits marker then preserves scoped listing, all=%s", async (all) => {
    const { rpc, from, calls } = fakeClient();
    let release!: (result: { data: boolean; error: null }) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const operation = main(["--org-id", ORG, "--limit", "20", ...(all ? ["--all"] : [])]);
    try {
      expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: ORG, p_reason: "protected_read" });
      expect(from).not.toHaveBeenCalled();
      expect(process.stdout.write).not.toHaveBeenCalled();
    } finally {
      release?.({ data: true, error: null });
    }
    expect(await operation).toBe(0);
    expect(calls).toContainEqual(["eq", "org_id", ORG]);
    expect(calls).toContainEqual(["limit", 20]);
    expect(calls).toContainEqual(["order", "detected_at", { ascending: false }]);
    expect(calls.some((call) => call[0] === "eq" && call[1] === "acknowledged")).toBe(!all);
    if (!all) expect(calls).toContainEqual(["eq", "acknowledged", false]);
    const output = vi.mocked(process.stdout.write).mock.calls.flat().join(" ");
    expect(output).toContain(row.claimed_state);
    expect(output).toContain(row.actual_state);
    expect(output).toContain(`--org-id ${ORG} --ack ${CONFLICT}`);
  });

  test("acknowledgement stays scoped and does not copy conflict content", async () => {
    const { rpc, calls } = fakeClient();
    expect(await main(["--org-id", ORG, "--ack", CONFLICT, "--by", "operator"])).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(calls).toContainEqual(["eq", "org_id", ORG]);
    expect(calls).toContainEqual(["eq", "id", CONFLICT]);
    expect(calls).toContainEqual(["select", "id"]);
    expect(calls).toContainEqual(["update", expect.objectContaining({ acknowledged: true, acknowledged_by: "operator" })]);
    const output = vi.mocked(process.stdout.write).mock.calls.flat().join(" ");
    expect(output).not.toContain(row.claimed_state);
    expect(output).not.toContain(row.actual_state);
  });
});
