// Unit tests for createSupabaseMessageMemoryRecorder with every collaborator mocked: identity/scope
// validation fails closed BEFORE any write, the legacy session insert is checked, and audited facts are
// stored suppressed, then released only when they are not CONFLICTs. Synthetic data only.

import { describe, test, expect, vi, beforeEach } from "vitest";

const resolveConversation = vi.fn();
const persist = vi.fn();
const indexRepository = vi.fn();
const persistAuditResults = vi.fn();

vi.mock("../../src/proxy/conversation", () => ({ createSupabaseConversationResolver: () => resolveConversation }));
vi.mock("../../src/memory/warm/tier2", async (orig) => ({ ...(await orig<typeof import("../../src/memory/warm/tier2")>()), createWarmMemory: () => ({ persist }) }));
vi.mock("../../src/audit/git-indexer", () => ({ indexRepository: (...a: unknown[]) => indexRepository(...a) }));
const statusById: Record<string, string> = {};
vi.mock("../../src/audit/audit-engine", () => ({
  auditFacts: (facts: { id: string }[]) => facts.map((fact) => ({ fact, result: { status: statusById[fact.id] ?? "VERIFIED" } })),
  persistAuditResults: (...a: unknown[]) => persistAuditResults(...a),
}));

import { createSupabaseMessageMemoryRecorder } from "../../src/proxy/message-memory";
import type { MessageMemoryEvent } from "../../src/proxy/forward";
import type { FactExtractor } from "../../src/memory/warm/extractor";

type Insert = { data: { id: string }[] | null; error: { message: string } | null };

/** Minimal Supabase stand-in recording inserts and fact-release updates. */
function fakeClient(opts: { insert?: Insert; released?: { data: unknown[] | null; error: { message: string } | null } } = {}) {
  const calls = { inserts: [] as { table: string; row: unknown }[], updates: [] as { table: string; patch: unknown; eq: [string, unknown][] }[] };
  const client = {
    from(table: string) {
      return {
        insert(row: unknown) {
          calls.inserts.push({ table, row });
          return { select: () => ({ limit: async () => opts.insert ?? { data: [{ id: "sess-new" }], error: null } }) };
        },
        update(patch: unknown) {
          const rec = { table, patch, eq: [] as [string, unknown][] };
          calls.updates.push(rec);
          const chain = {
            eq(col: string, val: unknown) {
              rec.eq.push([col, val]);
              return chain;
            },
            select: async () => opts.released ?? { data: [{ id: "x" }], error: null },
          };
          return chain;
        },
      };
    },
  };
  return { client: client as never, calls };
}

const turns = [{ role: "user" as const, content: "we chose Postgres" }];
const event = (over: Partial<MessageMemoryEvent> = {}): MessageMemoryEvent => ({ orgId: "org1", model: "m", turns, ...over });
const fact = (id: string, over: Record<string, unknown> = {}) => ({ id, fact_type: "TechDecision", ...over });
const extractorOf = (facts: unknown[]): FactExtractor => ({ extract: vi.fn(async () => facts) }) as unknown as FactExtractor;

beforeEach(() => {
  for (const m of [resolveConversation, persist, indexRepository, persistAuditResults]) m.mockReset();
  for (const k of Object.keys(statusById)) delete statusById[k];
  persist.mockImplementation(async (rows: unknown[]) => ({ persisted: rows.length, skipped: 0, errors: [] }));
});

