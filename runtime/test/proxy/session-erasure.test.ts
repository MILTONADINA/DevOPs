// specs/memory/session-erasure.md AC-B9/B10: HTTP/adapter contract only.
// The separate real database/API proof is required for substantive deletion.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSessionsDeps } from "../../src/proxy/routes/sessions";
import { OPENAPI_SPEC } from "../../src/proxy/openapi";

vi.unmock("fastify");
const { buildProxy } = await import("../../src/proxy/app");
const ORG = "10000000-0000-4000-8000-000000000001";
const SESSION = "20000000-0000-4000-8000-000000000001";
const REQUEST = "30000000-0000-4000-8000-000000000001";
const scope = "managed_explicit_session_v1";
const counts = {
  sessions: 1, billing_records: 2, pruning_logs: 1, function_changes: 1,
  tech_decisions: 1, policy_updates: 1, todos: 1, variable_changes: 1,
  operational_references: 1, audit_conflicts: 1, audit_statuses: 1,
  knowledge_entities: 1, knowledge_edges: 1, knowledge_entity_sessions: 1,
  knowledge_edge_sessions: 1, source_fact_links: 1, memory_vectors: 2,
};
const receipt = {
  status: "complete", scope, org_id: ORG, session_id: SESSION, request_id: REQUEST,
  completed_at: "2026-10-03T08:00:00.000Z", deleted: counts,
  retained: {
    knowledge_entities: 1, knowledge_edges: 1, knowledge_entity_sessions: 1,
    knowledge_edge_sessions: 1, source_fact_links: 0, memory_vectors: 0,
    erasure_deployment: 1, erasure_org_coverage: 1, session_erasure_state: 1,
    erased_fact_ids: 6, erased_entity_ids: 1,
  },
  exclusions: ["client_held_responses", "privileged_host_database_snapshots", "physical_heap_os_remnants"],
};
const prepared = { status: "prepared", scope, org_id: ORG, session_id: SESSION, request_id: REQUEST };
const ready = {
  status: "ready", reasons: [],
  inventory: {
    scope: "local_database_only", org_id: ORG, session_id: SESSION, counts,
    graph_ownership: "shared", unattributed_graph: "not_inventoried",
    org_only_classes: ["api_keys", "developers", "org_config", "organizations"],
    retained_metadata_classes: ["erasure_deployment", "erasure_org_coverage", "session_erasure_state"],
    external_copies: "not_inventoried", backups: "not_inventoried", in_memory: "not_inventoried",
  },
  classifications: {
    scope, deployment: "covered", enrollment: "covered", database: "covered",
    in_memory: "excluded", external_copies: "excluded", backups: "excluded",
  },
};

