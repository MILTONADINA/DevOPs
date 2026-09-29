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
 * Usage (settings come from the process environment only; runtime/.env is not loaded):
 *   npm run dev                          # personal; needs ANTHROPIC_API_KEY (or another provider)
 *   CQ_COMMERCIAL=true npm run dev       # commercial (needs SUPABASE_*)
 * In the proxy's own environment ANTHROPIC_BASE_URL is the UPSTREAM (default https://api.anthropic.com).
 * Point a client at the proxy by setting ANTHROPIC_BASE_URL=http://localhost:4080 in the client's shell.
 */

import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { isIPv6 } from "node:net";
import os from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";
import { buildProxy, type BuildProxyOptions } from "./app";
import { createDefaultMessagesDeps } from "./default-deps";
import { isLoopbackBindAddress, resolvePort, resolveRateLimitMax } from "./network-settings";
import { readSessionsFromDir } from "./routes/dashboard";
import type { MessagesDeps } from "./forward";
import { resolveApiKeyVia } from "./auth";
import { createSupabaseConfigDeps } from "./routes/config";
import { createSupabaseMemoryDeps } from "./routes/memory";
import { createSupabaseBillingDeps } from "./routes/billing";
import { createSupabaseSessionsDeps } from "./routes/sessions";
import { createSupabaseWebhookDeps } from "./routes/webhooks";
import { createSupabaseStripeWebhookDeps } from "./routes/stripe-webhook";
import { createSupabaseUsageRecorder } from "../billing/usage-recorder";
import { createLocalUsageOutbox } from "../billing/durable-usage-outbox";
import { createTokenBudget } from "./token-budget";
import { createSupabaseHealthCheck } from "./routes/health";
import { createFactExtractor } from "../memory/warm/extractor";
import { createLocalFactCompletion } from "../memory/warm/local-completion";
import { createSupabaseMessageMemoryRecorder } from "./message-memory";
import { createSupabaseConversationResolver } from "./conversation";
import { createShadowObserver } from "./shadow-observer";
import { createOnnxEncoder } from "../pruner/encoder";
import { createQueryFactCandidateLookup } from "../memory/warm/query-fact-exchanges";
import {
  createExchangeFunctionLookup,
  createFactExchangeCoverageLookup,
  createFreshFunctionSupersessionLookup,
  createProjectFunctionSupersessionLookup,
} from "../memory/warm/exchange-function-entities";

export interface StartEnv {
  CQ_COMMERCIAL?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_KEY?: string | undefined;
  /** Stripe endpoint signing secret (whsec_…). When set in commercial mode, wires POST /stripe/webhook. */
  STRIPE_WEBHOOK_SECRET?: string | undefined;
  /** Dedicated billing-record signing secret. When set in commercial mode, the request path persists usage. */
  CQ_BILLING_SIGNING_SECRET?: string | undefined;
  CQ_USAGE_OUTBOX_DIR?: string | undefined;
  VERCEL?: string | undefined;
  /** Local model used only for structured fact extraction. */
  CQ_MEMORY_EXTRACT_MODEL?: string | undefined;
  CQ_LOCAL_BASE_URL?: string | undefined;
  CQ_LOCAL_API_KEY?: string | undefined;
  CQ_AUDIT_REPO_ROOT?: string | undefined;
  DEVOPS_STRATUM_PROJECT_ROOT?: string | undefined;
  CQ_SHADOW_OBSERVE?: string | undefined;
  /** Canonical bind-host setting (specs/security/stratum-local-network.md REQ-3). */
  DEVOPS_PROXY_HOST?: string | undefined;
  /** Deprecated one-release alias for {@link DEVOPS_PROXY_HOST} (REQ-3); DEVOPS_PROXY_HOST wins when both are set. */
  HOST?: string | undefined;
  /** Opt-in (must be the literal `"1"`) to bind a non-loopback address with no auth configured (REQ-3). */
  DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED?: string | undefined;
  /** Listen port (specs/security/stratum-local-network.md REQ-4); must be an integer from 1 to 65535 when set. */
  PORT?: string | undefined;
  /** Per-IP rate-limit ceiling (specs/security/stratum-local-network.md REQ-4); must be a positive integer when set. */
  RATE_LIMIT_MAX?: string | undefined;
  /** Upstream Anthropic API base URL (specs/security/stratum-local-network.md REQ-5). */
  ANTHROPIC_BASE_URL?: string | undefined;
  /** Upstream OpenAI-compatible API base URL (REQ-5). */
  OPENAI_BASE_URL?: string | undefined;
  /** Upstream OpenRouter API base URL (REQ-5). */
  OPENROUTER_BASE_URL?: string | undefined;
  /** Upstream Gemini API base URL (REQ-5). */
  GEMINI_BASE_URL?: string | undefined;
  /**
   * Opt-in (must be the literal `"1"`) to allow plain http to a non-loopback upstream base URL
   * (REQ-5). Does NOT bypass the self-loop refusal below, which has no opt-out.
   */
  DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM?: string | undefined;
}

