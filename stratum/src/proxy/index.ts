/**
 * CQ Proxy — Fastify Server Entry Point.
 *
 * Side-effectful entry: builds the app (see ./app.ts), listens, and wires graceful shutdown
 * (SIGTERM/SIGINT drain in-flight requests + flush captures via Fastify onClose hooks, then exit).
 * The pure factory lives in ./app.ts so tests can `buildProxy()` + `app.inject()` without a server.
 *
 * Two modes:
 *  - DEFAULT (Phase 1, personal): measurement proxy + dashboard, UNAUTHENTICATED.
 *  - COMMERCIAL (CQ_COMMERCIAL=true + Supabase creds): adds the multi-tenant auth gate (protecting
 *    /v1/*) + the config/memory/billing/sessions APIs over Supabase. Multi-tenant, key-authenticated.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4080 npm run dev            # personal
 *   CQ_COMMERCIAL=true npm run dev                                  # commercial (needs SUPABASE_*)
 */

import dotenv from "dotenv";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";
import { buildProxy, type BuildProxyOptions } from "./app";
import { createDefaultMessagesDeps } from "./forward";
import { readSessionsFromDir } from "./routes/dashboard";
import { resolveApiKeyVia } from "./auth";
import { createSupabaseConfigDeps } from "./routes/config";
import { createSupabaseMemoryDeps } from "./routes/memory";
import { createSupabaseBillingDeps } from "./routes/billing";
import { createSupabaseSessionsDeps } from "./routes/sessions";
import { createSupabaseWebhookDeps } from "./routes/webhooks";

dotenv.config();

export interface StartEnv {
  CQ_COMMERCIAL?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_KEY?: string | undefined;
}

/** Commercial mode = the flag is on AND Supabase creds are present (else the multi-tenant store can't work). */
export function commercialEnabled(env: StartEnv): boolean {
  const on = env.CQ_COMMERCIAL === "true" || env.CQ_COMMERCIAL === "1";
  return on && typeof env.SUPABASE_URL === "string" && env.SUPABASE_URL !== "" && typeof env.SUPABASE_SERVICE_KEY === "string" && env.SUPABASE_SERVICE_KEY !== "";
}

export type ClientFactory = (url: string, key: string) => SupabaseClient;

/**
 * Assemble buildProxy options from env: always the base (messages + dashboard); in COMMERCIAL mode,
 * additionally the multi-tenant auth gate (protecting /v1/*) + the config/memory/billing/sessions
 * APIs over Supabase. Pure + testable — inject a fake client factory; never constructs a client off-mode.
 *
 * @param env - the relevant environment.
 * @param base - the always-on options (messages, dashboard).
 * @param makeClient - how to build a Supabase client (real in prod, a fake in tests).
 * @returns the {@link BuildProxyOptions} to pass to buildProxy.
 */
export function buildStartOptions(env: StartEnv, base: BuildProxyOptions, makeClient: ClientFactory): BuildProxyOptions {
  const opts: BuildProxyOptions = { ...base };
  if (commercialEnabled(env)) {
    const client = makeClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_KEY as string);
    opts.auth = { resolve: resolveApiKeyVia(client), protectedPrefixes: ["/v1/"] };
    opts.config = createSupabaseConfigDeps(client);
    opts.memory = createSupabaseMemoryDeps(client);
    opts.billing = createSupabaseBillingDeps(client);
    opts.sessions = createSupabaseSessionsDeps(client);
    opts.webhooks = createSupabaseWebhookDeps(client);
  }
  return opts;
}

/**
 * Build, listen, and install graceful-shutdown handlers.
 *
 * @returns Resolves once the server is listening.
 */
export async function start(): Promise<void> {
  const port = parseInt(process.env["PORT"] ?? "4080", 10);
  const sessionsDir = path.join(process.cwd(), "data", "sessions");
  const env: StartEnv = {
    CQ_COMMERCIAL: process.env["CQ_COMMERCIAL"],
    SUPABASE_URL: process.env["SUPABASE_URL"],
    SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"],
  };
  const base: BuildProxyOptions = {
    messages: createDefaultMessagesDeps(),
    dashboard: { readSessions: () => readSessionsFromDir(sessionsDir) },
  };
  const app = buildProxy(buildStartOptions(env, base, createClient));

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
  logger.info({ port, mode: commercialEnabled(env) ? "commercial (multi-tenant auth + APIs)" : "personal (Phase 1 measurement)" }, "CQ Proxy running");
}

// Only auto-start when run as the entry (not when imported by a test for the pure helpers).
const entryPath = process.argv[1] ?? "";
if (/proxy[\\/]index\.(ts|js)$/.test(entryPath)) {
  start().catch((err) => {
    logger.error({ err: (err as Error).message }, "Failed to start CQ Proxy");
    process.exit(1);
  });
}
