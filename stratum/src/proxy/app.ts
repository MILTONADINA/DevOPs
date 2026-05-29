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
import { logger } from "../lib/logger";
import { healthRoute } from "./routes/health";
import { makeMessagesRoute } from "./routes/messages";
import type { MessagesDeps } from "./forward";

export interface BuildProxyOptions {
  /**
   * When true, registers @fastify/cors. Default true. Tests can disable to keep
   * the injected app minimal.
   */
  cors?: boolean;
  /**
   * Dependencies for POST /v1/messages (forward + token-count + capture). When
   * omitted, the route is NOT registered (health-only mode — used by health
   * tests and any deploy that wires deps separately). The entry point supplies
   * the production deps via createDefaultMessagesDeps().
   */
  messages?: MessagesDeps;
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

  void app.register(healthRoute);

  if (opts.messages) {
    void app.register(makeMessagesRoute(opts.messages));
  }

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error;
    logger.error({ err: e.message }, "unhandled proxy error");
    void reply.status(500).send({
      type: "error",
      error: { type: "internal_proxy_error", message: e.message },
    });
  });

  return app;
}
