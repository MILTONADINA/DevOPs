/**
 * Multi-tenant API-key authentication (v1.0.0 component, build-ahead).
 *
 * Resolves an inbound API key to its owning org so the proxy can scope every request to a
 * tenant. Keys are stored HASH-ONLY (api_keys.key_hash — SHA-256; the raw key is shown once at
 * creation and never persisted), so a DB leak never exposes usable keys. Opt-in: buildProxy only
 * enforces auth when given `auth` deps, so the Phase-1 personal-use proxy is unchanged. The hook +
 * resolver are injectable, so this is fully testable with a fake — no DB, no Fastify network.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated org (set by the auth hook when `auth` deps are supplied). */
    orgId?: string;
    /** The api_keys.id that authenticated the request. */
    apiKeyId?: string;
  }
}

/** SHA-256 hex of a raw key — the only form ever stored or compared. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generate a new API key: a prefixed 256-bit random raw key + its hash (store the hash only). */
export function generateApiKey(env: "live" | "test" = "live"): { raw: string; hash: string } {
  const raw = `cq_${env}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashApiKey(raw) };
}

/** Pull the key from `Authorization: Bearer <k>` or `x-api-key`. Returns undefined if absent. */
export function extractApiKey(headers: Record<string, unknown>): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const k = auth.slice(7).trim();
    if (k !== "") return k;
  }
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.trim() !== "") return x.trim();
  return undefined;
}

/** Resolves a raw key to its org (or null if unknown/inactive). */
export type ApiKeyResolver = (rawKey: string) => Promise<{ orgId: string; keyId: string } | null>;

/**
 * A resolver backed by Supabase: hash the key, look it up among ACTIVE keys, return the org.
 * Read-only (no per-request last_used write — that write-amplification is a later, throttled slice).
 *
 * @param client - a service-role Supabase client.
 * @returns an {@link ApiKeyResolver}.
 * @throws {Error} if the lookup query itself errors (distinct from "key not found" → null).
 */
export function resolveApiKeyVia(client: SupabaseClient): ApiKeyResolver {
  return async (rawKey: string) => {
    const hash = hashApiKey(rawKey);
    const { data, error } = await client.from("api_keys").select("id, org_id").eq("key_hash", hash).eq("is_active", true).limit(1);
    if (error) throw new Error(`api key lookup failed: ${error.message}`);
    const row = (data ?? [])[0] as { id: string; org_id: string } | undefined;
    return row ? { orgId: row.org_id, keyId: row.id } : null;
  };
}

export interface AuthDeps {
  /** How to resolve a key → org (Supabase-backed in prod, a fake in tests). */
  resolve: ApiKeyResolver;
  /** Paths that bypass auth — liveness etc. (default ["/health"]). */
  publicPaths?: string[];
}

function unauthorized(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(401).send({ type: "error", error: { type: "authentication_error", message } });
}

/**
 * Register the multi-tenant auth gate as an onRequest hook. Public paths bypass it; every other
 * request must carry a valid active key, whose org is attached to `req.orgId`. A 401 short-circuits.
 *
 * @param app - the Fastify instance.
 * @param deps - the resolver + optional public paths.
 */
export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const publicPaths = new Set(deps.publicPaths ?? ["/health"]);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = (req.url.split("?")[0] ?? req.url);
    if (publicPaths.has(path)) return;
    const raw = extractApiKey(req.headers as Record<string, unknown>);
    if (raw === undefined) return unauthorized(reply, "missing API key (send Authorization: Bearer <key> or x-api-key)");
    const resolved = await deps.resolve(raw);
    if (resolved === null) return unauthorized(reply, "invalid or inactive API key");
    req.orgId = resolved.orgId;
    req.apiKeyId = resolved.keyId;
    return undefined;
  });
}
