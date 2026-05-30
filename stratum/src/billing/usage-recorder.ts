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
 * model); a client may later carry an explicit session id (a refinement, not needed for the pilot).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordBilling } from "./recorder";
import { pricePerInputTokenUsd } from "./pricing";

/** One measured request's usage (output tokens are telemetry; pruning saves INPUT context). */
export interface UsageEvent {
  orgId: string;
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
 * Build a usage recorder over Supabase: lazily ensure a session per (org, UTC-day, model), then append
 * an HMAC-signed billing_record for the measured usage.
 *
 * @param opts - the service-role client + signing secret (+ injectable clock/price).
 * @returns a {@link UsageRecorder}.
 */
export function createSupabaseUsageRecorder(opts: UsageRecorderOptions): UsageRecorder {
  const sessionCache = new Map<string, string>(); // `${org}|${day}|${model}` → session id
  const now = opts.now ?? ((): number => Date.now());
  const price = opts.priceFn ?? ((m: string): number => pricePerInputTokenUsd(m));

  async function ensureSession(orgId: string, model: string): Promise<string> {
    const day = new Date(now()).toISOString().slice(0, 10); // UTC date bucket
    const key = `${orgId}|${day}|${model}`;
    const cached = sessionCache.get(key);
    if (cached !== undefined) return cached;
    const { data, error } = await opts.client.from("sessions").insert({ org_id: orgId, model }).select("id").limit(1);
    if (error) throw new Error(`ensureSession failed: ${error.message}`);
    const id = ((data ?? [])[0] as { id: string } | undefined)?.id;
    if (id === undefined || id === "") throw new Error("ensureSession returned no id");
    sessionCache.set(key, id);
    return id;
  }

  return {
    async recordUsage(event: UsageEvent): Promise<void> {
      if (!Number.isFinite(event.inputTokens) || event.inputTokens <= 0) return; // original_tokens > 0
      const sessionId = await ensureSession(event.orgId, event.model);
      await recordBilling(
        { client: opts.client, secret: opts.signingSecret },
        {
          orgId: event.orgId,
          sessionId,
          originalTokens: event.inputTokens,
          quarantinedTokens: event.inputTokens, // no pruning yet ⇒ 0 savings (honest usage record)
          apiPricePerToken: price(event.model),
        },
      );
    },
  };
}
