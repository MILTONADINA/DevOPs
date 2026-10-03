// The payment HTTP surface is absent (specs/ops/payment-removal.md REQ-1, AC-1). In team mode the proxy has no inbound Stripe webhook: buildStartOptions wires none even when
// STRIPE_WEBHOOK_SECRET is in the environment, and POST /stripe/webhook is answered by the route table's 404, not by a handler that refuses the request (before the removal it
// answered 400, for the missing Stripe-Signature header). It also has no CFO page and no payment read: GET /billing, GET /v1/billing/invoice, GET /v1/billing/audit.csv and
// GET /v1/billing/invoices are answered by the route table's 404 too (before the removal: 200 for the page, a handler error for each read), and the OpenAPI document lists none of
// them, has no Invoice schema and carries no fee wording.
//
// The app is built the way start() builds it in team mode: buildStartOptions over a fake Supabase client, then buildProxy. Three details keep the case honest:
//   - `env` is a variable, not an object literal at the call. It carries STRIPE_WEBHOOK_SECRET, a setting StartEnv no longer declares, and a fresh literal with that key would fail
//     the excess-property check.
//   - `base` has no `messages`. With one, the signing secret in `env` would make buildStartOptions open a real usage outbox directory under <cwd>/data.
//   - the key resolver is stubbed with an org-level key (no projectScopeId), so a request under /v1/ that carries a bearer token passes the auth gate and reaches the route table.
//
// The usage read API stays wired in team mode (REQ-3, AC-3). Over a fake client that answers the organizations plan query with a plan row and every billing_records page with no rows and an exact
// count of 0, the same app answers GET /v1/billing/summary and GET /v1/billing/records with 200 and the usage JSON shape. The plan row is there so that a 404 from these two reads can only be the
// route table's, never the summary's own "organization not found". A source check adds that src/proxy/index.ts has no import path containing routes/billing.

import { afterEach, describe, expect, test, vi } from "vitest";
vi.unmock("node:fs");
vi.unmock("fs");
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPENAPI_SPEC } from "../../src/proxy/openapi";

vi.unmock("fastify");

const { buildProxy } = await import("../../src/proxy/app");
const { buildStartOptions } = await import("../../src/proxy/index");

