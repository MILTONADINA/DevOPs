// specs/security/ci-dependency-audit.md AC-6: zod >= 4.6.6 with bounded externally fed arrays.
import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSessionErasureDeps } from "../../src/proxy/session-erasure";
import { validateFact } from "../../src/memory/warm/schemas";

const ORG = "10000000-0000-4000-8000-000000000001";
const SESSION = "20000000-0000-4000-8000-000000000001";
const scope = "managed_explicit_session_v1";
const rpcClient = (data: unknown) => ({ rpc: vi.fn(async () => ({ data, error: null })) }) as unknown as SupabaseClient;

describe("zod 4 migration", () => {
  test("installed zod is at or above the patched 4.6.6", () => {
    const { version } = createRequire(import.meta.url)("zod/package.json") as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    expect(major).toBe(4);
    expect(minor > 6 || (minor === 6 && patch >= 6)).toBe(true);
  });
  test("an RPC reasons array beyond the bound is rejected", async () => {
    const blocked = (n: number) => ({ status: "blocked", scope, org_id: ORG, session_id: SESSION, reasons: Array(n).fill("coverage_unknown") });
    await expect(createSessionErasureDeps(rpcClient(blocked(1))).erase(ORG, SESSION)).resolves.toMatchObject({ status: "blocked" });
    await expect(createSessionErasureDeps(rpcClient(blocked(100_000))).erase(ORG, SESSION)).rejects.toThrow("invalid erasure preparation");
  });
  test("fact validation keeps accepting valid facts and discarding malformed ones", () => {
    const base = { id: "f1", created_at: "2026-10-26", session_id: "s1", confidence: 0.5, is_verified: false, is_suppressed: false };
    expect(validateFact({ ...base, fact_type: "Todo", description: "toy", status: "open" })).not.toBeNull();
    expect(validateFact({ ...base, fact_type: "Todo", description: "", status: "open" })).toBeNull();
    expect(validateFact({ ...base, fact_type: "Unknown" })).toBeNull();
    expect(validateFact({ ...base, fact_type: "Todo", description: "toy", status: "open", confidence: 2 })).toBeNull();
  });
  test("uuid parsing keeps accepting well-formed ids and refusing malformed ones", async () => {
    await expect(createSessionErasureDeps(rpcClient(null)).erase("not-a-uuid", SESSION)).rejects.toThrow("invalid erasure identity");
    await expect(createSessionErasureDeps(rpcClient(null)).erase(ORG.toUpperCase(), SESSION)).resolves.toBeNull();
  });
});
