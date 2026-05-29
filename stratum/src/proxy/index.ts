/**
 * CQ Proxy — Fastify Server Entry Point (Phase 1).
 *
 * Side-effectful entry: builds the app (see ./app.ts), listens, and wires
 * graceful shutdown (SIGTERM/SIGINT drain in-flight requests + flush captures
 * via Fastify onClose hooks, then exit). The pure factory lives in ./app.ts so
 * tests can `buildProxy()` + `app.inject()` without starting a server.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4080 npm run dev   # then point Claude Code at it
 */

import dotenv from "dotenv";
import { logger } from "../lib/logger";
import { buildProxy } from "./app";
import { createDefaultMessagesDeps } from "./forward";

dotenv.config();

/**
 * Build, listen, and install graceful-shutdown handlers.
 *
 * @returns Resolves once the server is listening.
 */
export async function start(): Promise<void> {
  const port = parseInt(process.env["PORT"] ?? "4080", 10);
  const app = buildProxy({ messages: createDefaultMessagesDeps() });

  let draining = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (draining) return;
    draining = true;
    logger.info({ signal }, "CQ Proxy draining in-flight requests + flushing captures");
    try {
      // Fastify .close() stops accepting new connections, waits for in-flight
      // requests to finish, then runs onClose hooks (where capture flush lives).
      await app.close();
      logger.info("CQ Proxy shut down cleanly");
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host: "127.0.0.1" });
  logger.info({ port }, "CQ Proxy running (Phase 1 measurement)");
}

start().catch((err) => {
  logger.error({ err: (err as Error).message }, "Failed to start CQ Proxy");
  process.exit(1);
});