const env = {
  CQ_COMMERCIAL: "true",
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_SERVICE_KEY: "test-service-key",
  CQ_BILLING_SIGNING_SECRET: "test-billing-signing-secret",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
};
const fakeClient = {} as unknown as SupabaseClient;
const AUTH = { authorization: "Bearer team-key" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

/** The team-mode app: the options buildStartOptions assembles from `env` over `client`, with the key resolver replaced by one that accepts any key as an org-level key. */
function teamModeApp(client: SupabaseClient = fakeClient): FastifyInstance {
  const opts = buildStartOptions(env, {}, () => client);
  opts.auth!.resolve = () => Promise.resolve({ orgId: "org-payment-removed", keyId: "key-1" });
  return buildProxy({ ...opts, cors: false, rateLimit: false });
}

/** The harness is team mode and its stubbed key works: /v1/ answers 401 without a key and falls through to the route table (404) with one. A 404 from a probe is therefore a route-table miss, not an app that never wired team mode. */
async function expectRouteTableReachable(a: FastifyInstance): Promise<void> {
  expect((await a.inject({ method: "GET", url: "/v1/no-such-path" })).statusCode).toBe(401);
  expect((await a.inject({ method: "GET", url: "/v1/no-such-path", headers: AUTH })).statusCode).toBe(404);
}

describe("payment surface removed: team mode (REQ-1)", () => {
  test("specs/ops/payment-removal.md#AC-1 — POST /stripe/webhook is not registered, even with STRIPE_WEBHOOK_SECRET in the environment", async () => {
    app = teamModeApp();
    await app.ready();
    await expectRouteTableReachable(app);

    // A non-empty JSON body, so that only the route's existence decides the status.
    const res = await app.inject({ method: "POST", url: "/stripe/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(404);
  });

  test("specs/ops/payment-removal.md#AC-1 — GET /billing, /v1/billing/invoice, /v1/billing/audit.csv and /v1/billing/invoices are not registered", async () => {
    app = teamModeApp();
    await app.ready();
    await expectRouteTableReachable(app);

    // The bearer key carries the three /v1/ reads past the auth gate; /billing sits outside the gate and ignores it. Before the removal the page answered 200 and each read answered a handler
    // error (the fake client has no `from`), never 404. One map, so that a failure names every URL that still answers.
    const statuses: Record<string, number> = {};
    for (const url of ["/billing", "/v1/billing/invoice", "/v1/billing/audit.csv", "/v1/billing/invoices"]) {
      statuses[url] = (await app.inject({ method: "GET", url, headers: AUTH })).statusCode;
    }
    expect(statuses).toEqual({ "/billing": 404, "/v1/billing/invoice": 404, "/v1/billing/audit.csv": 404, "/v1/billing/invoices": 404 });
  });

  test("specs/ops/payment-removal.md#AC-1 — GET /openapi.json lists none of the removed paths and still lists the two usage paths", async () => {
    app = teamModeApp();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const paths = Object.keys(res.json().paths);
    for (const removed of ["/billing", "/v1/billing/invoice", "/v1/billing/audit.csv", "/v1/billing/invoices", "/stripe/webhook"]) {
      expect(paths, removed).not.toContain(removed);
    }
    // The parity test in openapi.test.ts probes only the paths the document lists, so the two kept usage paths must stay listed for it to keep covering them.
    expect(paths).toEqual(expect.arrayContaining(["/v1/billing/summary", "/v1/billing/records"]));
  });
});

describe("payment surface removed: OpenAPI document (REQ-1)", () => {
  test("specs/ops/payment-removal.md#AC-1 — components.schemas has no Invoice schema", () => {
    expect(Object.keys(OPENAPI_SPEC.components.schemas)).not.toContain("Invoice");
  });

  test("specs/ops/payment-removal.md#AC-1 — the document carries no fee, amount-due, plan-minimum or charge wording", () => {
    expect(JSON.stringify(OPENAPI_SPEC)).not.toMatch(/fee|amount_?due|monthly_?minimum|charges/i);
  });
});

/**
 * A Supabase client double for the two usage reads: the organizations table answers with one plan row, every other table (billing_records) with an empty page and an exact count of 0. Every
 * query method returns the builder, and awaiting the builder resolves the answer. `tables` keeps the name of each table read, in order.
 */
function usageClient(): { client: SupabaseClient; tables: string[] } {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const answer = table === "organizations" ? { data: [{ plan: "growth" }], error: null, count: null } : { data: [], error: null, count: 0 };
      const query: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(answer).then(resolve, reject) };
      for (const method of ["select", "eq", "gte", "lt", "order", "limit", "range"]) query[method] = () => query;
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, tables };
}

describe("usage read API stays wired: team mode (REQ-3)", () => {
  // Mutation: forgetting to set opts.usage in buildStartOptions, or to register makeUsageRoute in buildProxy (both paths would then answer the route table's 404).
  test("specs/ops/payment-removal.md#AC-3 — team mode answers GET /v1/billing/summary and GET /v1/billing/records with 200 and the usage JSON shape, not the route table's 404 (regression guard)", async () => {
    const { client, tables } = usageClient();
    app = teamModeApp(client);
    await app.ready();
    await expectRouteTableReachable(app);

    // The client has a plan row for every organization, so a 404 from either read can only be the route table's. The body rides along as the failure message.
    const summary = await app.inject({ method: "GET", url: "/v1/billing/summary", headers: AUTH });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({ org_id: "org-payment-removed", period: "(all time)", total_original_tokens: 0, total_quarantined_tokens: 0, total_token_delta: 0, total_sessions: 0, by_developer: [] });

    const records = await app.inject({ method: "GET", url: "/v1/billing/records", headers: AUTH });
    expect(records.statusCode, records.body).toBe(200);
    expect(records.json()).toEqual({ records: [], total: 0, offset: 0, limit: 50 });

    // The answers came from the injected client, through the plan read and the ledger reads.
    expect(tables).toEqual(expect.arrayContaining(["organizations", "billing_records"]));
  });
});

/** Every module specifier in `source` that follows `from "..."`, `import "..."` or `import("...")`, wherever those forms appear: a comment that quotes one of them matches too, which is the safe direction for a check that expects none. */
function moduleSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

describe("payment surface removed: the proxy entry point's imports (REQ-1)", () => {
  test("specs/ops/payment-removal.md#AC-1 — src/proxy/index.ts has no import path containing routes/billing", () => {
    // Control: the parser reads a multi-line named import and a dynamic import, so the empty result below is not a parser that sees nothing.
    expect(moduleSpecifiers('import {\n  a,\n  b,\n} from "./routes/billing";\nconst m = await import("./routes/billing");')).toEqual(["./routes/billing", "./routes/billing"]);

    const specifiers = moduleSpecifiers(readFileSync(join(process.cwd(), "src/proxy/index.ts"), "utf8"));
    // The file's own imports were read: it always imports the app factory.
    expect(specifiers).toContain("./app");
    expect(specifiers.filter((specifier) => specifier.includes("routes/billing"))).toEqual([]);
  });
});
