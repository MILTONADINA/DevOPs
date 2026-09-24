/**
 * Commercial usage persistence (Phase 6 / v1.0.0) — the request path → Supabase billing tables.
 *
 * The Phase-1 measurement proxy captures each turn to a local JSON artifact (the personal-use
 * dashboard). Commercial mode additionally needs each request's measured usage to land in the
 * Supabase `sessions` + `billing_records` tables, so a design partner SEES their activity in the CFO
 * dashboard and the invoice has a usage basis (without this, a partner's dashboard is empty and the
 * invoice is only the plan minimum).
 *
 * HONESTY: pruning is NOT in the request path yet (ADR-0009/0014 — gated on a passing Tier-A eval),
 * so there are NO savings yet. Each record is written with quarantined = original ⇒ token_delta 0 ⇒
 * fee $0 — it records the partner's USAGE truthfully (their token consumption), and real savings begin
 * when pruning activates. The record is HMAC-signed (recordBilling) like every billing row.
 *
 * billing_records is append-only (no_update/no_delete), so this is UNIT-tested with an injected client
 * (the recorder discipline — NO live billing writes in tests). Sessions are grouped per (org, UTC-day,
 * model, authenticated project); a client may later carry an explicit session id.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../proxy/auth";
import { recordBilling } from "./recorder";
import { pricePerInputTokenUsd } from "./pricing";

/** One measured request's usage (output tokens are telemetry; pruning saves INPUT context). */
export interface UsageEvent {
  orgId: string;
  /** Authenticated organization/project binding; never client-supplied. */
  projectScopeId?: string;
  /** Stable server-generated UUID; reuse this ID for retries of the same response. */
  eventId?: string;
  /** Server-recorded UTC time; keeps replay in the original daily bucket. */
  occurredAt?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRecorderOptions {
  client: SupabaseClient;
  /** The dedicated billing-signing secret (CQ_BILLING_SIGNING_SECRET). */
  signingSecret: string;
  /** Clock (ms) for the per-day session bucket. Injected for tests. Default Date.now. */
  now?: () => number;
  /** Per-input-token price resolver. Default {@link pricePerInputTokenUsd}. */
  priceFn?: (model: string) => number;
}

export interface UsageRecorder {
  /** Persist one request's usage (a no-op when inputTokens ≤ 0 — the CHECK requires original_tokens > 0). */
  recordUsage: (event: UsageEvent) => Promise<void>;
}

/**
 * Build a usage recorder over Supabase: lazily ensure a session per (org, UTC-day, model, project), then append
 * an HMAC-signed billing_record for the measured usage.
 *
 * @param opts - the service-role client + signing secret (+ injectable clock/price).
 * @returns a {@link UsageRecorder}.
 */
export function createSupabaseUsageRecorder(opts: UsageRecorderOptions): UsageRecorder {
  // Cache the in-flight PROMISE (not the resolved id): recordUsage is fire-and-forget, so overlapping
  // requests for the same (org, day, model, project) can enter ensureSession concurrently. Caching the resolved
  // id only AFTER the insert lets both observe a miss and create DUPLICATE session rows (a TOCTOU race).
  const sessionCache = new Map<string, Promise<string>>(); // `${org}|${day}|${model}|${project}` → session id promise
  const now = opts.now ?? ((): number => Date.now());
  const price = opts.priceFn ?? ((m: string): number => pricePerInputTokenUsd(m));

  function ensureSession(orgId: string, model: string, projectScope: string | null, occurredAt?: string): Promise<string> {
    const day = new Date(occurredAt ?? now()).toISOString().slice(0, 10); // UTC date bucket
    // Evict prior-day entries: the key embeds the UTC day, so any entry whose middle segment != today is
    // stale (its bucket is permanently resolved in the DB) and unreachable. Without this the Map grows one
    // entry per (org, model) per day forever on a long-lived (non-serverless) instance — an unbounded leak.
    // O(stale) only, and only on the first call after a UTC-midnight rollover.
    for (const k of sessionCache.keys()) {
      if (k.split("|")[1] !== day) sessionCache.delete(k);
    }
    const key = `${orgId}|${day}|${model}|${projectScope ?? ""}`;
    const cached = sessionCache.get(key);
    if (cached !== undefined) return cached;
    // Insert under one shared promise, stored SYNCHRONOUSLY (before the first await) so a concurrent
    // caller for the same key awaits this insert instead of issuing a second one.
    const created = (async (): Promise<string> => {
      // kind='usage' (PB-46): this is a daily USAGE bucket, never "ended", so it must NOT count toward
      // the concurrent-session cap (which counts active EXPLICIT sessions). See sessions.kind migration.
      // SELECT-or-INSERT against the partial unique index sessions_usage_bucket_uniq (kind='usage', per
      // org+model+project+UTC-day): the in-memory cache dedups within ONE instance, but separate Vercel instances
      // each miss their own cache and would insert DUPLICATE daily buckets, fragmenting a day's billing
      // across many session ids. Try the insert; on a unique-violation (23505) another instance won the
      // race, so re-read its bucket — all instances then converge on the one row.
      const ins = await opts.client.from("sessions").insert({ org_id: orgId, project_scope: projectScope, model, kind: "usage", ...(occurredAt !== undefined ? { created_at: occurredAt } : {}) }).select("id").limit(1);
      if (!ins.error) {
        const id = ((ins.data ?? [])[0] as { id: string } | undefined)?.id;
        if (id === undefined || id === "") throw new Error("ensureSession returned no id");
        return id;
      }
      if ((ins.error as { code?: string }).code !== "23505") throw new Error(`ensureSession failed: ${ins.error.message}`);
      // Lost the cross-instance race — read the existing usage bucket for (org, model, project, today).
      const startOfDay = `${day}T00:00:00.000Z`;
      const nextDay = new Date(Date.parse(startOfDay) + 86_400_000).toISOString().slice(0, 10) + "T00:00:00.000Z";
      let query = opts.client.from("sessions").select("id").eq("org_id", orgId).eq("model", model).eq("kind", "usage").gte("created_at", startOfDay).lt("created_at", nextDay);
      query = projectScope === null ? query.is("project_scope", null) : query.eq("project_scope", projectScope);
      const sel = await query.limit(1);
      if (sel.error) throw new Error(`ensureSession conflict re-read failed: ${sel.error.message}`);
      const id = ((sel.data ?? [])[0] as { id: string } | undefined)?.id;
      if (id === undefined || id === "") throw new Error("ensureSession: unique conflict but no existing bucket found");
      return id;
    })();
    sessionCache.set(key, created);
    created.catch(() => sessionCache.delete(key)); // never cache a rejected promise — allow a retry
    return created;
  }

  return {
    async recordUsage(event: UsageEvent): Promise<void> {
      if (!Number.isFinite(event.inputTokens) || event.inputTokens <= 0) return; // original_tokens > 0
      const projectScope = event.projectScopeId === undefined ? null : event.projectScopeId.slice(event.orgId.length + 1);
      if (event.projectScopeId !== undefined && (!event.projectScopeId.startsWith(`${event.orgId}/`) || !validProjectScope(projectScope))) {
        throw new Error("invalid authenticated project scope");
      }
      if (event.occurredAt !== undefined && new Date(event.occurredAt).toISOString() !== event.occurredAt) throw new Error("invalid usage occurrence time");
      const sessionId = await ensureSession(event.orgId, event.model, projectScope, event.occurredAt);
      await recordBilling(
        { client: opts.client, secret: opts.signingSecret },
        {
          orgId: event.orgId,
          ...(event.eventId !== undefined ? { usageEventId: event.eventId } : {}),
          sessionId,
          originalTokens: event.inputTokens,
          quarantinedTokens: event.inputTokens, // no pruning yet ⇒ 0 savings (honest usage record)
          apiPricePerToken: price(event.model),
        },
      );
    },
  };
}