/** Resolve a local Git checkout without following a path outside the project. */
export function resolveAuditRepoRoot(requested: string, projectRoot: string): string {
  if (!projectRoot) throw new Error("DEVOPS_STRATUM_PROJECT_ROOT is required for request-path audit");
  const root = realpathSync(projectRoot);
  const candidate = path.resolve(root, requested);
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("audit repository is outside project root");
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("symbolic link in audit repository path is forbidden");
  }
  if (!lstatSync(candidate).isDirectory()) throw new Error("audit repository must be a directory");
  return candidate;
}

function localExtractionUrl(raw: string | undefined): string {
  if (!raw) throw new Error("CQ_LOCAL_BASE_URL is required for local memory extraction");
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("memory extraction requires a loopback HTTP model endpoint");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * The bare literal of a bracketed IPv6 literal (`[::1]` gives `::1`); any other value comes back as
 * it was. Node cannot listen on the bracketed spelling (`net.Server.listen({ host: "[::1]" })` fails
 * with ENOTFOUND, `getaddrinfo ENOTFOUND [::1]`), so the bind host has to be the bare literal. The
 * value must start with `[`, end with `]` and hold, between them, text that `net.isIPv6` accepts:
 * `[::1`, `::1]`, `[[::1]]`, `[::1]:4080`, `[localhost]`, `[127.0.0.1]` and `[ ::1 ]` are returned as
 * they were, and {@link isLoopbackBindAddress} rejects every one of them (REQ-3, AC-4). Unlike
 * {@link unbracketHostname}, which takes a hostname that `URL` has already parsed, this checks the
 * whole value.
 *
 * @param host - the trimmed bind-host setting.
 * @returns the bare IPv6 literal, or `host` itself.
 */
function unbracketIpv6Literal(host: string): string {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : "";
  return isIPv6(inner) ? inner : host;
}

/**
 * Resolve the bind host. Canonically read from `DEVOPS_PROXY_HOST`; `HOST` is honoured for one
 * release as a deprecated alias (specs/security/stratum-local-network.md REQ-3) and is used only
 * when `DEVOPS_PROXY_HOST` is unset or blank — when both are set, `DEVOPS_PROXY_HOST` wins. Defaults
 * to 127.0.0.1 (loopback), so the proxy is reachable only from the machine it runs on: DevOps runs on
 * the user's own machine, with no hosted deployment (ADR-0025). A non-loopback bind (0.0.0.0, or one
 * of the machine's own network addresses) is needed to serve another device on the user's own
 * network, and start() refuses it unless auth is configured or
 * DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 is set ({@link assertRemoteBindAllowed}, REQ-3). The
 * opt-in only allows the bind: with no auth the proxy still answers 403 to any request whose Host
 * header is not a loopback name (REQ-2), so reaching the proxy from another device by its address
 * takes auth (CQ_COMMERCIAL with Supabase credentials), and DEVOPS_PROXY_ALLOWED_HOSTS then pins
 * which Host names it accepts.
 * A bracketed IPv6 literal such as `[::1]`, the URL spelling, is returned without its brackets
 * ({@link unbracketIpv6Literal}) because Node cannot listen on the bracketed spelling; every other
 * value is returned trimmed and otherwise as written.
 *
 * @param env - the process env (reads DEVOPS_PROXY_HOST, falling back to the deprecated HOST alias).
 * @returns the host to bind.
 */
export function resolveListenHost(env: { HOST?: string | undefined; DEVOPS_PROXY_HOST?: string | undefined }): string {
  const canonical = env.DEVOPS_PROXY_HOST;
  if (typeof canonical === "string" && canonical.trim() !== "") return unbracketIpv6Literal(canonical.trim());
  const alias = env.HOST;
  if (typeof alias === "string" && alias.trim() !== "") return unbracketIpv6Literal(alias.trim());
  return "127.0.0.1";
}

/**
 * True whenever the deprecated `HOST` alias supplies a non-blank value, independent of whether
 * `DEVOPS_PROXY_HOST` is ALSO set. REQ-3's second bullet (specs/security/stratum-local-network.md)
 * has the proxy log a warning that names `DEVOPS_PROXY_HOST` when `HOST` is used; `start()` calls
 * this to decide whether to log that one-release deprecation warning. This function ignores
 * `DEVOPS_PROXY_HOST`, so with both non-blank it still returns true and the warning is still
 * logged, while {@link resolveListenHost} (the one place that decides the bind VALUE) picks
 * `DEVOPS_PROXY_HOST`.
 *
 * @param env - the process env (reads HOST only).
 * @returns whether HOST is the source of a non-blank value.
 */
export function usesDeprecatedHostAlias(env: { HOST?: string | undefined }): boolean {
  return typeof env.HOST === "string" && env.HOST.trim() !== "";
}

/** Commercial mode = the flag is on AND Supabase creds are present (else the multi-tenant store can't work). */
export function commercialEnabled(env: StartEnv): boolean {
  const on = env.CQ_COMMERCIAL === "true" || env.CQ_COMMERCIAL === "1";
  return on && typeof env.SUPABASE_URL === "string" && env.SUPABASE_URL !== "" && typeof env.SUPABASE_SERVICE_KEY === "string" && env.SUPABASE_SERVICE_KEY !== "";
}

/** Production entrypoints must never expose commercial messages without a billable store. */
export function assertCommercialStartup(env: StartEnv): void {
  if (env.CQ_COMMERCIAL !== "true" && env.CQ_COMMERCIAL !== "1") return;
  if (!env.SUPABASE_URL?.trim() || !env.SUPABASE_SERVICE_KEY?.trim()) throw new Error("commercial startup requires Supabase database credentials");
  if (!env.CQ_BILLING_SIGNING_SECRET?.trim()) throw new Error("commercial startup requires a dedicated billing signing secret");
  if (env.VERCEL && env.VERCEL !== "0") throw new Error("commercial billing requires persistent storage; Vercel serverless storage is ephemeral");
}

// isLoopbackBindAddress, resolvePort and resolveRateLimitMax are defined in ./network-settings.ts, a
// leaf module: app.ts needs isLoopbackBindAddress (its Host check) and resolveRateLimitMax (its
// per-IP rate-limit fallback) and cannot import them from this file without an
// app.ts → index.ts → app.ts cycle (this file imports buildProxy from ./app.ts). resolvePort has no
// app.ts caller; it sits beside resolveRateLimitMax, the other REQ-4 numeric-setting check. All
// three are re-exported here so that importers of `from "./index"` (start-options.test.ts, for one)
// keep working; start() itself uses the bindings imported at the top of this file.
export { isLoopbackBindAddress, resolvePort, resolveRateLimitMax };

/**
 * The warning for a bind that only the DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 opt-in allows
 * (REQ-3, AC-4): {@link assertRemoteBindAllowed} returns it and `start()` logs it. It says what the
 * opt-in does and no more: it allows the bind, and with no auth REQ-2 still answers 403 to any request
 * whose Host header is not a loopback name. It names DEVOPS_PROXY_ALLOWED_HOSTS as the way to pin the
 * accepted Host names, not as a requirement: with auth and no allow-list, any Host is accepted.
 */
const REMOTE_BIND_OPT_IN_WARNING =
  "DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 only allows this bind: the proxy is binding a non-loopback address with no authentication configured. " +
  "With no auth the proxy still answers 403 to any request whose Host header is not a loopback name (REQ-2 in specs/security/stratum-local-network.md). " +
  "To use the proxy from another device by its address, configure auth (CQ_COMMERCIAL with Supabase credentials); with auth, DEVOPS_PROXY_ALLOWED_HOSTS pins which Host names it accepts.";

/**
 * REQ-3's startup gate (specs/security/stratum-local-network.md): throws when `host` — the
 * ALREADY-RESOLVED bind address ({@link resolveListenHost}'s return value; this does not re-resolve
 * it) — is not a loopback address ({@link isLoopbackBindAddress}) AND no auth is configured
 * (`commercialEnabled(env)` is false) AND `env.DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED` is not the
 * literal string `"1"`. Otherwise it returns `undefined` for a loopback bind and for a bind that auth
 * allows, and {@link REMOTE_BIND_OPT_IN_WARNING} for a bind that only the opt-in allows, which
 * `start()` logs (AC-4's second bullet). Pure and side-effect-free (it only throws or returns) so
 * `start()` can call it before any network or database connection is attempted.
 *
 * @param host - the already-resolved bind address.
 * @param env - the relevant environment (the commercial-auth fields plus the opt-in).
 * @returns `undefined` when no warning applies, otherwise the warning text for `start()` to log.
 * @throws {Error} naming the three ways forward — bind loopback, configure auth, or set the opt-in —
 *   when the bind is both remote and unauthenticated.
 */
export function assertRemoteBindAllowed(host: string, env: StartEnv): string | undefined {
  if (isLoopbackBindAddress(host)) return undefined;
  if (commercialEnabled(env)) return undefined;
  if (env.DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED === "1") return REMOTE_BIND_OPT_IN_WARNING;
  throw new Error(
    `Refusing to bind ${host}: it is not a loopback address, and no authentication is configured. ` +
      "Choose one: bind to a loopback address (127.0.0.1, localhost, or ::1); configure auth (CQ_COMMERCIAL " +
      "with Supabase credentials); or set DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 to start anyway.",
  );
}

// --- specs/security/stratum-local-network.md — REQ-5 (upstream transport). Its self-loop bullet
// refuses a base URL whose host and port equal the proxy's own listen address; isSelfLoopHost below
// decides which hosts count as equal to a given listen host. ---

/** The proxy's own listen host is "bind-all" for the self-loop rule (REQ-5) when it is 0.0.0.0 or ::. */
function isBindAllListenHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "0.0.0.0" || h === "::";
}

