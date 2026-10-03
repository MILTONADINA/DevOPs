/**
 * CQ Proxy — Fastify application factory (Phase 1 measurement proxy).
 *
 * `buildProxy()` constructs and returns a Fastify instance WITHOUT listening,
 * so it is fully testable via `app.inject()`. The side-effectful entry point
 * (listen + graceful shutdown) lives in ./index.ts, which imports this factory.
 *
 * Phase 1 measures tokens + captures/redacts traffic; it does NOT prune.
 */

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { logger } from "../lib/logger";
import { makeHealthRoute, type HealthDeps } from "./routes/health";
import { makeMessagesRoute } from "./routes/messages";
import { makeDashboardRoute, type DashboardDeps } from "./routes/dashboard";
import { makeUsageRoute, type UsageDeps } from "./routes/usage";
import { makeConfigRoute, type ConfigDeps } from "./routes/config";
import { makeMemoryRoute, type MemoryDeps } from "./routes/memory";
import { makeSessionsRoute, type SessionsDeps } from "./routes/sessions";
import { makeWebhookRoute, type WebhookDeps } from "./routes/webhooks";
import { makeTokensRoute, type TokensDeps } from "./routes/tokens";
import { planRequestsPerMinute } from "./rate-limit-tiers";
import { OPENAPI_SPEC, OPENAPI_DOCS_HTML } from "./openapi";
import { registerAuth, type AuthDeps } from "./auth";
import type { MessagesDeps } from "./forward";
import { isLoopbackBindAddress, resolveRateLimitMax } from "./network-settings";

