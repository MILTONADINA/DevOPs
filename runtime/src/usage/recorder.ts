/** Unsigned usage inputs and replay identity (specs/ops/payment-removal.md#REQ-4). */
import type { SupabaseClient } from "@supabase/supabase-js";
import { markErasureCoverageUnknown } from "../memory/erasure-coverage";

export interface UsageInput {
  sessionId: string;
  orgId: string;
  /** Stable server-generated identity for replayable usage; absent on legacy rows. */
  usageEventId?: string;
  originalTokens: number;
  quarantinedTokens: number;
  apiPricePerToken: number;
  pruningLogId?: string;
}

export interface RecorderDeps {
  client: SupabaseClient;
  /** Per-event timeout shared with the usage session request. */
  signal?: AbortSignal;
}

/** Match PostgreSQL NUMERIC(12,8), rounding decimal ties away from zero.
 * Use the JSON number's decimal text: binary toFixed/Math.round can miss a tie.
 * The stored price may arrive through PostgREST as a number or decimal string.
 */
function priceUnits(value: unknown): bigint | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 10_000) return undefined;
  const [mantissa = "", exponent = "0"] = number.toString().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction);
  const shift = 8 + Number(exponent) - fraction.length;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  const units = shift < 0 ? (digits + divisor / 2n) / divisor : digits * 10n ** BigInt(shift);
  return units > 0n && units < 1_000_000_000_000n ? units : undefined;
}

/** Persist token counts and a pinned USD estimate; generated columns stay database-owned. */
export async function recordUsage(deps: RecorderDeps, input: UsageInput): Promise<{ id: string }> {
  // Retain the former calculator's input validation without computing a fee.
  for (const field of ["originalTokens", "quarantinedTokens", "apiPricePerToken"] as const) {
    if (!Number.isFinite(input[field]) || input[field] < 0) throw new Error(`${field} must be a non-negative finite number`);
  }
  const row = {
    session_id: input.sessionId,
    org_id: input.orgId,
    original_tokens: input.originalTokens,
    quarantined_tokens: input.quarantinedTokens,
    api_price_per_token: input.apiPricePerToken,
    ...(input.pruningLogId !== undefined ? { pruning_log_id: input.pruningLogId } : {}),
    ...(input.usageEventId !== undefined ? { usage_event_id: input.usageEventId } : {}),
  };
  let insert = deps.client.from("billing_records").insert(row).select("id").limit(1);
  if (deps.signal) insert = insert.abortSignal(deps.signal);
  const { data, error } = await insert;
  if (error) {
    if (error.code !== "23505" || input.usageEventId === undefined) throw new Error(`recordUsage failed: ${error.message}`);
    await markErasureCoverageUnknown(deps.client, input.orgId, "protected_read", deps.signal);
    let lookup = deps.client
      .from("billing_records")
      .select("id,org_id,session_id,original_tokens,quarantined_tokens,usage_event_id,api_price_per_token,pruning_log_id")
      .eq("org_id", input.orgId)
      .eq("usage_event_id", input.usageEventId)
      .limit(1);
    if (deps.signal) lookup = lookup.abortSignal(deps.signal);
    const existing = await lookup;
    if (existing.error) throw new Error(`recordUsage replay lookup failed: ${existing.error.message}`);
    const prior = (existing.data ?? [])[0] as Record<string, unknown> | undefined;
    const expectedPrice = priceUnits(input.apiPricePerToken);
    if (
      !prior ||
      typeof prior["id"] !== "string" ||
      prior["id"].trim() === "" ||
      prior["org_id"] !== input.orgId ||
      prior["session_id"] !== input.sessionId ||
      prior["original_tokens"] !== input.originalTokens ||
      prior["quarantined_tokens"] !== input.quarantinedTokens ||
      prior["usage_event_id"] !== input.usageEventId ||
      prior["pruning_log_id"] !== (input.pruningLogId ?? null) ||
      expectedPrice === undefined ||
      priceUnits(prior["api_price_per_token"]) !== expectedPrice
    ) {
      throw new Error("usage event replay mismatch");
    }
    return { id: prior["id"] };
  }
  const id = ((data ?? [])[0] as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || id.trim() === "") throw new Error("recordUsage returned no id");
  return { id };
}