/**
 * `URL#hostname` always keeps an IPv6 literal's brackets (`new URL("http://[::1]:1/").hostname ===
 * "[::1]"`), but the `listenHost` start() passes ({@link resolveListenHost} returns an IPv6 literal
 * without brackets) and this machine's interface addresses ({@link thisMachineInterfaceAddresses})
 * are written without them. Left unstripped, an IPv6 upstream host would never equal either in
 * {@link isSelfLoopHost}'s cases (1) and (3), so a self-loop through such an address (REQ-5) would
 * go unrecognised. Strip before any comparison below.
 */
function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * This machine's own interface addresses (lower-cased), for {@link isSelfLoopHost}'s case (3).
 * Recomputed on every call rather than cached: assertUpstreamAllowed runs this a handful of times
 * at startup only, never per-request.
 *
 * @param networkInterfaces - reads the interface table; `os.networkInterfaces` outside tests.
 */
function thisMachineInterfaceAddresses(networkInterfaces: typeof os.networkInterfaces): Set<string> {
  const addrs = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) addrs.add(info.address.toLowerCase());
  }
  return addrs;
}

/**
 * True when an upstream base URL's `host` is a self-loop of the proxy's own already-resolved
 * `listenHost` (REQ-5's self-loop bullet: a base URL whose host and port equal the proxy's own
 * listen address) — called only once the caller has already confirmed the ports are equal. Any one
 * of three cases is enough:
 *   (1) `host` equals `listenHost`, case-insensitively — the literal, exact-bind case (e.g.
 *       DEVOPS_PROXY_HOST=127.0.0.1 and an upstream also naming 127.0.0.1, or a shared non-loopback
 *       name);
 *   (2) `host` is a loopback name/address ({@link isLoopbackBindAddress}) AND
 *       `listenHost` is itself loopback OR bind-all (0.0.0.0 / ::) — a bind-all listener also answers
 *       on every loopback address, so a loopback upstream on the same port still talks to itself;
 *   (3) `listenHost` is bind-all AND `host` is one of this machine's own interface addresses
 *       ({@link thisMachineInterfaceAddresses}) — a bind-all listener also answers on every
 *       LAN/interface address this machine owns, not only loopback ones. `networkInterfaces` supplies
 *       those addresses, so a test can pass a stub table (start-options.test.ts, AC-6) instead of
 *       reading the machine it runs on.
 *
 * @param host - the upstream URL's (already-unbracketed) hostname.
 * @param listenHost - the proxy's own already-resolved bind address.
 * @param networkInterfaces - reads the interface table for case (3); `os.networkInterfaces` outside tests.
 */