export interface BuildProxyOptions {
  /**
   * When true, registers @fastify/cors. Default true. Tests can disable to keep
   * the injected app minimal.
   */
  cors?: boolean;
  /**
   * The port the proxy is about to listen on (or already listening on). Used only by REQ-2's Host
   * check (specs/security/stratum-local-network.md): when set, a Host that names a loopback name, or
   * matches a `DEVOPS_PROXY_ALLOWED_HOSTS` entry that carries no port, must carry no port or exactly
   * this one. `start()` always passes this (via baseOptions()). A caller that builds the app
   * directly, such as a test built on `app.inject()`, may omit it: a loopback name is then accepted
   * with any port, and a portless allow-list entry matches only a Host that has no port.
   */
  listenPort?: number;
  /**
   * The bind host the proxy is about to listen on (or already listening on). Used only by REQ-2's
   * Host check: when this is ITSELF a loopback bind address ({@link isLoopbackBindAddress}), its own
   * literal value is accepted as a Host name too (REQ-2's Definitions entry for a loopback name) —
   * besides the three fixed loopback names 127.0.0.1, localhost and [::1] — case-insensitively, with
   * the same port rule as those names. A non-loopback `listenHost` (e.g. "0.0.0.0") adds nothing.
   * `start()` always passes this (via baseOptions()). A caller that builds the app directly, such as
   * a test built on `app.inject()`, may omit it: the loopback names are then just the three fixed
   * ones.
   */
  listenHost?: string;
  /**
   * Per-IP rate limit. `false` disables the limiter, with or without `rateLimitByPlan` (used by most
   * tests). When `rateLimitByPlan` is not set, a number sets the max requests per window and
   * bypasses RATE_LIMIT_MAX entirely (it is never read), and omitted validates and uses
   * RATE_LIMIT_MAX env (default 100, via {@link resolveRateLimitMax}) over RATE_LIMIT_WINDOW
   * (default "1 minute") — an invalid RATE_LIMIT_MAX then throws from buildProxy() itself
   * (specs/security/stratum-local-network.md REQ-4). With `rateLimitByPlan` set (and `rateLimit` not
   * `false`) the org's plan decides the limit: a number here is ignored and RATE_LIMIT_MAX is never read.
   * Protects the proxy + the upstream Anthropic key from runaway clients.
   */
  rateLimit?: false | number;
  /**
   * Dependencies for POST /v1/messages (forward + token-count + capture). When
   * omitted, the route is NOT registered (health-only mode — used by health
   * tests and any deploy that wires deps separately). The entry point supplies
   * the production deps via createDefaultMessagesDeps().
   */
  messages?: MessagesDeps;
  /**
   * Dependencies for GET /dashboard + /dashboard/api (the session reader). When
   * omitted, the dashboard is not registered. The entry point supplies a reader
   * over data/sessions/*.json.
   */
  dashboard?: DashboardDeps;
  /**
   * Multi-tenant API-key auth (v1.0.0). When omitted, the proxy is UNAUTHENTICATED
   * (the Phase-1 personal-use default). When supplied, every non-public request must
   * carry a valid key, whose org is attached to req.orgId. Opt-in so personal use is
   * unaffected; the commercial deploy supplies a Supabase-backed resolver.
   */
  auth?: AuthDeps;
  /**
   * The usage read API (GET /v1/billing/summary + /v1/billing/records): token totals, effectiveness
   * and an estimated USD cost difference, with no fee, plan minimum or amount due
   * (specs/ops/payment-removal.md REQ-3). When omitted, the routes are not registered.
   * createSupabaseUsageDeps(client) supplies the live source; buildStartOptions sets it in team
   * mode (CQ_COMMERCIAL) only, never in personal mode.
   */
  usage?: UsageDeps;
  /**
   * The org config API (GET + PATCH /v1/config). When omitted, not registered. The commercial
   * deploy supplies createSupabaseConfigDeps(client).
   */
  config?: ConfigDeps;
  /**
   * The memory API (facts / suppress / conflicts). When omitted, not registered. The commercial
   * deploy supplies createSupabaseMemoryDeps(client).
   */
  memory?: MemoryDeps;
  /**
   * The sessions API (list / metadata / stats). When omitted, not registered. The commercial
   * deploy supplies createSupabaseSessionsDeps(client).
   */
  sessions?: SessionsDeps;
  /**
   * The webhook API (POST /v1/webhooks/test). When omitted, not registered. The commercial deploy
   * supplies createSupabaseWebhookDeps(client).
   */
  webhooks?: WebhookDeps;
  /**
   * The token-count API (POST /v1/tokens/count). When omitted, not registered. Commercial mode
   * reuses the messages counter.
   */
  tokens?: TokensDeps;
  /**
   * Per-PLAN request rate limiting (docs/RATE_LIMITS.md). When provided (commercial mode), requests
   * are limited per-ORG by the org's plan (requests/min) — `getPlan` resolves the plan. When omitted,
   * the limiter is the per-IP fixed `rateLimit` max (personal mode). Requires `auth` (the org is read
   * from req.orgId), so the rate limiter is registered AFTER the auth gate.
   */
  rateLimitByPlan?: { getPlan: (orgId: string) => Promise<string> };
  /**
   * Optional dependency checkers for GET /health (e.g. a cached Supabase ping). When omitted,
   * /health is liveness-only (the personal-use default).
   */
  health?: HealthDeps;
}

// --- specs/security/stratum-local-network.md — REQ-1 (CORS) + REQ-2 (Host). "Auth configured"
// (the spec's Definitions entry) is exactly `opts.auth !== undefined` — the same presence check the
// auth gate below uses (`if (opts.auth)`); buildStartOptions() (index.ts) sets `opts.auth` when
// `commercialEnabled()` is true, so this file reads that predicate through `opts.auth` rather than
// adding a second one. ---

/** The three fixed loopback Host names of REQ-2's Definitions entry, compared case-insensitively. */
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Split a comma-separated env value into trimmed, non-empty entries (case preserved). */
function parseCommaList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Strip one trailing "." (an absolute-FQDN dot) from a hostname. */
function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * Split a Host-header-shaped string into its bare name and (if present) numeric port, honoring the
 * bracketed IPv6-literal form (`[::1]:8080`). `host` must already be trimmed + lowercased. A
 * trailing `:<non-digits>` is left attached to `name` (not a port), so a malformed Host never
 * spoofs a bare loopback name.
 */
