// Integration test: the v0.5.x Tier-2 warm-memory WRITE PATH composes end-to-end
// with NO credentials and NO real model — evicted turns → fact extraction (fake
// completion) → trusted-FK resolution (session store) → persist → queryRecent.
// Proves the three warm-tier pieces (extractor, session resolver, adapter) fit
// together; the live equivalent is scripts/verify-tier2.ts (gated on the key).

import { describe, test, expect } from "vitest";
import { createSessionStore } from "../../src/memory/warm/sessions";
import { createWarmMemory } from "../../src/memory/warm/tier2";
import { createFactExtractor, type FactCompletion } from "../../src/memory/warm/extractor";
import { makeFakeSupabase } from "./fake-supabase";

describe("Tier-2 warm-memory write path (end-to-end, no creds/model)", () => {
  test("evict → extract(fake) → resolve FKs → persist → queryRecent", async () => {
    const { client, store } = makeFakeSupabase();

    // 1) Resolve trusted FKs (the server-side half of ADR-0012's forgery model).
    const sessions = createSessionStore(client);
    const orgId = await sessions.ensureOrg("Pipeline Org");
    const sessionId = await sessions.createSession({ orgId, model: "claude-opus-4-8" });
    expect(orgId).toBeTruthy();
    expect(sessionId).toBeTruthy();

    // 2) Extract durable facts from evicted turns via a FAKE completion (no model).
    //    Includes an invalid record the extractor must drop (FAIL-CLOSED).
    let seq = 0;
    const fake: FactCompletion = {
      complete: () =>
        Promise.resolve(
          '[{"fact_type":"TechDecision","decision_text":"use Cloudflare Workers","domain":"deploy","confidence":0.95},' +
            '{"fact_type":"Todo","description":"ship tier-2","status":"open","confidence":0.8},' +
            '{"fact_type":"Nonsense"}]',
        ),
    };
    const extractor = createFactExtractor(fake, {
      now: () => "2026-05-29T00:00:00Z",
      mintId: () => `aaaaaaaa-aaaa-aaaa-aaaa-00000000000${++seq}`,
    });
    const facts = await extractor.extract({ session_id: "logical-label", turns: [{ role: "user", content: "deploy on cloudflare workers; todo: ship tier-2" }] });
    expect(facts).toHaveLength(2); // the Nonsense entry is discarded

    // 3) Persist with the RESOLVED trusted FKs (override the fact's logical session).
    const warm = createWarmMemory(client);
    const result = await warm.persist(facts, { orgId, sessionId });
    expect(result).toEqual({ persisted: 2, skipped: 0, errors: [] });

    // 4) Read back: both facts, org+session scoped, with the trusted session FK.
    const got = await warm.queryRecent(orgId, { sessionId });
    expect(got).toHaveLength(2);
    expect(new Set(got.map((f) => f.fact_type))).toEqual(new Set(["TechDecision", "Todo"]));
    expect(got.every((f) => f.session_id === sessionId)).toBe(true);

    // physical placement: each fact in its per-type table under the resolved org
    expect(store["tech_decisions"]).toHaveLength(1);
    expect(store["todos"]).toHaveLength(1);
    expect(store["tech_decisions"]![0]!["org_id"]).toBe(orgId);
    expect(store["tech_decisions"]![0]!["session_id"]).toBe(sessionId);
  });
});