function isSelfLoopHost(host: string, listenHost: string, networkInterfaces: typeof os.networkInterfaces): boolean {
  const h = host.trim().toLowerCase();
  const l = listenHost.trim().toLowerCase();
  if (h === l) return true;
  if (isLoopbackBindAddress(h) && (isLoopbackBindAddress(l) || isBindAllListenHost(l))) return true;
  if (isBindAllListenHost(l) && thisMachineInterfaceAddresses(networkInterfaces).has(h)) return true;
  return false;
}

/** The five REQ-5 upstream base-URL settings, checked in the order the requirement lists them. */
const UPSTREAM_BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL", "GEMINI_BASE_URL", "CQ_LOCAL_BASE_URL"] as const;

/**
 * REQ-5's startup gate (specs/security/stratum-local-network.md): for each of the five upstream
 * base-URL settings ({@link UPSTREAM_BASE_URL_VARS}) that is a non-empty string, throws an Error
 * naming that variable when EITHER:
 *   (a) it uses plain `http:` to a non-loopback host ({@link isLoopbackBindAddress} decides what is
 *       loopback, the SAME predicate {@link assertRemoteBindAllowed} uses: a wider address check than
 *       the loopback names app.ts accepts as a Host (the three fixed names, plus the configured
 *       listenHost itself when that is loopback), because that one validates an INBOUND request's
 *       Host header and this one an OUTBOUND endpoint the operator configured) AND
 *       `env.DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM` is not the literal string `"1"`; or
 *   (b) it is a self-loop of `listenHost`/`listenPort` (REQ-5's self-loop bullet) — same port AND
 *       {@link isSelfLoopHost}. A base URL that omits its port is compared on its scheme's default
 *       port (443 for `https:`, 80 otherwise), so `http://127.0.0.1` is a self-loop only when the
 *       proxy itself listens on port 80. This refusal has **no** opt-out (REQ-5's self-loop bullet
 *       names none, unlike its insecure-http bullet), so it is checked — and can throw — before
 *       rule (a) even looks at the opt-in.
 * Checked on the env value alone, independent of whether that provider's own API key is set — REQ-5
 * says "any provider base URL ... that uses plain http", with no "and is otherwise configured"
 * qualifier; this deliberately does NOT gate on resolveCredentials()/configuredProviders(), which
 * returns null/skips a provider whenever its credentials are unset (its API key, or its base URL
 * for the local provider). An `https:` URL is always exempt from rule
 * (a) (REQ-5 names "http" only) but can still be refused under rule (b). A value that is not a
 * parseable URL is refused too, naming the variable, since neither rule can otherwise be evaluated
 * (mirrors forward.ts's resolveAnthropicBaseUrl's own "not a parseable URL" message for the same var).
 * Pure and side-effect-free (only throws or returns), mirroring {@link assertRemoteBindAllowed}, so
 * start() can call it before any network or database connection is attempted.
 *
 * @param listenHost - the already-resolved bind address ({@link resolveListenHost}'s return value).
 * @param listenPort - the already-resolved listen port ({@link resolvePort}'s return value).
 * @param env - the relevant environment (the five base-URL vars plus the insecure-upstream opt-in).
 * @param networkInterfaces - where this machine's own interface addresses come from for rule (b)'s
 *   bind-all case ({@link isSelfLoopHost}, case (3)); `os.networkInterfaces` unless a test passes a stub.
 * @throws {Error} naming the offending variable when refused by rule (a) or (b), or unparseable.
 */
