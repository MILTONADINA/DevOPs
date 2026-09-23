/**
 * Cloudflare Worker request-handling core (Phase 2+) — PURE + runtime-agnostic.
 *
 * The Fastify proxy (app.ts) is the working Node deploy target; this is the blueprint's EDGE
 * target (ADR-0005). CF Workers can't use the axios forward (forward.ts) — they use global fetch —
 * so the forwarding is reimplemented here behind an injectable {@link FetchLike}. This module is
 * Node-typed + fully unit-tested; worker.ts is the thin CF adapter that calls it.
 *
 * HONESTY: the CF *runtime/deploy* is NOT verified here (no CF account). The LOGIC below is unit-
 * tested with real inputs + a fake fetch; verify the deploy with `wrangler dev` + a real deploy
 * before production.
 */

export type WorkerRoute = { kind: "health" } | { kind: "messages" } | { kind: "not_found" };

/** Route a request by method + path (pure). Mirrors the Fastify proxy's Phase-1 surface. */
export function routeWorkerRequest(method: string, path: string): WorkerRoute {
  if (method === "GET" && path === "/health") return { kind: "health" };
  if (method === "POST" && path === "/v1/messages") return { kind: "messages" };
  return { kind: "not_found" };
}

/** The /health body (the edge Worker variant). */
export function healthBody(): { status: string; phase: string; runtime: string } {
  return { status: "ok", phase: "2+-edge-worker", runtime: "cloudflare-worker" };
}

/** The minimal upstream-response shape the forward needs (a global `Response` satisfies it). */
export interface UpstreamResponse {
  status: number;
  text(): Promise<string>;
}

/** The minimal fetch shape (a global `fetch` satisfies it) — injected so the forward is testable. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<UpstreamResponse>;

/** Resolve + validate the upstream base URL (http(s) only; trailing slashes stripped). */
export function resolveBaseUrl(raw: string | undefined): string {
  const candidate = raw !== undefined && raw !== "" ? raw : "https://api.anthropic.com";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`invalid ANTHROPIC base URL: ${candidate}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`ANTHROPIC base URL must be http(s): ${candidate}`);
  return candidate.replace(/\/+$/, "");
}

/**
 * Forward a messages body to upstream Anthropic (UNCHANGED — Phase 1 forwarding semantics), via
 * the injected fetch. Returns the upstream status + raw body so the adapter can pass them through.
 *
 * @param body - the Anthropic-shaped request body (forwarded verbatim).
 * @param apiKey - the upstream Anthropic key.
 * @param doFetch - the fetch implementation (global fetch in prod, a fake in tests).
 * @param baseUrl - the resolved upstream base URL.
 * @returns the upstream status + body text.
 */
export async function forwardMessages(body: unknown, apiKey: string, doFetch: FetchLike, baseUrl: string): Promise<{ status: number; body: string }> {
  const r = await doFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}