function splitHostPort(host: string): { name: string; port?: number } {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return { name: host };
    const name = host.slice(0, close + 1);
    const rest = host.slice(close + 1);
    // Any remainder other than exactly `:<digits>` (a bare trailing ":", non-digit garbage, or extra
    // ":"-separated junk) returns the WHOLE original string as `name` — mirroring the unbracketed
    // branch's own `{ name: host }` fallback just below — so a malformed bracketed Host (e.g.
    // "[::1]:abc") never collapses to the bare bracket form ("[::1]") and spoofs a loopback name.
    return rest.startsWith(":") && /^\d+$/.test(rest.slice(1)) ? { name, port: Number(rest.slice(1)) } : { name: host };
  }
  const lastColon = host.lastIndexOf(":");
  return lastColon !== -1 && /^\d+$/.test(host.slice(lastColon + 1)) ? { name: host.slice(0, lastColon), port: Number(host.slice(lastColon + 1)) } : { name: host };
}

/**
 * The Host-header NAME form of a loopback bind address ({@link isLoopbackBindAddress}'s own three
 * cases; REQ-2's Definitions entry lets it name the proxy): the literal "::1" is bracketed, matching
 * how a Host header spells an IPv6 literal (`[::1]`); any other accepted spelling ("localhost", a
 * 127.0.0.0/8 address, an already-bracketed `[::1]`) is returned trimmed and lower-cased. Callers
 * only ever pass an address {@link isLoopbackBindAddress} already accepted, so no other input shape
 * is handled.
 */
function loopbackBindAddressHostName(addr: string): string {
  const a = addr.trim().toLowerCase();
  return a === "::1" ? "[::1]" : a;
}

/**
 * True when `host` (already trimmed + lowercased) is a loopback name per REQ-2's Definitions entry:
 * one of {@link LOOPBACK_HOST_NAMES} (the proxy's three fixed names, 127.0.0.1, localhost and
 * [::1]), OR `extraLoopbackName` when set (the proxy's configured `listenHost` itself, in its
 * Host-header NAME form, when that bind address is itself loopback — computed once by the caller
 * via {@link loopbackBindAddressHostName}, not re-derived per request) — each with or without a
 * port. Built on {@link splitHostPort}, so the name and the port of the request's Host are checked
 * separately.
 *
 * When `listenPort` is known, a present port must equal it exactly — for either the fixed names or
 * `extraLoopbackName`. When `listenPort` is unset (a test built directly on `app.inject()`; the
 * real proxy's `start()` always supplies it, via baseOptions()), the port is not compared at all:
 * only the name matters.
 *
 * @param host - the request's Host header, already trimmed + lowercased.
 * @param listenPort - the proxy's already-resolved listen port, when known.
 * @param extraLoopbackName - the configured listenHost's own Host-header name, when it is itself
 *   loopback; `undefined` when listenHost is unset or is not itself loopback.
 */
function isLoopbackHost(host: string, listenPort: number | undefined, extraLoopbackName: string | undefined): boolean {
  const { name, port } = splitHostPort(host);
  if (!LOOPBACK_HOST_NAMES.has(name) && name !== extraLoopbackName) return false;
  if (port === undefined) return true;
  return listenPort === undefined || port === listenPort;
}

/**
 * True when `host` (trimmed + lowercased) matches a `DEVOPS_PROXY_ALLOWED_HOSTS` entry (REQ-2): an
 * entry that carries its own port matches only that exact host+port; a portless entry matches a
 * portless host, or a host whose port equals `listenPort`. Both sides are compared with one
 * trailing dot stripped.
 */
