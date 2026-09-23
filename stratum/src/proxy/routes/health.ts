/**
 * GET /health — Proxy health check. No authentication required.
 *
 * Liveness + basic metadata (phase, uptime, version). When a dependency checker is supplied
 * (commercial mode), also reports `dependencies` connectivity (Supabase) — "reported here as they
 * come online, never faked". `status` stays "ok" for liveness even if a dependency is degraded (a
 * load balancer must not kill a live instance over a transient dep blip); the `dependencies` object
 * carries the readiness detail. The check is expected to be CACHED by the caller (it's hit often).
 */

import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";

const STARTED_AT = Date.now();

export interface HealthDeps {
  /** Returns true if the primary datastore is reachable. Cached by the wiring (hit frequently). */
  checkDatabase?: () => Promise<boolean>;
}

/**
 * Build the GET /health plugin.
 *
 * @param deps - optional dependency checkers (a fake in tests; cached Supabase ping in prod).
 * @returns a Fastify plugin registering GET /health.
 */
export function makeHealthRoute(deps: HealthDeps = {}): FastifyPluginCallback {
  return function healthPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/health", async () => {
      const base = {
        status: "ok" as const,
        phase: "1-measurement-proxy",
        uptime_ms: Date.now() - STARTED_AT,
        version: process.env["npm_package_version"] ?? "0.1.0",
      };
      if (deps.checkDatabase === undefined) return base;
      let dbOk = false;
      try {
        dbOk = await deps.checkDatabase();
      } catch {
        dbOk = false;
      }
      return { ...base, dependencies: { database: dbOk ? "ok" : "error" } };
    });
    done();
  };
}

/**
 * A cached Supabase reachability check for /health (a lightweight head count on organizations).
 * Caches the last result for `ttlMs` so a frequently-hit /health doesn't hammer the DB.
 *
 * @param client - a Supabase client.
 * @param ttlMs - cache window (default 5s).
 * @param now - clock (injected for tests).
 * @returns a `checkDatabase` function.
 */
export function createSupabaseHealthCheck(client: SupabaseClient, ttlMs = 5_000, now: () => number = () => Date.now()): () => Promise<boolean> {
  let cached: { at: number; ok: boolean } | undefined;
  return async (): Promise<boolean> => {
    const t = now();
    if (cached !== undefined && t - cached.at < ttlMs) return cached.ok;
    let ok = false;
    try {
      const { error } = await client.from("organizations").select("id", { head: true, count: "exact" }).limit(1);
      ok = error === null;
    } catch {
      ok = false;
    }
    cached = { at: t, ok };
    return ok;
  };
}
