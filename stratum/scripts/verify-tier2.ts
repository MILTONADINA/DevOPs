/**
 * Verify the Tier-2 warm-memory adapter against the LIVE Supabase project
 * (MANUAL / gated). Creates a throwaway org + session, persists one fact of each
 * of the 5 types via createWarmMemory, reads them back with queryRecent, asserts
 * the round-trip (incl. trusted-FK override), then deletes everything it created.
 *
 *   npm run verify-tier2
 *
 * GATED: needs SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment (.env). With
 * no credentials it SKIPs cleanly (exit 0) — the adapter's pure logic is covered
 * credential-free by test/memory/tier2.test.ts.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createWarmMemory, FACT_TABLES } from "../src/memory/warm/tier2";
import type { AnyFact } from "../src/types/facts";

export async function main(): Promise<number> {
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) {
    out("SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — the live Tier-2 round-trip is gated on credentials.");
    out("      The adapter's pure projection + persist/query logic is covered by test/memory/tier2.test.ts (no creds needed).");
    return 0;
  }

  const client = createClient(url, key);
  const wm = createWarmMemory(client);

  // 1) Trusted FKs: a real organizations row + sessions row.
  const orgRes = await client.from("organizations").insert({ name: "Tier2 Verify Org" }).select("id").single();
  if (orgRes.error || !orgRes.data) {
    out(`FAIL: could not create org — ${orgRes.error?.message}`);
    return 1;
  }
  const orgId = orgRes.data.id as string;
  const sessRes = await client.from("sessions").insert({ org_id: orgId, model: "claude-opus-4-8" }).select("id").single();
  if (sessRes.error || !sessRes.data) {
    out(`FAIL: could not create session — ${sessRes.error?.message}`);
    await client.from("organizations").delete().eq("id", orgId);
    return 1;
  }
  const sessionId = sessRes.data.id as string;

  // 2) One fact of each type. session_id here is a LOGICAL label the trusted ctx
  //    must override with the real sessions(id) FK.
  const nowIso = new Date().toISOString();
  const baseFact = { created_at: nowIso, session_id: "logical-label", confidence: 0.8, is_verified: false, is_suppressed: false } as const;
  const facts: AnyFact[] = [
    { ...baseFact, id: randomUUID(), fact_type: "FunctionChange", old_name: "getUser", new_name: "fetchUser", change_type: "renamed" },
    { ...baseFact, id: randomUUID(), fact_type: "TechDecision", decision_text: "use Cloudflare Workers", domain: "deploy" },
    { ...baseFact, id: randomUUID(), fact_type: "PolicyUpdate", policy_name: "pii-redaction", new_value: "fail-closed", policy_type: "security" },
    { ...baseFact, id: randomUUID(), fact_type: "Todo", description: "ship tier-2 adapter", status: "open" },
    { ...baseFact, id: randomUUID(), fact_type: "VariableChange", var_name: "MAX_INPUT_CHARS", new_value: "1200" },
  ];

  let exitCode = 0;
  try {
    const result = await wm.persist(facts, { orgId, sessionId });
    const got = await wm.queryRecent(orgId, { sessionId });
    const gotTypes = new Set(got.map((f) => f.fact_type));

    const checks: { name: string; ok: boolean; detail: string }[] = [
      { name: "persist wrote all 5 facts", ok: result.persisted === 5, detail: `persisted=${result.persisted}` },
      { name: "no facts skipped (all valid)", ok: result.skipped === 0, detail: `skipped=${result.skipped}` },
      { name: "no per-table DB errors", ok: result.errors.length === 0, detail: JSON.stringify(result.errors) },
      { name: "queryRecent returned all 5", ok: got.length === 5, detail: `count=${got.length}` },
      { name: "all 5 fact types round-tripped", ok: gotTypes.size === 5, detail: `types=${[...gotTypes].sort().join(",")}` },
      { name: "trusted session FK overrode the logical label", ok: got.length > 0 && got.every((f) => f.session_id === sessionId), detail: `every session_id === ${sessionId}` },
    ];

    out("");
    for (const ch of checks) out(`  ${ch.ok ? "✓" : "✗"} ${ch.name} — ${ch.detail}`);
    const passed = checks.every((ch) => ch.ok);
    out("");
    out(passed ? "RESULT: PASS — live Tier-2 round-trip verified." : "RESULT: FAIL — see checks above.");
    exitCode = passed ? 0 : 1;
  } catch (err) {
    out(`FAIL: round-trip threw — ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    // 3) Clean up everything created (FK order: facts → session → org).
    for (const table of Object.values(FACT_TABLES)) {
      await client.from(table).delete().eq("session_id", sessionId);
    }
    await client.from("sessions").delete().eq("id", sessionId);
    await client.from("organizations").delete().eq("id", orgId);
    out("→ cleaned up throwaway org/session/facts.");
  }
  return exitCode;
}

const entryPath = process.argv[1] ?? "";
if (entryPath.endsWith("verify-tier2.ts") || entryPath.endsWith("verify-tier2.js")) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