function matchesAllowedHostsEntry(host: string, entries: string[], listenPort: number | undefined): boolean {
  const { name: hostName, port: hostPort } = splitHostPort(host);
  const strippedHost = stripTrailingDot(hostName);
  for (const entry of entries) {
    const { name: entryName, port: entryPort } = splitHostPort(entry);
    if (stripTrailingDot(entryName) !== strippedHost) continue;
    if (entryPort !== undefined ? hostPort === entryPort : hostPort === undefined || hostPort === listenPort) return true;
  }
  return false;
}

/** Send REQ-1/REQ-2's 403 refusal, JSON-shaped like buildProxy()'s own error handler below. */
function sendForbidden(reply: FastifyReply, type: string, message: string): FastifyReply {
  return reply.code(403).send({ type: "error", error: { type, message } });
}

/** Send REQ-2's 400 refusal for a request with more than one Host header, JSON-shaped like {@link sendForbidden}. */
function sendBadRequest(reply: FastifyReply, type: string, message: string): FastifyReply {
  return reply.code(400).send({ type: "error", error: { type, message } });
}

/**
 * True when `rawHeaders` — Node's flat `[name, value, name, value, ...]` array
 * ({@link import("node:http").IncomingMessage.rawHeaders}) — carries more than one `Host` header
 * line, matched case-insensitively by name (REQ-2's last sentence; RFC 9112 §3.2 has a server
 * respond with 400 to a request message that contains more than one Host header field line).
 * Deliberately reads the RAW wire headers, not `req.headers.host`: Node's
 * own HTTP parser already folds a repeated `host` entry in `.headers` down to just the first value
 * it saw, silently discarding the rest — so that property can never reveal a duplicate no matter how
 * the request was sent. Only a real socket can exercise this (see local-network.test.ts's
 * `rawRequest` helper): `app.inject()`'s `rawHeaders` is built from `Object.keys()` of a plain
 * headers object, which cannot hold the same key twice either.
 */
function hasDuplicateHostHeader(rawHeaders: string[]): boolean {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") count++;
  }
  return count > 1;
}

/**
 * Build the proxy Fastify instance (no network listen).
 *
 * @param opts - optional feature toggles.
 * @returns A configured (but not-yet-listening) Fastify instance. Call
 *          `await app.ready()` before `app.inject()`, or `app.listen()` to serve.
 * @throws {Error} naming RATE_LIMIT_MAX and the rejected raw value (specs/security/
 *   stratum-local-network.md REQ-4) when `opts.rateLimit` is omitted (it is neither a number nor
 *   `false`), `opts.rateLimitByPlan` is not set, and `process.env.RATE_LIMIT_MAX` is set but is
 *   not a positive integer — see {@link resolveRateLimitMax}.
 */
