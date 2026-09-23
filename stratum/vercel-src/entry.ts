/**
 * Vercel serverless entry for the CQ / Stratum proxy (bundled by esbuild into api/index.js).
 *
 * Vercel runs a Node FUNCTION (no long-running `listen()`), so this builds the SAME app that
 * src/proxy/index.ts builds — via buildStartOptions: in commercial mode (CQ_COMMERCIAL=true + Supabase
 * creds) the multi-tenant auth gate (protecting /v1/*) + the config/memory/billing/sessions/webhooks
 * APIs over Supabase — and feeds each request into Fastify with `app.server.emit("request", …)`.
 *
 * The request stream is NOT consumed here, so Fastify's own content-type parsers (including the Stripe
 * webhook's RAW-body parser, whose HMAC is over the exact bytes) see the original request body.
 *
 * Required env: ANTHROPIC_API_KEY (to boot). Commercial: CQ_COMMERCIAL=true + SUPABASE_URL +
 * SUPABASE_SERVICE_KEY; CQ_BILLING_SIGNING_SECRET for usage persistence; STRIPE_WEBHOOK_SECRET for the
 * inbound paid webhook; CQ_CAPTURE_DIR=/tmp (serverless filesystems are read-only except /tmp).
 *
 * CAVEAT: the STREAMING /v1/messages path is bounded by Vercel's function time limit (≈300s) — fine for
 * typical turns, but a very long agentic stream can be cut off. The NON-streaming billing / invoice /
 * Stripe-webhook path (what the v1.0.0 "invoice sent + paid" acceptance needs) is unaffected.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { buildProxy, type BuildProxyOptions } from "../src/proxy/app";
import { buildStartOptions, type StartEnv } from "../src/proxy/index";
import { createDefaultMessagesDeps } from "../src/proxy/default-deps";
import { readSessionsFromDir } from "../src/proxy/routes/dashboard";

const env: StartEnv = {
  CQ_COMMERCIAL: process.env["CQ_COMMERCIAL"],
  SUPABASE_URL: process.env["SUPABASE_URL"],
  SUPABASE_SERVICE_KEY: process.env["SUPABASE_SERVICE_KEY"],
  STRIPE_WEBHOOK_SECRET: process.env["STRIPE_WEBHOOK_SECRET"],
  CQ_BILLING_SIGNING_SECRET: process.env["CQ_BILLING_SIGNING_SECRET"],
};

// The capture store + dashboard read this dir; on a serverless host only /tmp is writable.
const captureDir = process.env["CQ_CAPTURE_DIR"] ?? "/tmp";

const base: BuildProxyOptions = {
  messages: createDefaultMessagesDeps(),
  dashboard: { readSessions: () => readSessionsFromDir(captureDir) },
};

const app = buildProxy(buildStartOptions(env, base, createClient));

// Build once per warm instance (Fluid Compute reuses instances); later requests reuse the ready app.
let ready: Promise<unknown> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (ready === null) ready = app.ready();
  await ready;
  app.server.emit("request", req, res);
}