const apps: ReturnType<typeof buildProxy>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(replies: Array<{ data: unknown; error: unknown }>, auth = true) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    from: () => { throw new Error("unexpected content/metadata query before scoped erasure RPC"); },
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      const next = replies.shift();
      if (!next) throw new Error("unexpected extra RPC");
      return next;
    },
  } as unknown as SupabaseClient;
  const app = buildProxy({
    rateLimit: false, cors: false, sessions: createSupabaseSessionsDeps(client),
    ...(auth ? { auth: { resolve: async (key: string) => key === "org" ? { orgId: ORG, keyId: "key" }
      : key === "project" ? { orgId: ORG, keyId: "key", projectScopeId: `${ORG}/project` } : null } } : {}),
  });
  apps.push(app);
  return { app, calls, post: (payload?: unknown, query = "", key = "org") => app.inject({
    method: "POST", url: `/v1/sessions/${SESSION}/erasure${query}`,
    headers: { authorization: `Bearer ${key}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  }) };
}

describe("authenticated session erasure", () => {
  test("durably prepares then executes; usage is deleted ordinary data", async () => {
    const f = fixture([{ data: prepared, error: null }, { data: receipt, error: null }]);
    const result = await f.post({});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(receipt);
    expect(f.calls).toEqual([
      { name: "prepare_session_erasure", args: { p_org_id: ORG, p_session_id: SESSION } },
      { name: "execute_session_erasure", args: { p_org_id: ORG, p_session_id: SESSION } },
    ]);
  });
  test("completed retry needs no surviving session and returns the identical receipt", async () => {
    const f = fixture([{ data: receipt, error: null }]);
    expect((await f.post()).json()).toEqual(receipt);
    expect(f.calls.map((call) => call.name)).toEqual(["prepare_session_erasure"]);
  });
  test.each([false, true])("personal/project authentication cannot dispatch erasure (auth=%s)", async (auth) => {
    const f = fixture([], auth);
    expect((await f.post(undefined, "", "project")).statusCode).toBe(403);
    expect(f.calls).toEqual([]);
  });
  test.each([
    [{ org_id: ORG }, ""], [{ coverage: "covered" }, ""], [{ ready: true }, ""],
    [[], ""], [null, ""], [{}, "?org-id=spoofed"], [{}, "?coverage=covered"],
  ])("rejects scope/coverage/body overrides before dispatch: %j %s", async (payload, query) => {
    const f = fixture([]);
    expect((await f.post(payload, query as string)).statusCode).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("missing/foreign/internal identity is 404, never zero-row success", async () => {
    const f = fixture([{ data: null, error: null }]);
    expect((await f.post()).statusCode).toBe(404);
    expect(f.calls).toHaveLength(1);
  });
  test("unknown coverage is 409 and does not execute", async () => {
    const blocked = { status: "blocked", scope, org_id: ORG, session_id: SESSION, reasons: ["coverage_unknown"] };
    const f = fixture([{ data: blocked, error: null }]);
    const result = await f.post();
    expect(result.statusCode).toBe(409);
    expect(result.json()).toEqual(blocked);
    expect(f.calls).toHaveLength(1);
  });
  test.each([false, true])("SQL/transport failure is safe retryable503 (after prepare=%s)", async (afterPrepare) => {
    const replies: Array<{ data: unknown; error: unknown }> = [{ data: null, error: { message: "private SQL evidence: secret row" } }];
    if (afterPrepare) replies.unshift({ data: prepared, error: null });
    const f = fixture(replies);
    const result = await f.post();
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ status: "incomplete", retryable: true });
    expect(result.body).not.toContain("private SQL");
    expect(result.body).not.toContain("secret row");
    expect(result.body).not.toContain("completed_at");
    expect(f.calls).toHaveLength(afterPrepare ? 2 : 1);
  });
  test.each([
    { ...receipt, org_id: "foreign-org" }, { ...receipt, session_id: "foreign-session" },
    { ...receipt, request_id: "foreign-request" }, { ...receipt, completed_at: "not-a-date" },
    { ...receipt, deleted: { ...counts, billing_records: -1 } },
    { ...receipt, deleted: { ...counts, billing_records: "2" } },
    { ...receipt, deleted: { ...counts, sessions: 0 } },
    { ...receipt, retained: { ...receipt.retained, private_content: 1 } },
    { ...receipt, exclusions: [] }, { ...receipt, evidence: "private" },
  ])("refuses a malformed or mis-scoped completed receipt", async (invalid) => {
    const f = fixture([{ data: invalid, error: null }]);
    const result = await f.post();
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("foreign-");
    expect(result.body).not.toContain("private");
  });
  test("execute receipt must match the durable prepared request", async () => {
    const f = fixture([{ data: prepared, error: null }, { data: { ...receipt, request_id: "30000000-0000-4000-8000-000000000002" }, error: null }]);
    expect((await f.post()).statusCode).toBe(503);
  });
  test("canonicalizes a valid uppercase UUID before durable preparation and retry", async () => {
    const id = "abcdef00-abcd-4abc-8abc-abcdefabcdef";
    const completed = { ...receipt, session_id: id };
    const f = fixture([{ data: { ...prepared, session_id: id }, error: null }, { data: completed, error: null }, { data: completed, error: null }]);
    for (let retry = 0; retry < 2; retry++) {
      const result = await f.app.inject({ method: "POST", url: `/v1/sessions/${id.toUpperCase()}/erasure`, headers: { authorization: "Bearer org" } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(completed);
    }
    expect(f.calls.every((call) => (call.args as { p_session_id: string }).p_session_id === id)).toBe(true);
  });
  test.each(["org_id", "session_id"])("rejects a well-formed foreign %s at prepare and execute", async (field) => {
    const foreign = "f0000000-0000-4000-8000-000000000001";
    for (const afterPrepare of [false, true]) {
      const responses = [{ data: { ...receipt, [field]: foreign }, error: null }];
      const f = fixture(afterPrepare ? [{ data: prepared, error: null }, ...responses] : responses);
      expect((await f.post()).statusCode).toBe(503);
      expect(f.calls).toHaveLength(afterPrepare ? 2 : 1);
    }
  });
});

describe("managed erasure preflight", () => {
  test("returns read-only readiness with numeric positive usage and truthful classifications", async () => {
    const f = fixture([{ data: ready, error: null }]);
    const result = await f.app.inject({ method: "GET", url: `/v1/sessions/${SESSION}/erasure-preflight`, headers: { authorization: "Bearer org" } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(ready);
    expect(f.calls).toEqual([{ name: "inspect_managed_session_erasure", args: { p_org_id: ORG, p_session_id: SESSION } }]);
  });
  test.each([
    { ...ready, classifications: { ...ready.classifications, backups: "unknown" } },
    { ...ready, inventory: { ...ready.inventory, org_id: "foreign" } },
    { ...ready, inventory: { ...ready.inventory, org_id: "f0000000-0000-4000-8000-000000000001" } },
    { ...ready, inventory: { ...ready.inventory, session_id: "f0000000-0000-4000-8000-000000000001" } },
    { ...ready, inventory: { ...ready.inventory, graph_ownership: "ambiguous" } },
    { ...ready, reasons: ["coverage_unknown"] },
    { ...ready, status: "blocked", reasons: ["private SQL text"] },
  ])("cannot report inconsistent readiness or return unvalidated reasons", async (invalid) => {
    const f = fixture([{ data: invalid, error: null }]);
    const result = await f.app.inject({ method: "GET", url: `/v1/sessions/${SESSION}/erasure-preflight`, headers: { authorization: "Bearer org" } });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("private SQL");
    expect(f.calls).toHaveLength(1);
  });
  test("documents erasure separately from end-session and includes every outcome", () => {
    const paths = OPENAPI_SPEC.paths as Record<string, { post?: { responses: object }; delete?: { summary: string } }>;
    expect(Object.keys(paths["/v1/sessions/{id}/erasure"]?.post?.responses ?? {}).sort()).toEqual(["200", "400", "403", "404", "409", "503"]);
    expect(paths["/v1/sessions/{id}"]?.delete?.summary).toContain("End a session");
  });
});