export function assertUpstreamAllowed(listenHost: string, listenPort: number, env: StartEnv, networkInterfaces: typeof os.networkInterfaces = os.networkInterfaces): void {
  for (const name of UPSTREAM_BASE_URL_VARS) {
    const raw = env[name];
    if (typeof raw !== "string" || raw === "") continue;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} is not a parseable URL: ${raw}`);
    }
    const host = unbracketHostname(url.hostname);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));

    // Rule (b) first, and unconditionally: the self-loop refusal has no opt-out.
    if (port === listenPort && isSelfLoopHost(host, listenHost, networkInterfaces)) {
      throw new Error(`Refusing to start: ${name} (${raw}) is a self-loop — it names this proxy's own listen address (${listenHost}:${listenPort}).`);
    }

    // Rule (a): plain http to a non-loopback host, unless the insecure-upstream opt-in is set.
    if (url.protocol === "http:" && !isLoopbackBindAddress(host) && env.DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM !== "1") {
      throw new Error(
        `Refusing to start: ${name} (${raw}) uses plain http to a non-loopback host. Use https, point it at a loopback ` + "address, or set DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM=1 to allow it anyway.",
      );
    }
  }
}

export type ClientFactory = (url: string, key: string) => SupabaseClient;

/**
 * Assemble buildProxy options from env: always the base (messages + dashboard); in COMMERCIAL mode,
 * additionally the multi-tenant auth gate (protecting /v1/*) + the config/memory/billing/sessions
 * APIs over Supabase. Billing mode opens a private local outbox; inject a fake client in tests.
 *
 * @param env - the relevant environment.
 * @param base - the always-on options (messages, dashboard).
 * @param makeClient - how to build a Supabase client (real in prod, a fake in tests).
 * @returns the {@link BuildProxyOptions} to pass to buildProxy.
 */