describe("identity validation fails closed before any side effect", () => {
  const cases: [string, Partial<MessageMemoryEvent>, RegExp][] = [
    ["project scope not prefixed by the org", { projectScopeId: "other/orion" }, /invalid authenticated project scope/],
    ["empty project scope after the prefix", { projectScopeId: "org1/" }, /invalid authenticated project scope/],
    ["project scope with illegal characters", { projectScopeId: "org1/Bad_Scope" }, /invalid authenticated project scope/],
    ["conversation id without key id", { conversationId: "c1" }, /incomplete authenticated conversation identity/],
    ["key id without conversation id", { keyId: "k1" }, /incomplete authenticated conversation identity/],
    ["exchange id without a verified conversation", { exchangeId: "e1" }, /exchange identity requires a verified conversation/],
  ];
  test.each(cases)("%s", async (_n, over, msg) => {
    const { client, calls } = fakeClient();
    const extractor = extractorOf([fact("f1")]);
    await expect(createSupabaseMessageMemoryRecorder(client, extractor)(event(over))).rejects.toThrow(msg);
    expect(calls.inserts).toEqual([]);
    expect(resolveConversation).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("session resolution", () => {
  test("a verified conversation resolves through the resolver (with scope) and is used as the session", async () => {
    resolveConversation.mockResolvedValueOnce("sess-conv");
    const { client, calls } = fakeClient();
    const extractor = extractorOf([fact("f1")]);
    await createSupabaseMessageMemoryRecorder(client, extractor)(event({ conversationId: "c1", keyId: "k1", exchangeId: "e1", projectScopeId: "org1/orion" }));
    expect(resolveConversation).toHaveBeenCalledWith({ orgId: "org1", keyId: "k1", projectScopeId: "org1/orion", model: "m", requestedId: "c1" });
    expect(calls.inserts).toEqual([]);
    expect(extractor.extract).toHaveBeenCalledWith({ session_id: "sess-conv", turns });
    expect(persist).toHaveBeenCalledWith([fact("f1")], { orgId: "org1", sessionId: "sess-conv", projectScope: "orion", exchangeId: "e1" });
  });

  test("without a project binding the resolver call omits projectScopeId and persist gets a null scope", async () => {
    resolveConversation.mockResolvedValueOnce("sess-conv");
    const { client } = fakeClient();
    await createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]))(event({ conversationId: "c1", keyId: "k1" }));
    expect(Object.keys(resolveConversation.mock.calls[0]![0])).not.toContain("projectScopeId");
    expect(persist.mock.calls[0]![1]).toEqual({ orgId: "org1", sessionId: "sess-conv", projectScope: null });
  });

  test("legacy path inserts an ended memory session scoped to the org/project", async () => {
    const { client, calls } = fakeClient();
    const extractor = extractorOf([]);
    await createSupabaseMessageMemoryRecorder(client, extractor)(event({ projectScopeId: "org1/orion" }));
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({ table: "sessions", row: { org_id: "org1", project_scope: "orion", model: "m", kind: "memory" } });
    expect(typeof (calls.inserts[0]!.row as { ended_at: string }).ended_at).toBe("string");
    expect(extractor.extract).toHaveBeenCalledWith({ session_id: "sess-new", turns });
  });

  test("a failed session insert surfaces its message and extracts nothing", async () => {
    const { client } = fakeClient({ insert: { data: null, error: { message: "db down" } } });
    const extractor = extractorOf([fact("f1")]);
    await expect(createSupabaseMessageMemoryRecorder(client, extractor)(event())).rejects.toThrow("memory session insert failed: db down");
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  test.each([[null], [[]], [[{}]]])("an insert that returns no id (%j) is rejected", async (data) => {
    const { client } = fakeClient({ insert: { data: data as never, error: null } });
    await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]))(event())).rejects.toThrow("memory session insert returned no id");
  });
});

