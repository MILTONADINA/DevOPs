/**
 * CQ Proxy — Fastify application factory (Phase 1 measurement proxy).
 *
 * `buildProxy()` constructs and returns a Fastify instance WITHOUT listening,
 * so it is fully testable via `app.inject()`. The side-effectful entry point
 * (listen + graceful shutdown) lives in ./index.ts, which imports this factory.
 *
 * Phase 1 measures tokens + captures/redacts traffic; it does NOT prune.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { logger } from "../lib/logger";
import { makeHealthRoute, type HealthDeps } from "./routes/health";
import { makeMessagesRoute } from "./routes/messages";
import { makeDashboardRoute, type DashboardDeps } from "./routes/dashboard";
import { makeBillingRoute, type BillingDeps } from "./routes/billing";
import { makeConfigRoute, type ConfigDeps } from "./routes/config";
import { makeMemoryRoute, type MemoryDeps } from "./routes/memory";
import { makeSessionsRoute, type SessionsDeps } from "./routes/sessions";
import { makeWebhookRoute, type WebhookDeps } from "./routes/webhooks";
import { makeTokensRoute, type TokensDeps } from "./routes/tokens";
import { makeStripeWebhookRoute, type StripeWebhookDeps } from "./routes/stripe-webhook";
import { planRequestsPerMinute } from "./rate-limit-tiers";
import { OPENAPI_SPEC, OPENAPI_DOCS_HTML } from "./openapi";
import { registerAuth, type AuthDeps } from "./auth";
import type { MessagesDeps } from "./forward";

export interface BuildProxyOptions {
  /**
   * When true, registers @fastify/cors. Default true. Tests can disable to keep
   * the injected app minimal.
   */
  cors?: boolean;
  /**
   * Per-IP rate limit. `false` disables (used by most tests); a number sets the
   * max requests per window; omitted uses RATE_LIMIT_MAX env (default 100) over
   * RATE_LIMIT_WINDOW (default "1 minute"). Protects the proxy + the upstream
   * Anthropic key from runaway clients.
   */
  rateLimit?: false | number;
  /**
   * Dependencies for POST /v1/messages (forward + token-count + capture). When
   * omitted, the route is NOT registered (health-only mode — used by health
   * tests and any deploy that wires deps separately). The entry point supplies
   * the production deps via createDefaultMessagesDeps().
   */
  messages?: MessagesDeps;
  /**
   * Dependencies for GET /dashboard + /dashboard/api (the session reader). When
   * omitted, the dashboard is not registered. The entry point supplies a reader
   * over data/sessions/*.json.
   */
  dashboard?: DashboardDeps;
  /**
   * Multi-tenant API-key auth (v1.0.0). When omitted, the proxy is UNAUTHENTICATED
   * (the Phase-1 personal-use default). When supplied, every non-public request must
   * carry a valid key, whose org is attached to req.orgId. Opt-in so personal use is
   * unaffected; the commercial deploy supplies a Supabase-backed resolver.
   */
  auth?: AuthDeps;
  /**
   * The CFO billing API (GET /v1/billing/invoice + /audit.csv). When omitted, the routes
   * are not registered. The commercial deploy supplies createSupabaseBillingDeps(client).
   */
  billing?: BillingDeps;
  /**
   * The org config API (GET + PATCH /v1/config). When omitted, not registered. The commercial
   * deploy supplies createSupabaseConfigDeps(client).
   */
  config?: ConfigDeps;
  /**
   * The memory API (facts / suppress / conflicts). When omitted, not registered. The commercial
   * deploy supplies createSupabaseMemoryDeps(client).
   */
  memory?: MemoryDeps;
  /**
   * The sessions API (list / metadata / stats). When omitted, not registered. The commercial
   * deploy supplies createSupabaseSessionsDeps(client).
   */
  sessions?: SessionsDeps;
  /**
   * The webhook API (POST /v1/webhooks/test). When omitted, not registered. The commercial deploy
   * supplies createSupabaseWebhookDeps(client).
   */
  webhooks?: WebhookDeps;
  /**
   * The token-count API (POST /v1/tokens/count). When omitted, not registered. Commercial mode
   * reuses the messages counter.
   */
  tokens?: TokensDeps;
  /**
   * The Stripe INBOUND webhook (POST /stripe/webhook) — records `invoice.paid` (the "paid by
   * design partner" half of v1.0.0). PUBLIC by path (outside /v1/, signature-authenticated). When
   * omitted, not registered. The commercial deploy supplies createSupabaseStripeWebhookDeps().
   */
  stripeWebhook?: StripeWebhookDeps;
  /**
   * Per-PLAN request rate limiting (docs/RATE_LIMITS.md). When provided (commercial mode), requests
   * are limited per-ORG by the org's plan (requests/min) — `getPlan` resolves the plan. When omitted,
   * the limiter is the per-IP fixed `rateLimit` max (personal mode). Requires `auth` (the org is read
   * from req.orgId), so the rate limiter is registered AFTER the auth gate.
   */
  rateLimitByPlan?: { getPlan: (orgId: string) => Promise<string> };
  /**
   * Optional dependency checkers for GET /health (e.g. a cached Supabase ping). When omitted,
   * /health is liveness-only (the personal-use default).
   */
  health?: HealthDeps;
}

