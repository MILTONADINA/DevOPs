/**
 * Org configuration API (Phase 2) — read/update an org's pruning + feature config.
 *
 *   GET   /v1/config[?org-id]   → the org's config (defaults if none set; webhook_secret NEVER returned).
 *   PATCH /v1/config[?org-id]   → validate + upsert {lambda, gain_shift, theta, zk_enabled,
 *                                 audit_enabled, webhook_url}; returns the updated config.
 *
 * Org scope comes from req.orgId (the auth gate) with a ?org-id fallback. The store is INJECTED
 * (ConfigDeps) so the route is testable via app.inject() with no DB; createSupabaseConfigDeps wires
 * org_config. App-layer validation mirrors the DB CHECKs (lambda ∈ (0,1], theta > 0) for clean 400s.
 */

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The readable config (never includes webhook_secret). */
export interface OrgConfig {
  lambda: number;
  gain_shift: number;
  theta: number;
  zk_enabled: boolean;
  audit_enabled: boolean;
  webhook_url: string | null;
}

/** The DB defaults (used when an org has no org_config row yet). */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
  lambda: 0.97,
  gain_shift: 0.0,
  theta: 1.0,
  zk_enabled: false,
  audit_enabled: true,
  webhook_url: null,
};

export type OrgConfigPatch = Partial<OrgConfig>;

export interface ConfigDeps {
  getConfig: (orgId: string) => Promise<OrgConfig | null>;
  upsertConfig: (orgId: string, patch: OrgConfigPatch) => Promise<OrgConfig>;
}

/** Validate a PATCH body into a config patch (mirrors the DB CHECKs); pure + testable. */
export function validateConfigPatch(body: unknown): { ok: true; patch: OrgConfigPatch } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const patch: OrgConfigPatch = {};
  if ("lambda" in b) {
    if (typeof b["lambda"] !== "number" || !(b["lambda"] > 0 && b["lambda"] <= 1)) return { ok: false, error: "lambda must be a number in (0, 1]" };
    patch.lambda = b["lambda"];
  }
  if ("theta" in b) {
    if (typeof b["theta"] !== "number" || !(b["theta"] > 0)) return { ok: false, error: "theta must be a number > 0" };
    patch.theta = b["theta"];
  }
  if ("gain_shift" in b) {
    if (typeof b["gain_shift"] !== "number" || !Number.isFinite(b["gain_shift"])) return { ok: false, error: "gain_shift must be a finite number" };
    patch.gain_shift = b["gain_shift"];
  }
  if ("zk_enabled" in b) {
    if (typeof b["zk_enabled"] !== "boolean") return { ok: false, error: "zk_enabled must be a boolean" };
    patch.zk_enabled = b["zk_enabled"];
  }
  if ("audit_enabled" in b) {
    if (typeof b["audit_enabled"] !== "boolean") return { ok: false, error: "audit_enabled must be a boolean" };
    patch.audit_enabled = b["audit_enabled"];
  }
  if ("webhook_url" in b) {
    if (typeof b["webhook_url"] !== "string") return { ok: false, error: "webhook_url must be a string" };
    patch.webhook_url = b["webhook_url"];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "no recognized config fields to update" };
  return { ok: true, patch };
}

function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  const q = req.query as Record<string, unknown>;
  const v = q["org-id"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function err(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type: "request_error", message } });
}

/**
 * Build the config API plugin.
 *
 * @param deps - the config store (a fake in tests, Supabase in prod).
 * @returns a plugin registering GET + PATCH /v1/config.
 */
export function makeConfigRoute(deps: ConfigDeps): FastifyPluginCallback {
  return function configPlugin(app: FastifyInstance, _opts, done): void {
    app.get("/v1/config", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const cfg = await deps.getConfig(orgId);
      return cfg ?? DEFAULT_ORG_CONFIG;
    });

    app.patch("/v1/config", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const v = validateConfigPatch(req.body);
      if (!v.ok) return err(reply, 400, v.error);
      return deps.upsertConfig(orgId, v.patch);
    });

    done();
  };
}

const READABLE = "lambda, gain_shift, theta, zk_enabled, audit_enabled, webhook_url";

/** Live config store over Supabase org_config (service-role). */
export function createSupabaseConfigDeps(client: SupabaseClient): ConfigDeps {
  return {
    async getConfig(orgId: string): Promise<OrgConfig | null> {
      const { data, error } = await client.from("org_config").select(READABLE).eq("org_id", orgId).limit(1);
      if (error) throw new Error(`getConfig failed: ${error.message}`);
      return ((data ?? [])[0] as OrgConfig | undefined) ?? null;
    },
    async upsertConfig(orgId: string, patch: OrgConfigPatch): Promise<OrgConfig> {
      const { data, error } = await client
        .from("org_config")
        .upsert({ org_id: orgId, ...patch }, { onConflict: "org_id" })
        .select(READABLE)
        .limit(1);
      if (error) throw new Error(`upsertConfig failed: ${error.message}`);
      const row = (data ?? [])[0] as OrgConfig | undefined;
      if (!row) throw new Error("upsertConfig returned no row");
      return row;
    },
  };
}
