/**
 * CQ Proxy — Fastify Server Entry Point (Phase 1)
 *
 * Local development proxy that intercepts Anthropic API calls,
 * measures tokens, and reports waste. No pruning in Phase 1.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4080 claude
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import { logger } from "../lib/logger";

dotenv.config();

const PORT = parseInt(process.env["PORT"] ?? "4080", 10);

const app = Fastify({ logger: false });

async function start(): Promise<void> {
  await app.register(cors);
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

  // TODO: Register routes (Phase 1)
  // await app.register(messagesRoute, { prefix: "/v1" });
  // await app.register(sessionsRoute, { prefix: "/v1" });
  // await app.register(billingRoute, { prefix: "/v1" });
  // await app.register(healthRoute);

  await app.listen({ port: PORT, host: "127.0.0.1" });
  logger.info({ port: PORT }, "CQ Proxy running");
}

start().catch((err) => {
  logger.error(err, "Failed to start CQ Proxy");
  process.exit(1);
});