describe("persistence", () => {
  test("no extracted facts means nothing is persisted or indexed", async () => {
    const { client } = fakeClient();
    await createSupabaseMessageMemoryRecorder(client, extractorOf([]), "/repo")(event());
    expect(persist).not.toHaveBeenCalled();
    expect(indexRepository).not.toHaveBeenCalled();
  });

  test("without an audit root, facts are stored as extracted and nothing is audited or released", async () => {
    const { client, calls } = fakeClient();
    await createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]))(event());
    expect(persist.mock.calls[0]![0]).toEqual([fact("f1")]);
    expect(indexRepository).not.toHaveBeenCalled();
    expect(persistAuditResults).not.toHaveBeenCalled();
    expect(calls.updates).toEqual([]);
  });

  test("persist errors are joined into one failure", async () => {
    persist.mockResolvedValueOnce({ persisted: 0, skipped: 0, errors: [{ table: "todos", message: "bad" }, { table: "tech_decisions", message: "worse" }] });
    const { client } = fakeClient();
    await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]))(event())).rejects.toThrow("memory fact persistence failed: todos: bad; tech_decisions: worse");
  });

  test.each([
    ["a skipped fact", { persisted: 1, skipped: 1, errors: [] }],
    ["a short persisted count", { persisted: 1, skipped: 0, errors: [] }],
  ])("%s is treated as an omitted validated fact", async (_n, result) => {
    persist.mockResolvedValueOnce(result);
    const { client } = fakeClient();
    await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1"), fact("f2")]))(event())).rejects.toThrow("memory fact persistence omitted a validated fact");
  });
});

describe("audit-gated release", () => {
  test("facts are persisted suppressed, audit results stored, and only non-CONFLICT facts are released", async () => {
    indexRepository.mockResolvedValueOnce([]);
    statusById["f2"] = "CONFLICT";
    const { client, calls } = fakeClient();
    const facts = [fact("f1"), fact("f2", { fact_type: "Todo" }), fact("f3", { fact_type: "Todo" })];
    await createSupabaseMessageMemoryRecorder(client, extractorOf(facts), "/repo")(event());
    expect(indexRepository).toHaveBeenCalledWith({ cwd: "/repo", maxCount: 100 });
    expect(persist.mock.calls[0]![0]).toEqual(facts.map((f) => ({ ...f, is_suppressed: true })));
    expect(persistAuditResults).toHaveBeenCalledTimes(1);
    expect(persistAuditResults.mock.calls[0]![2]).toEqual({ orgId: "org1", sessionId: "sess-new" });
    // Every released fact is addressed by id AND org AND session (no cross-tenant release).
    for (const u of calls.updates) {
      expect(u.patch).toEqual({ is_suppressed: false });
      expect(u.eq.map(([c]) => c)).toEqual(["id", "org_id", "session_id"]);
      expect(u.eq.slice(1)).toEqual([["org_id", "org1"], ["session_id", "sess-new"]]);
    }
    // f2 is a CONFLICT and stays suppressed; f1 and f3 are released into their own fact tables.
    expect(calls.updates.map((u) => [u.table, u.eq[0]![1]])).toEqual([["tech_decisions", "f1"], ["todos", "f3"]]);
  });

  test("an index failure stores no fact at all", async () => {
    indexRepository.mockRejectedValueOnce(new Error("git unavailable"));
    const { client } = fakeClient();
    await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]), "/repo")(event())).rejects.toThrow("git unavailable");
    expect(persist).not.toHaveBeenCalled();
  });

  test("an audit-persist failure leaves facts suppressed (no release attempted)", async () => {
    indexRepository.mockResolvedValueOnce([]);
    persistAuditResults.mockRejectedValueOnce(new Error("rpc failed"));
    const { client, calls } = fakeClient();
    await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]), "/repo")(event())).rejects.toThrow("rpc failed");
    expect(calls.updates).toEqual([]);
  });

  test("a release that errors or touches the wrong row count fails closed", async () => {
    indexRepository.mockResolvedValue([]);
    for (const released of [
      { data: null, error: { message: "locked" } },
      { data: [], error: null },
      { data: [{ id: "a" }, { id: "b" }], error: null },
    ]) {
      const { client } = fakeClient({ released });
      await expect(createSupabaseMessageMemoryRecorder(client, extractorOf([fact("f1")]), "/repo")(event())).rejects.toThrow(/memory fact release failed: (locked|fact missing)/);
    }
  });
});