export function buildStartOptions(env: StartEnv, base: BuildProxyOptions, makeClient: ClientFactory): BuildProxyOptions {
  const opts: BuildProxyOptions = { ...base };
  if (commercialEnabled(env)) {
    if (env.CQ_AUDIT_REPO_ROOT && (!env.CQ_MEMORY_EXTRACT_MODEL || !base.messages)) {
      throw new Error("request-path audit requires local message memory extraction");
    }
    const client = makeClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_KEY as string);
    opts.auth = { resolve: resolveApiKeyVia(client), protectedPrefixes: ["/v1/"] };
    opts.config = createSupabaseConfigDeps(client);
    opts.memory = createSupabaseMemoryDeps(client);
    opts.billing = createSupabaseBillingDeps(client);
    opts.sessions = createSupabaseSessionsDeps(client);
    opts.webhooks = createSupabaseWebhookDeps(client);
    // Per-plan request rate limiting (reuse the billing deps' plan reader).
    const billing = opts.billing;
    // Fail-OPEN to the starter tier on a lookup error. This closure feeds @fastify/rate-limit's async
    // `max` (NOT wrapped by the plugin) AND the token-budget gate; an unguarded throw here from a transient
    // Supabase blip would propagate into the rate-limiter on EVERY request → the whole instance 500s
    // (a self-inflicted DoS). The starter tier is the safe, most-restrictive default. (Token-budget's own
    // tryConsume is already try/caught in messages.ts; this guards the rate-limit path symmetrically.)
    const getPlan = async (orgId: string): Promise<string> => {
      try {
        return (await billing.getOrgPlan(orgId)) ?? "starter";
      } catch (e) {
        logger.warn({ err: (e as Error).message, orgId }, "getOrgPlan failed — defaulting to starter tier");
        return "starter";
      }
    };
    opts.rateLimitByPlan = { getPlan };
    opts.health = { checkDatabase: createSupabaseHealthCheck(client) };
    // Stripe inbound webhook (records invoice.paid) — only when the endpoint secret is configured.
    if (typeof env.STRIPE_WEBHOOK_SECRET === "string" && env.STRIPE_WEBHOOK_SECRET !== "") {
      opts.stripeWebhook = createSupabaseStripeWebhookDeps(client, env.STRIPE_WEBHOOK_SECRET);
    }
    if (base.messages !== undefined) {
      base.messages.resolveConversation = createSupabaseConversationResolver(client);
      if (env.CQ_SHADOW_OBSERVE === "true" || env.CQ_SHADOW_OBSERVE === "1") {
        const encoder = createOnnxEncoder({ cacheDir: path.join(process.cwd(), "models"), localOnly: true });
        base.messages.observeConversation = createShadowObserver(
          encoder,
          (metric) => {
            logger.info(metric, "shadow conversation selection");
          },
          {
            factCoverage: createFactExchangeCoverageLookup(client),
            queryFactCandidates: createQueryFactCandidateLookup(client),
            supersession: {
              resolveEntities: createExchangeFunctionLookup(client),
              findFunctionSuperseded: createProjectFunctionSupersessionLookup(client),
              findFreshSuperseded: createFreshFunctionSupersessionLookup(client),
            },
          },
        );
      }
      // Reuse the already-wired exact token counter for /v1/tokens/count.
      opts.tokens = { countTokens: base.messages.countTokens };
      // Per-org token-budget gate on /v1/messages (commercial).
      base.messages.tokenBudget = createTokenBudget({ getPlan });
      // Persist each request's usage to Supabase (signed billing_record) so a partner sees their
      // activity + the invoice has a basis. Needs the dedicated billing-signing secret.
      if (typeof env.CQ_BILLING_SIGNING_SECRET === "string" && env.CQ_BILLING_SIGNING_SECRET !== "") {
        if (env.VERCEL && env.VERCEL !== "0") throw new Error("commercial billing requires persistent storage; Vercel serverless storage is ephemeral");
        const recorder = createSupabaseUsageRecorder({ client, signingSecret: env.CQ_BILLING_SIGNING_SECRET, queryTimeoutMs: 15_000 });
        base.messages.usageOutbox = createLocalUsageOutbox({
          dir: env.CQ_USAGE_OUTBOX_DIR ?? path.join(process.cwd(), "data", "usage-outbox"),
          recordUsage: recorder.recordUsage,
          onError: (error, eventId) => logger.error({ err: error.message, eventId }, "usage outbox replay failed"),
        });
      }
      if (env.CQ_MEMORY_EXTRACT_MODEL) {
        if (!env.CQ_MEMORY_EXTRACT_MODEL.startsWith("local/") || env.CQ_MEMORY_EXTRACT_MODEL.length <= 6) {
          throw new Error("CQ_MEMORY_EXTRACT_MODEL must use a local/<model> identifier");
        }
        const endpoint = localExtractionUrl(env.CQ_LOCAL_BASE_URL);
        const model = env.CQ_MEMORY_EXTRACT_MODEL;
        const extractor = createFactExtractor(createLocalFactCompletion(endpoint, model, env.CQ_LOCAL_API_KEY));
        const auditRepoRoot = env.CQ_AUDIT_REPO_ROOT ? resolveAuditRepoRoot(env.CQ_AUDIT_REPO_ROOT, env.DEVOPS_STRATUM_PROJECT_ROOT ?? "") : undefined;
        base.messages.recordMemory = createSupabaseMessageMemoryRecorder(client, extractor, auditRepoRoot);
      }
    }
  }
  return opts;
}