export function buildProxy(opts: BuildProxyOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const authConfigured = opts.auth !== undefined;
  // REQ-2's auth-configured allow-list: unset means "accept any Host"; set (even to "") narrows it
  // to its entries plus the loopback names. Read once here, not on every request.
  const allowedHostsRaw = process.env["DEVOPS_PROXY_ALLOWED_HOSTS"];
  const allowedHosts = allowedHostsRaw !== undefined ? parseCommaList(allowedHostsRaw).map((entry) => entry.toLowerCase()) : undefined;
  // REQ-2's Definitions entry for a loopback name: when the configured listenHost is itself a
  // loopback bind address, its own Host-header name counts as a loopback name too, wherever the
  // loopback names are checked below (personal mode, and auth-configured mode with an allow-list) —
  // computed once here, like allowedHosts just above, not on every request.
  const configuredLoopbackHostName = opts.listenHost !== undefined && isLoopbackBindAddress(opts.listenHost) ? loopbackBindAddressHostName(opts.listenHost) : undefined;

  // REQ-1 + REQ-2 (specs/security/stratum-local-network.md): one onRequest hook, registered before the
  // @fastify/cors plugin because Fastify installs a hook added with addHook() after the plugins
  // registered before it, so registering it first makes the Host and duplicate-Host refusals run
  // before the CORS plugin can answer a preflight.
  // Independent of `opts.cors`: even with `cors: false` — a test-only knob; production never
  // sets it — this still enforces REQ-2's Host check, and /health is not exempt. Before either
  // mode branch below, it also refuses (400) any request whose raw headers carry more than one Host
  // line (REQ-2's last sentence) — independent of mode, and independent of what req.headers.host
  // itself folds to.
  app.addHook("onRequest", async (req, reply) => {
    // REQ-2's last sentence (RFC 9112 §3.2): checked first, against the RAW wire headers — see
    // hasDuplicateHostHeader()'s own doc for why req.headers.host itself can never reveal this.
    if (hasDuplicateHostHeader(req.raw.rawHeaders)) {
      return sendBadRequest(reply, "invalid_host", "Request has more than one Host header.");
    }

    const hostHeader = req.headers.host;
    const host = typeof hostHeader === "string" ? hostHeader.trim().toLowerCase() : undefined;

    if (!authConfigured) {
      // REQ-2: no auth configured -> every request needs a loopback Host.
      if (host === undefined || !isLoopbackHost(host, opts.listenPort, configuredLoopbackHostName)) {
        return sendForbidden(reply, "forbidden_host", "Host header is missing or is not a loopback address.");
      }
      // REQ-1: no auth configured -> no origin is ever allowed; refuse a preflight outright (a
      // simple request is still served, just never gets Access-Control-Allow-Origin — handled by
      // @fastify/cors's `origin: false` registered below).
      const isPreflight = req.method === "OPTIONS" && typeof req.headers.origin === "string" && typeof req.headers["access-control-request-method"] === "string";
      if (isPreflight) {
        return sendForbidden(reply, "forbidden_origin", "Cross-origin requests need DEVOPS_PROXY_CORS_ORIGINS configured with auth.");
      }
      return;
    }

    // REQ-2, auth configured: any Host is accepted unless DEVOPS_PROXY_ALLOWED_HOSTS is set, in
    // which case only its entries plus the loopback names are accepted (REQ-1's origin allow-list
    // is @fastify/cors's own job via the `origin` option registered below).
    if (allowedHosts !== undefined) {
      const allowed = host !== undefined && (isLoopbackHost(host, opts.listenPort, configuredLoopbackHostName) || matchesAllowedHostsEntry(host, allowedHosts, opts.listenPort));
      if (!allowed) {
        return sendForbidden(reply, "forbidden_host", "Host header is not on the DEVOPS_PROXY_ALLOWED_HOSTS allow-list.");
      }
    }
  });

  if (opts.cors !== false) {
    // Personal mode never allows any origin (REQ-1); auth-configured mode allows only
    // DEVOPS_PROXY_CORS_ORIGINS (comma-separated, empty by default — REQ-1's own default).
    void app.register(cors, authConfigured ? { origin: parseCommaList(process.env["DEVOPS_PROXY_CORS_ORIGINS"]) } : { origin: false });
  }

  // Auth gate (opt-in) — registered before the routes so it guards them all (it
  // exempts /health). Omitted in personal-use → no auth, unchanged behavior.
  if (opts.auth) {
    registerAuth(app, opts.auth);
  }

  // Rate limiting — AFTER auth so the per-plan limiter can read req.orgId. When `rateLimitByPlan`
  // is set (commercial), limit per-ORG by the org's plan (requests/min); else per-IP fixed max.
  if (opts.rateLimit !== false) {
    if (opts.rateLimitByPlan) {
      const resolvePlan = opts.rateLimitByPlan.getPlan;
      void app.register(rateLimit, {
        keyGenerator: (req) => (typeof req.orgId === "string" && req.orgId !== "" ? req.orgId : req.ip),
        max: async (req) => (typeof req.orgId === "string" && req.orgId !== "" ? planRequestsPerMinute(await resolvePlan(req.orgId)) : planRequestsPerMinute("starter")),
        timeWindow: "1 minute",
      });
      // Emit the spec's request rate-limit headers (docs/RATE_LIMITS.md) by mapping the limiter's
      // functional x-ratelimit-* headers to the documented -Requests names (+ ISO reset).
      app.addHook("onSend", async (req, reply, payload) => {
        const limit = reply.getHeader("x-ratelimit-limit");
        if (limit !== undefined) {
          void reply.header("x-ratelimit-limit-requests", limit);
          const remaining = reply.getHeader("x-ratelimit-remaining");
          if (remaining !== undefined) void reply.header("x-ratelimit-remaining-requests", remaining);
          const resetSec = reply.getHeader("x-ratelimit-reset");
          if (resetSec !== undefined) {
            const secs = Number(resetSec);
            void reply.header("x-ratelimit-reset-requests", Number.isFinite(secs) ? new Date(Date.now() + secs * 1000).toISOString() : String(resetSec));
          }
        }
        const tb = req.tokenBudgetHeaders;
        if (tb !== undefined) {
          void reply.header("x-ratelimit-limit-tokens", String(tb.limit));
          void reply.header("x-ratelimit-remaining-tokens", String(tb.remaining));
        }
        return payload;
      });
    } else {
      const max = typeof opts.rateLimit === "number" ? opts.rateLimit : resolveRateLimitMax(process.env);
      void app.register(rateLimit, { max, timeWindow: process.env["RATE_LIMIT_WINDOW"] ?? "1 minute" });
    }
  }

  void app.register(makeHealthRoute(opts.health));

  // Machine-readable API contract (public, like /health) — clients generate SDKs / render Swagger
  // from it. Not under /v1/, so the auth gate (protectedPrefixes: ["/v1/"]) exempts it.
  app.get("/openapi.json", async (_req, reply) => {
    void reply.header("content-type", "application/json; charset=utf-8");
    return OPENAPI_SPEC;
  });

  // Human-browsable API reference (public) — renders /openapi.json client-side, no CDN, XSS-safe.
  app.get("/docs", async (_req, reply) => {
    void reply.header("content-type", "text/html; charset=utf-8");
    return OPENAPI_DOCS_HTML;
  });

  if (opts.messages) {
    void app.register(makeMessagesRoute(opts.messages));
  }

  if (opts.dashboard) {
    void app.register(makeDashboardRoute(opts.dashboard));
  }

  if (opts.usage) {
    void app.register(makeUsageRoute(opts.usage));
  }

  if (opts.config) {
    void app.register(makeConfigRoute(opts.config));
  }

  if (opts.memory) {
    void app.register(makeMemoryRoute(opts.memory));
  }

  if (opts.sessions) {
    void app.register(makeSessionsRoute(opts.sessions));
  }

  if (opts.webhooks) {
    void app.register(makeWebhookRoute(opts.webhooks));
  }

  if (opts.tokens) {
    void app.register(makeTokensRoute(opts.tokens));
  }

  app.setErrorHandler((err, _req, reply) => {
    // Honor the error's own statusCode (rate-limit → 429, validation → 400,
    // etc.); only genuinely-unknown errors fall through to 500. Forcing 500
    // unconditionally would mask the plugin/framework status (e.g. rate limit).
    const e = err as Error & { statusCode?: number };
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    const type = status === 429 ? "rate_limit_error" : status >= 500 ? "internal_proxy_error" : "request_error";
    logger.error({ err: e.message, status }, "proxy error");
    // 5xx messages must NOT reach the client: route deps wrap raw Supabase errors as
    // `throw new Error("X failed: " + error.message)`, which can carry table/column/constraint names
    // (schema disclosure). The full error is in the server log above; the client gets a generic string.
    // 4xx messages are framework/validation-generated (rate-limit, the isoParam 400) and safe to surface.
    const clientMessage = status >= 500 ? "an internal error occurred" : e.message;
    void reply.status(status).send({
      type: "error",
      error: { type, message: clientMessage },
    });
  });

  return app;
}
