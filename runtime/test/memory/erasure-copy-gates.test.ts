import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { exportOrg, ORG_SCOPED_TABLES } from "../../scripts/backup-org";

const readers: [string, string, (client: SupabaseClient) => Promise<unknown>][] = [
  ["queryRecent", "protected_read", (client) => createWarmMemory(client).queryRecent("org-1")],
  ["queryUnpromoted", "protected_read", (client) => createWarmMemory(client).queryUnpromoted("org-1")],
  ["getFactsByRefs", "protected_read", (client) => createWarmMemory(client).getFactsByRefs("org-1", ["fact-1"])],
  ["exportOrg", "backup_export", (client) => exportOrg(client, "org-1", "2026-10-03T00:00:00Z")],
];

function protectedClient(result: unknown) {
  let acknowledged = false;
  const rpc = vi.fn(async () => { acknowledged = (result as { data?: unknown } | undefined)?.data === true; return result; });
  const from = vi.fn(() => {
    expect(acknowledged, "protected read dispatched before acknowledgement").toBe(true);
    const empty = { data: [], error: null, count: 0 };
    const q = {
      select: () => q, eq: () => q, is: () => q, in: () => q, lt: () => q, order: () => q,
      limit: async () => empty, range: async () => empty,
      then: (resolve: (value: typeof empty) => void) => resolve(empty),
    };
    return q;
  });
  return { rpc, from, client: { rpc, from } as unknown as SupabaseClient };
}

describe("specs/memory/session-erasure.md#AC-B3 — copy gate before every protected read", () => {
  test.each(readers)("%s refuses denied acknowledgement with zero protected dispatch", async (_name, _reason, read) => {
    const { client, from } = protectedClient({ data: false, error: null });
    await expect(read(client)).rejects.toThrow(/erasure coverage/i);
    expect(from).not.toHaveBeenCalled();
  });

  test.each(readers)("%s waits for the pending durable marker", async (_name, reason, read) => {
    let acknowledge!: (value: { data: boolean; error: null }) => void;
    const from = vi.fn(() => { throw new Error("protected-read-sentinel"); });
    const rpc = vi.fn(() => new Promise<{ data: boolean; error: null }>((resolve) => { acknowledge = resolve; }));
    const pending = read({ rpc, from } as unknown as SupabaseClient);
    const terminal = pending.catch((error: unknown) => error);
    await Promise.resolve();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: "org-1", p_reason: reason });
    acknowledge({ data: true, error: null });
    expect((await terminal as Error).message).toContain("protected-read-sentinel");
    expect(from).toHaveBeenCalled();
  });

  test.each(readers)("%s reads normally only after a valid acknowledgement", async (name, reason, read) => {
    const { client, rpc, from } = protectedClient({ data: true, error: null });
    await read(client);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: "org-1", p_reason: reason });
    expect(from).toHaveBeenCalledTimes(name === "exportOrg" ? ORG_SCOPED_TABLES.length + 1 : 6);
  });

  test("empty fact references perform neither a protected read nor an uncertainty write", async () => {
    const rpc = vi.fn();
    const from = vi.fn();
    const result = await createWarmMemory({ rpc, from } as unknown as SupabaseClient).getFactsByRefs("org-1", []);
    expect(result.size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});