/**
 * Assemble the always-on `BuildProxyOptions` base — the message-route deps, the dashboard's session
 * reader, and the resolved listen address/port (so app.ts's Host check can hold a Host's port to the
 * listening port and accept a loopback `listenHost`, REQ-2's Definitions entry for a loopback name).
 * `start()` builds `base` ONLY through this function, so a proxy started by `start()` always has
 * `listenPort`/`listenHost` set; an inline object literal without them would leave the Host check
 * with no port to compare and no `listenHost` to accept.
 *
 * Pure and side-effect-free: it never calls createDefaultMessagesDeps() itself, and the `dashboard`
 * reader is a closure, not invoked here — `readSessionsFromDir(sessionsDir)` only runs when GET
 * /dashboard/api is actually requested. The caller supplies `messages`; `start()` passes
 * createDefaultMessagesDeps() (which throws "no LLM provider configured" at startup when no
 * provider is configured), and a test can pass a stub.
 *
 * @param args - the already-resolved port/host ({@link resolvePort}/{@link resolveListenHost}), the
 *   directory the dashboard reads session JSON files from, and the wired message-route deps.
 * @returns the base {@link BuildProxyOptions}: `messages`, `dashboard`, `listenPort`, `listenHost`.
 */
export function baseOptions({ port, host, sessionsDir, messages }: { port: number; host: string; sessionsDir: string; messages: MessagesDeps }): BuildProxyOptions {
  return {
    messages,
    dashboard: { readSessions: () => readSessionsFromDir(sessionsDir) },
    listenPort: port,
    listenHost: host,
  };
}

/**
 * Build, listen, and install graceful-shutdown handlers.
 *
 * @returns Resolves once the server is listening.
 */
