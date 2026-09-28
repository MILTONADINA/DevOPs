// Unit tests for the Tier-2 session/org resolver (createSessionStore) against
// the fake Supabase client (no creds). The live SQL semantics are separately
// verified via the Supabase MCP + scripts/verify-tier2.ts.

import { describe, test, expect } from "vitest";
import { createSessionStore } from "../../src/memory/warm/sessions";
import { makeFakeSupabase } from "./fake-supabase";

describe("session/org resolver", () => {
  test("ensureOrg creates a new org when absent and returns its id", async () => {
    const { client, store } = makeFakeSupabase();
    const ss = createSessionStore(client);
    const id = await ss.ensureOrg("Acme");
    expect(id).toBeTruthy();
    expect(store["organizations"]).toHaveLength(1);
    expect(store["organizations"]![0]!["name"]).toBe("Acme");
  });

  test("ensureOrg returns the EXISTING org id (no duplicate) for the same name", async () => {
    const { client, store } = makeFakeSupabase();
    const ss = createSessionStore(client);
    const a = await ss.ensureOrg("Acme");
    const b = await ss.ensureOrg("Acme");
    expect(b).toBe(a);
    expect(store["organizations"]).toHaveLength(1); // get-branch, not a second insert
  });

  test("createSession writes org_id+model and includes dial params ONLY when provided", async () => {
    const { client, store } = makeFakeSupabase();
    const ss = createSessionStore(client);
    const sid = await ss.createSession({ orgId: "org-1", model: "claude-opus-4-8", lambda: 0.95 });
    expect(sid).toBeTruthy();
    const row = store["sessions"]![0]!;
    expect(row["org_id"]).toBe("org-1");
    expect(row["model"]).toBe("claude-opus-4-8");
    expect(row["lambda"]).toBe(0.95);
    expect("gain_shift" in row).toBe(false); // omitted → DB default applies
    expect("theta" in row).toBe(false);
  });

  test("endSession sets ended_at (injected clock) on the matching row", async () => {
    const { client, store } = makeFakeSupabase({ sessions: [{ id: "s1", org_id: "o1", model: "m" }] });
    const ss = createSessionStore(client, { now: () => "2026-05-29T12:00:00Z" });
    await ss.endSession("s1");
    expect(store["sessions"]![0]!["ended_at"]).toBe("2026-05-29T12:00:00Z");
  });

  test("ensureOrg throws (FAIL-LOUD) when the select errors", async () => {
    const { client } = makeFakeSupabase({}, { selectError: new Set(["organizations"]) });
    const ss = createSessionStore(client);
    await expect(ss.ensureOrg("Acme")).rejects.toThrow(/ensureOrg select failed/);
  });

  test("createSession throws when the insert errors", async () => {
    const { client } = makeFakeSupabase({}, { insertError: new Set(["sessions"]) });
    const ss = createSessionStore(client);
    await expect(ss.createSession({ orgId: "o1", model: "m" })).rejects.toThrow(/createSession failed/);
  });
});
