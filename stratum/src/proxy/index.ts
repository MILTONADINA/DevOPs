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

import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";
import { buildProxy, type BuildProxyOptions } from "./app";
import { createDefaultMessagesDeps } from "./default-deps";
import { readSessionsFromDir } from "./routes/dashboard";
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
import { createRoutedForward } from "./providers/router";
import { createSupabaseMessageMemoryRecorder } from "./message-memory";
import { createSupabaseConversationResolver } from "./conversation";
import { createShadowObserver } from "./shadow-observer";
import { createOnnxEncoder } from "../pruner/encoder";
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
 * Resolve the bind host. Defaults to 127.0.0.1 (loopback) so local/personal use is private by
 * default; a CONTAINER or PaaS sets HOST=0.0.0.0 to be reachable from outside (binding 127.0.0.1
 * inside a container makes the server unreachable — the proxy could not be deployed without this).
 *
 * @param env - the process env (reads HOST).
 * @returns the host to bind.
 */
export function resolveListenHost(env: { HOST?: string | undefined }): string {
  const h = env.HOST;
  return typeof h === "string" && h.trim() !== "" ? h.trim() : "127.0.0.1";
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
        const forward = createRoutedForward({ CQ_LOCAL_BASE_URL: endpoint, CQ_LOCAL_API_KEY: env.CQ_LOCAL_API_KEY });
        const extractor = createFactExtractor({
          async complete(prompt) {
            const response = await forward({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1024 }, "");
            if (response.status >= 400) throw new Error(`local extraction model returned HTTP ${response.status}`);
            const blocks = (response.data as { content?: { type?: string; text?: string }[] } | null)?.content;
            const answer = blocks
              ?.filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n");
            if (!answer) throw new Error("local extraction model returned no text");
            return answer;
          },
        });
        const auditRepoRoot = env.CQ_AUDIT_REPO_ROOT ? resolveAuditRepoRoot(env.CQ_AUDIT_REPO_ROOT, env.DEVOPS_STRATUM_PROJECT_ROOT ?? "") : undefined;
        base.messages.recordMemory = createSupabaseMessageMemoryRecorder(client, extractor, auditRepoRoot);
      }
    }
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
  };
  assertCommercialStartup(env);
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

  const host = resolveListenHost(process.env);
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