/**
 * Build the proxy Fastify instance (no network listen).
 *
 * @param opts - optional feature toggles.
 * @returns A configured (but not-yet-listening) Fastify instance. Call
 *          `await app.ready()` before `app.inject()`, or `app.listen()` to serve.
 */
export function buildProxy(opts: BuildProxyOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  if (opts.cors !== false) {
    void app.register(cors);
  }

  // Auth gate (opt-in) — registered before the routes so it guards them all (it
  // exempts /health). Omitted in personal-use → no auth, unchanged behavior.
  if (opts.auth) {
    registerAuth(app, opts.auth);
  }

  // Rate limiting — AFTER auth so the per-plan limiter can read req.orgId. When `rateLimitByPlan`
  // is set (commercial), limit per-ORG by the org's plan (requests/min); else per-IP fixed max.
  if (opts.rateLimit !== false) {
    if (opts.rateLimitByPlan) {
      const resolvePlan = opts.rateLimitByPlan.getPlan;
      void app.register(rateLimit, {
        keyGenerator: (req) => (typeof req.orgId === "string" && req.orgId !== "" ? req.orgId : req.ip),
        max: async (req) => (typeof req.orgId === "string" && req.orgId !== "" ? planRequestsPerMinute(await resolvePlan(req.orgId)) : planRequestsPerMinute("starter")),
        timeWindow: "1 minute",
      });
      // Emit the spec's request rate-limit headers (docs/RATE_LIMITS.md) by mapping the limiter's
      // functional x-ratelimit-* headers to the documented -Requests names (+ ISO reset).
      app.addHook("onSend", async (req, reply, payload) => {
        const limit = reply.getHeader("x-ratelimit-limit");
        if (limit !== undefined) {
          void reply.header("x-ratelimit-limit-requests", limit);
          const remaining = reply.getHeader("x-ratelimit-remaining");
          if (remaining !== undefined) void reply.header("x-ratelimit-remaining-requests", remaining);
          const resetSec = reply.getHeader("x-ratelimit-reset");
          if (resetSec !== undefined) {
            const secs = Number(resetSec);
            void reply.header("x-ratelimit-reset-requests", Number.isFinite(secs) ? new Date(Date.now() + secs * 1000).toISOString() : String(resetSec));
          }
        }
        const tb = req.tokenBudgetHeaders;
        if (tb !== undefined) {
          void reply.header("x-ratelimit-limit-tokens", String(tb.limit));
          void reply.header("x-ratelimit-remaining-tokens", String(tb.remaining));
        }
        return payload;
      });
    } else {
      const max = typeof opts.rateLimit === "number" ? opts.rateLimit : parseInt(process.env["RATE_LIMIT_MAX"] ?? "100", 10);
      void app.register(rateLimit, { max, timeWindow: process.env["RATE_LIMIT_WINDOW"] ?? "1 minute" });
    }
  }

  void app.register(makeHealthRoute(opts.health));

  // Machine-readable API contract (public, like /health) — clients generate SDKs / render Swagger
  // from it. Not under /v1/, so the auth gate (protectedPrefixes: ["/v1/"]) exempts it.
  app.get("/openapi.json", async (_req, reply) => {
    void reply.header("content-type", "application/json; charset=utf-8");
    return OPENAPI_SPEC;
  });

  // Human-browsable API reference (public) — renders /openapi.json client-side, no CDN, XSS-safe.
  app.get("/docs", async (_req, reply) => {
    void reply.header("content-type", "text/html; charset=utf-8");
    return OPENAPI_DOCS_HTML;
  });

  if (opts.messages) {
    void app.register(makeMessagesRoute(opts.messages));
  }

  if (opts.dashboard) {
    void app.register(makeDashboardRoute(opts.dashboard));
  }

  if (opts.billing) {
    void app.register(makeBillingRoute(opts.billing));
  }

  if (opts.config) {
    void app.register(makeConfigRoute(opts.config));
  }

  if (opts.memory) {
    void app.register(makeMemoryRoute(opts.memory));
  }

  if (opts.sessions) {
    void app.register(makeSessionsRoute(opts.sessions));
  }

  if (opts.webhooks) {
    void app.register(makeWebhookRoute(opts.webhooks));
  }

  if (opts.tokens) {
    void app.register(makeTokensRoute(opts.tokens));
  }

  if (opts.stripeWebhook) {
    void app.register(makeStripeWebhookRoute(opts.stripeWebhook));
  }

  app.setErrorHandler((err, _req, reply) => {
    // Honor the error's own statusCode (rate-limit → 429, validation → 400,
    // etc.); only genuinely-unknown errors fall through to 500. Forcing 500
    // unconditionally would mask the plugin/framework status (e.g. rate limit).
    const e = err as Error & { statusCode?: number };
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    const type = status === 429 ? "rate_limit_error" : status >= 500 ? "internal_proxy_error" : "request_error";
    logger.error({ err: e.message, status }, "proxy error");
    // 5xx messages must NOT reach the client: route deps wrap raw Supabase errors as
    // `throw new Error("X failed: " + error.message)`, which can carry table/column/constraint names
    // (schema disclosure). The full error is in the server log above; the client gets a generic string.
    // 4xx messages are framework/validation-generated (rate-limit, the isoParam 400) and safe to surface.
    const clientMessage = status >= 500 ? "an internal error occurred" : e.message;
    void reply.status(status).send({
      type: "error",
      error: { type, message: clientMessage },
    });
  });

  return app;
}
