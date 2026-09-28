/// <reference types="@cloudflare/workers-types" />
/**
 * CQ Proxy — Cloudflare Worker Entry Point (Phase 2+, the blueprint's edge target, ADR-0005).
 *
 * THIN ADAPTER: all request-handling LOGIC lives in ./worker-core.ts (pure, Node-typed, fully
 * unit-tested). This file only adapts the CF `fetch(request, env)` runtime to that core and back.
 *
 * VERIFICATION HONESTY: the Fastify server (./index.ts) is the working, smoke-booted Node deploy.
 * This Worker's LOGIC is unit-tested (worker-core), but the CF RUNTIME/DEPLOY is NOT verified here
 * (no CF account). Before production: `wrangler dev` + a real deploy. The Durable Object below is a
 * Phase-2+ placeholder (per-session hot state); the basic measurement/forward path does not need it.
 */

import { routeWorkerRequest, healthBody, forwardMessages, resolveBaseUrl, type FetchLike } from "./worker-core";

export interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
  SESSION_STATE?: DurableObjectNamespace;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function errorBody(type: string, message: string): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = routeWorkerRequest(request.method, url.pathname);

    if (route.kind === "health") return json(healthBody());

    if (route.kind === "messages") {
      if (!env.ANTHROPIC_API_KEY) return json(errorBody("config_error", "ANTHROPIC_API_KEY is not configured"), 500);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(errorBody("request_error", "invalid JSON body"), 400);
      }
      try {
        const baseUrl = resolveBaseUrl(env.ANTHROPIC_BASE_URL);
        // The CF global fetch satisfies FetchLike structurally (status + text()).
        const upstream = await forwardMessages(body, env.ANTHROPIC_API_KEY, fetch as unknown as FetchLike, baseUrl);
        return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json" } });
      } catch (e) {
        return json(errorBody("internal_proxy_error", e instanceof Error ? e.message : String(e)), 502);
      }
    }

    return json(errorBody("not_found", `no route for ${request.method} ${url.pathname}`), 404);
  },
};

/**
 * SessionDurableObject — per-session strongly-consistent Tier-1 hot state (Phase 2+ placeholder).
 * The basic measurement/forward Worker above does not use it; implementing the DO (alarms, storage)
 * is a later slice gated on a CF account to verify.
 */
export class SessionDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  /** Not yet implemented — returns 501 so a misconfigured binding fails loudly rather than silently. */
  fetch(_request: Request): Response {
    void this.state;
    return new Response(JSON.stringify({ type: "error", error: { type: "not_implemented", message: "SessionDurableObject is a Phase-2+ placeholder" } }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  }
}
