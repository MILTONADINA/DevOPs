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
import { healthRoute } from "./routes/health";
import { makeMessagesRoute } from "./routes/messages";
import { makeDashboardRoute, type DashboardDeps } from "./routes/dashboard";
import { makeBillingRoute, type BillingDeps } from "./routes/billing";
import { makeConfigRoute, type ConfigDeps } from "./routes/config";
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

  if (opts.rateLimit !== false) {
    const max =
      typeof opts.rateLimit === "number"
        ? opts.rateLimit
        : parseInt(process.env["RATE_LIMIT_MAX"] ?? "100", 10);
    void app.register(rateLimit, {
      max,
      timeWindow: process.env["RATE_LIMIT_WINDOW"] ?? "1 minute",
    });
  }

  // Auth gate (opt-in) — registered before the routes so it guards them all (it
  // exempts /health). Omitted in personal-use → no auth, unchanged behavior.
  if (opts.auth) {
    registerAuth(app, opts.auth);
  }

  void app.register(healthRoute);

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

  app.setErrorHandler((err, _req, reply) => {
    // Honor the error's own statusCode (rate-limit → 429, validation → 400,
    // etc.); only genuinely-unknown errors fall through to 500. Forcing 500
    // unconditionally would mask the plugin/framework status (e.g. rate limit).
    const e = err as Error & { statusCode?: number };
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    const type =
      status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "internal_proxy_error"
          : "request_error";
    logger.error({ err: e.message, status }, "proxy error");
    void reply.status(status).send({
      type: "error",
      error: { type, message: e.message },
    });
  });

  return app;
}