export async function start(): Promise<void> {
  const sessionsDir = path.join(process.cwd(), "data", "sessions");
  const env: StartEnv = {
    CQ_COMMERCIAL: process.env["CQ_COMMERCIAL"],
    SUPABASE_URL: process.env["SUPABASE_URL"],
    SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"],
    STRIPE_WEBHOOK_SECRET: process.env["STRIPE_WEBHOOK_SECRET"],
    CQ_BILLING_SIGNING_SECRET: process.env["CQ_BILLING_SIGNING_SECRET"],
    CQ_USAGE_OUTBOX_DIR: process.env["CQ_USAGE_OUTBOX_DIR"],
    VERCEL: process.env["VERCEL"],
    CQ_MEMORY_EXTRACT_MODEL: process.env["CQ_MEMORY_EXTRACT_MODEL"],
    CQ_LOCAL_BASE_URL: process.env["CQ_LOCAL_BASE_URL"],
    CQ_LOCAL_API_KEY: process.env["CQ_LOCAL_API_KEY"],
    CQ_AUDIT_REPO_ROOT: process.env["CQ_AUDIT_REPO_ROOT"],
    DEVOPS_STRATUM_PROJECT_ROOT: process.env["DEVOPS_STRATUM_PROJECT_ROOT"],
    CQ_SHADOW_OBSERVE: process.env["CQ_SHADOW_OBSERVE"],
    DEVOPS_PROXY_HOST: process.env["DEVOPS_PROXY_HOST"],
    HOST: process.env["HOST"],
    DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED: process.env["DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED"],
    PORT: process.env["PORT"],
    RATE_LIMIT_MAX: process.env["RATE_LIMIT_MAX"],
    ANTHROPIC_BASE_URL: process.env["ANTHROPIC_BASE_URL"],
    OPENAI_BASE_URL: process.env["OPENAI_BASE_URL"],
    OPENROUTER_BASE_URL: process.env["OPENROUTER_BASE_URL"],
    GEMINI_BASE_URL: process.env["GEMINI_BASE_URL"],
    DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM: process.env["DEVOPS_PROXY_ALLOW_INSECURE_UPSTREAM"],
  };

  // REQ-4: resolve + validate PORT and RATE_LIMIT_MAX FIRST, alongside the REQ-3 bind check right
  // below — all before createDefaultMessagesDeps()/buildStartOptions(), which can construct
  // provider or Supabase clients, so an invalid numeric setting is refused before any network or
  // database connection is attempted. `port` is used below at app.listen(); RATE_LIMIT_MAX's
  // resolved number is not itself consumed here — this call exists only to make an invalid value
  // refuse HERE, as early as possible and in every mode, before any client construction.
  // buildProxy() (app.ts) also calls resolveRateLimitMax, but only on its per-IP fallback path
  // (`opts.rateLimit` omitted and no `opts.rateLimitByPlan`), so a caller that builds the app
  // directly and skips start() still fails closed on an invalid value when its options take that
  // path, such as a test built on app.inject() that passes no `rateLimit`. Calling it here too is
  // not redundant: buildProxy()'s own call happens only once buildProxy() is invoked, after
  // createDefaultMessagesDeps()/buildStartOptions() already ran, so this call is what makes the
  // real `npm run dev` boot refuse before those run.
  const port = resolvePort(env);
  resolveRateLimitMax(env);

  // REQ-3: resolve + validate the bind address — before createDefaultMessagesDeps()/
  // buildStartOptions() below, which can construct provider or Supabase clients — so an
  // unauthenticated remote bind is refused before any network or database connection is attempted.
  const host = resolveListenHost(env);
  if (usesDeprecatedHostAlias(env)) {
    logger.warn({ deprecated: "HOST", use: "DEVOPS_PROXY_HOST" }, "HOST is a deprecated alias for DEVOPS_PROXY_HOST and will be removed in a future release; set DEVOPS_PROXY_HOST instead");
  }
  // A bind that only the DEVOPS_PROXY_ALLOW_REMOTE_UNAUTHENTICATED=1 opt-in allows starts and logs the warning assertRemoteBindAllowed returns (AC-4's second bullet).
  const remoteBindWarning = assertRemoteBindAllowed(host, env);
  if (remoteBindWarning !== undefined) logger.warn({ host }, remoteBindWarning);

  // REQ-5: validate upstream provider base URLs — before createDefaultMessagesDeps()/
  // buildStartOptions() below, which can construct provider or Supabase clients — so a plain-http or
  // self-looping base URL is refused before any network or database connection is attempted. Reuses
  // the host/port already resolved above; does not re-resolve them.
  assertUpstreamAllowed(host, port, env);

  assertCommercialStartup(env);
  const base = baseOptions({ port, host, sessionsDir, messages: createDefaultMessagesDeps() });
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

  await app.listen({ port, host });
  logger.info({ port, host, mode: commercialEnabled(env) ? "commercial (multi-tenant auth + APIs)" : "personal (Phase 1 measurement)" }, "CQ Proxy running");
}

// Only auto-start when run as the entry (not when imported by a test for the pure helpers).
const entryPath = process.argv[1] ?? "";
if (/proxy[\\/]index\.(ts|js)$/.test(entryPath)) {
  start().catch((err) => {
    logger.error({ err: (err as Error).message }, "Failed to start CQ Proxy");
    process.exit(1);
  });
}
