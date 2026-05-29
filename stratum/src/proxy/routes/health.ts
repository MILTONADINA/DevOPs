/**
 * GET /health — Proxy health check. No authentication required.
 *
 * Phase 1: liveness + basic metadata (phase, uptime, version). Dependent-service
 * connectivity (Supabase / OTel) is added when those are wired in later §2d
 * increments — reported here as they come online, never faked.
 */

import type { FastifyInstance } from "fastify";

const STARTED_AT = Date.now();

/**
 * Fastify plugin registering GET /health.
 *
 * @param app - the Fastify instance to register the route on.
 */
export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    phase: "1-measurement-proxy",
    uptime_ms: Date.now() - STARTED_AT,
    version: process.env["npm_package_version"] ?? "0.1.0",
  }));
}
