// Plan reader (specs/ops/payment-removal.md REQ-2, AC-2). In team mode buildStartOptions gives the per-plan request rate limit
// (opts.rateLimitByPlan) and the token budget (opts.messages.tokenBudget) one plan reader. It must read an organization's plan
// through the sessions dependencies (opts.sessions.getPlan), not the billing dependencies, so that the billing routes can go
// without changing what any organization is allowed. Removing the billing dependencies so that every lookup falls through to
// the starter tier does not satisfy REQ-2, and these tests fail on it.
//
// Every case goes through buildStartOptions with a fake Supabase client that answers the organizations plan query
// (from("organizations").select("plan").eq("id", ...).limit(1), which the billing and the sessions dependencies both use)
// with a plan CONTRARY to the limit the case expects from sessions.getPlan: a plan reader that still asks the billing
// dependencies gets a different limit and fails. sessions.getPlan is spied on AFTER buildStartOptions returns, so the reader
// has to call it as a method when a request arrives; a function reference captured while the options were built is not the spy.
//
// The environment has no CQ_BILLING_SIGNING_SECRET: with one, buildStartOptions creates a real usage outbox directory under
// <cwd>/data. Each case builds its own options and app and uses its own organization id, because the rate limiter's window
// and the token budget's 60-second plan cache would otherwise carry over from one case to the next.

import { describe, test, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BuildProxyOptions } from "../../src/proxy/app";
import type { ClientFactory } from "../../src/proxy/index";
import type { ConfigDeps } from "../../src/proxy/routes/config";

vi.unmock("fastify");
vi.unmock("@fastify/cors");
vi.unmock("@fastify/rate-limit");

const { buildProxy } = await import("../../src/proxy/app");
const { buildStartOptions } = await import("../../src/proxy/index");
const { logger } = await import("../../src/lib/logger");

const TEAM_ENV = { CQ_COMMERCIAL: "true", SUPABASE_URL: "u", SUPABASE_SERVICE_KEY: "k" };
const KEY = "plan-reader-key";
// docs/runbooks/INCIDENT_RESPONSE.md quotes this text, so it is part of the contract.
const LOOKUP_FAILED = "getOrgPlan failed — defaulting to starter tier";

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (app) {
    await app.close();
    app = undefined;
  }
});

/**
 * A Supabase client that answers only from("organizations").select("plan").eq("id", orgId).limit(1) with `plan`. Any other
 * table throws, so a query the cases do not expect fails them instead of passing quietly.
 */
function clientAnsweringPlan(plan: string): ClientFactory {
  const client = {
    from: (table: string) => {
      if (table !== "organizations") throw new Error(`unexpected query on ${table}`);
      return { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [{ plan }], error: null }) }) }) };
    },
  } as unknown as SupabaseClient;
  return () => client;
}

/** The team-mode app over `opts`: an injected key resolver stands in for the database and a fake ConfigDeps answers the probed GET /v1/config. */
function teamApp(opts: BuildProxyOptions, orgId: string): FastifyInstance {
  const resolve = (raw: string) => Promise.resolve(raw === KEY ? { orgId, keyId: "k" } : null);
  const config: ConfigDeps = { getConfig: () => Promise.resolve(null), upsertConfig: (_o, p) => Promise.resolve({ lambda: 0.97, gain_shift: 0, theta: 1, zk_enabled: false, audit_enabled: true, webhook_url: null, ...p }) };
  return buildProxy({ ...opts, cors: false, auth: { resolve, protectedPrefixes: ["/v1/"] }, config });
}

/** The status codes of `count` sequential GET /v1/config requests. */
async function statusesOf(target: FastifyInstance, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    statuses.push((await target.inject({ method: "GET", url: "/v1/config", headers: { authorization: `Bearer ${KEY}` } })).statusCode);
  }
  return statuses;
}

