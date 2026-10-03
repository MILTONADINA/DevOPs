import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErasureCoverageUnavailableError, markErasureCoverageUnknown } from "../../src/memory/erasure-coverage";

describe("specs/memory/session-erasure.md#AC-B3 — durable copy acknowledgement", () => {
  test("awaits the exact org/reason RPC acknowledgement before resolving", async () => {
    let acknowledge!: (value: { data: boolean; error: null }) => void;
    const rpc = vi.fn(() => new Promise<{ data: boolean; error: null }>((resolve) => { acknowledge = resolve; }));
    let complete = false;
    const pending = markErasureCoverageUnknown({ rpc } as unknown as SupabaseClient, "org-1", "backup_export").then(() => { complete = true; });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("mark_erasure_coverage_unknown", { p_org_id: "org-1", p_reason: "backup_export" });
    await Promise.resolve();
    expect(complete).toBe(false);
    acknowledge({ data: true, error: null });
    await pending;
    expect(complete).toBe(true);
  });

  test.each([
    ["false", { data: false, error: null }],
    ["null", { data: null, error: null }],
    ["missing data", { error: null }],
    ["missing result", undefined],
    ["truthy string", { data: "true", error: null }],
    ["array", { data: [true], error: null }],
    ["object", { data: { acknowledged: true }, error: null }],
    ["missing error field", { data: true }],
    ["SQL denial", { data: true, error: { message: "private SQL detail" } }],
  ])("rejects %s without exposing database details", async (_name, result) => {
    const client = { rpc: vi.fn().mockResolvedValue(result) } as unknown as SupabaseClient;
    const error = await markErasureCoverageUnknown(client, "org-1", "protected_read").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ErasureCoverageUnavailableError);
    expect((error as Error).message).not.toContain("private SQL detail");
  });

  test("transport rejection is a typed safe denial", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("private transport credentials"));
    const error = await markErasureCoverageUnknown({ rpc } as unknown as SupabaseClient, "org-1", "protected_read").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ErasureCoverageUnavailableError);
    expect((error as Error).message).not.toContain("private transport credentials");
  });
});
