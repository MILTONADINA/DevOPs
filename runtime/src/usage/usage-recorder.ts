/** Team usage persistence: daily organization/model/project buckets and unsigned token rows.
 * Original and quarantined counts remain equal until pruning is active, so estimated savings are zero.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { validProjectScope } from "../proxy/auth";
import { recordUsage } from "./recorder";
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
  /** Price captured before the successful response; replay must not reprice it. */
  apiPricePerToken?: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRecorderOptions {
  client: SupabaseClient;
  /** Clock (ms) for the per-day session bucket. Injected for tests. Default Date.now. */
  now?: () => number;
  /** Per-input-token price resolver. Default {@link pricePerInputTokenUsd}. */
  priceFn?: (model: string) => number;
  /** Abort a stalled local database attempt so shutdown can leave the event queued. */
  queryTimeoutMs?: number;
}

export interface UsageRecorder {
  /** Persist one request's usage (a no-op when inputTokens ≤ 0 — the CHECK requires original_tokens > 0). */
  recordUsage: (event: UsageEvent) => Promise<void>;
}

/**
 * Build a usage recorder over Supabase: lazily ensure a session per (org, UTC-day, model, project), then append
 * an unsigned usage row for the measured usage.
 *
 * @param opts - the service-role client (+ injectable clock/price).
 * @returns a {@link UsageRecorder}.
 */
export function createSupabaseUsageRecorder(opts: UsageRecorderOptions): UsageRecorder {
  // Cache the in-flight PROMISE (not the resolved id): recordUsage is fire-and-forget, so overlapping
  // requests for the same (org, day, model, project) can enter ensureSession concurrently. Caching the resolved
  // id only AFTER the insert lets both observe a miss and create DUPLICATE session rows (a TOCTOU race).
  const sessionCache = new Map<string, Promise<string>>(); // `${org}|${day}|${model}|${project}` → session id promise
  const now = opts.now ?? ((): number => Date.now());
  const price = opts.priceFn ?? ((m: string): number => pricePerInputTokenUsd(m));

  function ensureSession(orgId: string, model: string, projectScope: string | null, occurredAt?: string, signal?: AbortSignal): Promise<string> {
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
      // each miss their own cache and would insert DUPLICATE daily buckets, fragmenting a day's usage
      // across many session ids. Try the insert; on a unique-violation (23505) another instance won the
      // race, so re-read its bucket — all instances then converge on the one row.
      let insert = opts.client
        .from("sessions")
        .insert({ org_id: orgId, project_scope: projectScope, model, kind: "usage", ...(occurredAt !== undefined ? { created_at: occurredAt } : {}) })
        .select("id")
        .limit(1);
      if (signal) insert = insert.abortSignal(signal);
      const ins = await insert;
      if (!ins.error) {
        const id = ((ins.data ?? [])[0] as { id: string } | undefined)?.id;
        if (typeof id !== "string" || id.trim() === "") throw new Error("ensureSession returned no id");
        return id;
      }
      if ((ins.error as { code?: string }).code !== "23505") throw new Error(`ensureSession failed: ${ins.error.message}`);
      // Lost the cross-instance race — read the existing usage bucket for (org, model, project, today).
      const startOfDay = `${day}T00:00:00.000Z`;
      const nextDay = new Date(Date.parse(startOfDay) + 86_400_000).toISOString().slice(0, 10) + "T00:00:00.000Z";
      let query = opts.client.from("sessions").select("id").eq("org_id", orgId).eq("model", model).eq("kind", "usage").gte("created_at", startOfDay).lt("created_at", nextDay);
      query = projectScope === null ? query.is("project_scope", null) : query.eq("project_scope", projectScope);
      let lookup = query.limit(1);
      if (signal) lookup = lookup.abortSignal(signal);
      const sel = await lookup;
      if (sel.error) throw new Error(`ensureSession conflict re-read failed: ${sel.error.message}`);
      const id = ((sel.data ?? [])[0] as { id: string } | undefined)?.id;
      if (typeof id !== "string" || id.trim() === "") throw new Error("ensureSession: unique conflict but no existing bucket found");
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
      if (event.apiPricePerToken !== undefined && (!Number.isFinite(event.apiPricePerToken) || event.apiPricePerToken <= 0)) throw new Error("invalid pinned usage price");
      const signal = opts.queryTimeoutMs === undefined ? undefined : AbortSignal.timeout(opts.queryTimeoutMs);
      const sessionId = await ensureSession(event.orgId, event.model, projectScope, event.occurredAt, signal);
      await recordUsage(
        { client: opts.client, ...(signal ? { signal } : {}) },
        {
          orgId: event.orgId,
          ...(event.eventId !== undefined ? { usageEventId: event.eventId } : {}),
          sessionId,
          originalTokens: event.inputTokens,
          quarantinedTokens: event.inputTokens, // no pruning yet ⇒ 0 savings (honest usage record)
          apiPricePerToken: event.apiPricePerToken ?? price(event.model),
        },
      );
    },
  };
}
