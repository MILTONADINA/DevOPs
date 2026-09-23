/**
 * Webhook API (Phase 2+ commercial) — the test-send endpoint (docs/WEBHOOKS.md §Testing).
 *
 *   POST /v1/webhooks/test  body { "event_type": "conflict.detected" | ... }
 *     → builds a sample event of that type, signs it (X-CQ-Signature), and delivers it to the org's
 *       configured webhook_url. Lets an operator verify their endpoint + signature handling.
 *
 * Org scope from req.orgId (the auth gate) with a ?org-id fallback. The webhook config + delivery
 * are INJECTED (WebhookDeps) so the route is testable with no DB / no network; the secret is read
 * server-side only (never exposed via GET /v1/config). Composes src/webhooks/* (sign + envelope +
 * SSRF-guarded delivery).
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, isWebhookEventType, SAMPLE_EVENT_DATA, WEBHOOK_EVENT_TYPES } from "../../webhooks/events";
import { deliverWebhook, type DeliveryResult } from "../../webhooks/deliver";

export interface WebhookConfig {
  url: string;
  secret: string;
}

export interface WebhookDeps {
  /** The org's webhook url + secret (server-side only), or null if unconfigured. */
  getWebhookConfig: (orgId: string) => Promise<WebhookConfig | null>;
  /** Sign + deliver a payload to the url. */
  deliver: (url: string, payload: string, secret: string) => Promise<DeliveryResult>;
}

function resolveOrg(req: FastifyRequest): string | undefined {
  if (typeof req.orgId === "string" && req.orgId !== "") return req.orgId;
  // Auth ENFORCED (commercial): the org comes from the key, never a client-supplied ?org-id (cross-tenant
  // guard if the gate is ever bypassed). Personal mode (authEnforced unset) keeps the ?org-id convenience.
  if (req.authEnforced === true) return undefined;
  const v = (req.query as Record<string, unknown>)["org-id"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function err(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).send({ type: "error", error: { type: "request_error", message } });
}

/**
 * Build the webhook API plugin.
 *
 * @param deps - the webhook config source + delivery (a fake in tests, Supabase + fetch in prod).
 * @returns a plugin registering POST /v1/webhooks/test.
 */
export function makeWebhookRoute(deps: WebhookDeps): FastifyPluginCallback {
  return function webhookPlugin(app: FastifyInstance, _opts, done): void {
    app.post("/v1/webhooks/test", async (req, reply) => {
      const orgId = resolveOrg(req);
      if (orgId === undefined) return err(reply, 400, "org id required (authenticate, or pass ?org-id)");
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isWebhookEventType(body["event_type"])) {
        return err(reply, 400, `event_type must be one of: ${WEBHOOK_EVENT_TYPES.join(", ")}`);
      }
      const eventType = body["event_type"];
      const cfg = await deps.getWebhookConfig(orgId);
      if (cfg === null || cfg.url === "" || cfg.secret === "") {
        return err(reply, 400, "no webhook_url + webhook_secret configured for this org (set them via PATCH /v1/config)");
      }
      const event = buildEvent(eventType, orgId, SAMPLE_EVENT_DATA[eventType], `evt_${randomUUID()}`, new Date().toISOString());
      const result = await deps.deliver(cfg.url, JSON.stringify(event), cfg.secret);
      return reply.code(result.delivered ? 200 : 502).send({ event_type: eventType, sent_to: cfg.url, ...result });
    });
    done();
  };
}

/** Live webhook deps over Supabase (org_config) + an injectable fetch for delivery. */
export function createSupabaseWebhookDeps(
  client: SupabaseClient,
  doFetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }> = (url, init) => fetch(url, init),
): WebhookDeps {
  return {
    async getWebhookConfig(orgId: string): Promise<WebhookConfig | null> {
      const { data, error } = await client.from("org_config").select("webhook_url, webhook_secret").eq("org_id", orgId).limit(1);
      if (error) throw new Error(`getWebhookConfig failed: ${error.message}`);
      const row = (data ?? [])[0] as { webhook_url: string | null; webhook_secret: string | null } | undefined;
      if (!row || !row.webhook_url || !row.webhook_secret) return null;
      return { url: row.webhook_url, secret: row.webhook_secret };
    },
    deliver: (url, payload, secret) => deliverWebhook(url, payload, secret, doFetch),
  };
}