describe("plan reader: per-plan request rate limit in team mode (REQ-2)", () => {
  test("specs/ops/payment-removal.md#AC-2 — a starter-plan organization is refused its 21st request in a minute, the plan read through opts.sessions", async () => {
    const orgId = "org-rate-starter";
    const opts = buildStartOptions(TEAM_ENV, {}, clientAnsweringPlan("growth"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockResolvedValue("starter");
    app = teamApp(opts, orgId);
    await app.ready();

    const statuses = await statusesOf(app, 21);
    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(200)); // the 20th request is still served
    expect(statuses[20]).toBe(429); // the 21st exceeds starter's 20 requests a minute
    expect(planSpy).toHaveBeenCalledWith(orgId);
  });

  test("specs/ops/payment-removal.md#AC-2 — a growth-plan organization is served its 21st and 60th requests and refused its 61st, the plan read through opts.sessions", async () => {
    const orgId = "org-rate-growth";
    const opts = buildStartOptions(TEAM_ENV, {}, clientAnsweringPlan("starter"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockResolvedValue("growth");
    app = teamApp(opts, orgId);
    await app.ready();

    const statuses = await statusesOf(app, 61);
    expect(statuses.slice(0, 60)).toEqual(Array<number>(60).fill(200)); // includes the 21st and the 60th
    expect(statuses[60]).toBe(429); // the 61st exceeds growth's 60 requests a minute
    expect(planSpy).toHaveBeenCalledWith(orgId);
  });

  // The next two tests are the fail-open default: an unknown organization or a failed lookup is limited as starter. Dropping the `?? "starter"` fallback or the catch from the plan reader fails them.
  test("specs/ops/payment-removal.md#AC-2 — a plan lookup that returns null is limited as starter, without a warning", async () => {
    const orgId = "org-rate-unknown";
    const opts = buildStartOptions(TEAM_ENV, {}, clientAnsweringPlan("growth"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockResolvedValue(null);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    app = teamApp(opts, orgId);
    await app.ready();

    const statuses = await statusesOf(app, 21);
    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(200));
    expect(statuses[20]).toBe(429); // the 21st exceeds starter's 20 requests a minute
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), LOOKUP_FAILED); // an unknown organization is not a failed lookup
    expect(planSpy).toHaveBeenCalledWith(orgId);
    // The rate limiter and the token budget both map an unknown plan to starter themselves, so the reader's own answer is checked directly.
    await expect(opts.rateLimitByPlan!.getPlan(orgId)).resolves.toBe("starter");
  });

  test("specs/ops/payment-removal.md#AC-2 — a plan lookup that throws is limited as starter and logs the lookup warning", async () => {
    const orgId = "org-rate-failing";
    const opts = buildStartOptions(TEAM_ENV, {}, clientAnsweringPlan("growth"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockRejectedValue(new Error("plan store down"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    app = teamApp(opts, orgId);
    await app.ready();

    const statuses = await statusesOf(app, 21);
    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(200)); // a lookup error never turns into a 500 for the organization
    expect(statuses[20]).toBe(429); // the 21st exceeds starter's 20 requests a minute
    expect(warn).toHaveBeenCalledWith({ err: "plan store down", orgId }, LOOKUP_FAILED);
    expect(planSpy).toHaveBeenCalledWith(orgId);
    await expect(opts.rateLimitByPlan!.getPlan(orgId)).resolves.toBe("starter");
  });
});

describe("plan reader: token budget in team mode (REQ-2)", () => {
  const messages = (): NonNullable<BuildProxyOptions["messages"]> => ({}) as NonNullable<BuildProxyOptions["messages"]>;

  test("specs/ops/payment-removal.md#AC-2 — a growth-plan organization may spend 60,000 tokens in a minute, the plan read through opts.sessions", async () => {
    const orgId = "org-budget-growth";
    const opts = buildStartOptions(TEAM_ENV, { messages: messages() }, clientAnsweringPlan("starter"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockResolvedValue("growth");

    const decision = await opts.messages!.tokenBudget!.tryConsume(orgId, 60_000);
    expect(decision).toMatchObject({ allowed: true, limit: 200_000 }); // growth: 200,000 tokens a minute
    expect(planSpy).toHaveBeenCalledWith(orgId);
  });

  test("specs/ops/payment-removal.md#AC-2 — a starter-plan organization may not spend 60,000 tokens in a minute, the plan read through opts.sessions", async () => {
    const orgId = "org-budget-starter";
    const opts = buildStartOptions(TEAM_ENV, { messages: messages() }, clientAnsweringPlan("growth"));
    const planSpy = vi.spyOn(opts.sessions!, "getPlan").mockResolvedValue("starter");

    const decision = await opts.messages!.tokenBudget!.tryConsume(orgId, 60_000);
    expect(decision).toMatchObject({ allowed: false, limitType: "tokens_per_minute", limit: 50_000 }); // starter: 50,000 tokens a minute
    expect(planSpy).toHaveBeenCalledWith(orgId);
  });
});
