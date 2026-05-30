/**
 * Billing Record Writer — Append-Only with HMAC Signing (Phase 6 / v0.9.x).
 *
 * Billing records are append-only (the Postgres no_update_billing / no_delete_billing rules
 * enforce it). Every record is signed with HMAC-SHA256 over its IMMUTABLE INPUT fields, so a
 * customer can independently verify each number and we provably cannot retroactively alter it —
 * the dispute-proof audit trail (BUSINESS_MODEL.md). The generated columns
 * (token_delta/cost_delta_usd/cq_fee_usd) are derived BY the DB from the signed inputs, so signing
 * the inputs covers the whole record.
 *
 * CRITICAL (financial): the signing secret must be a DEDICATED key (CQ_BILLING_SIGNING_SECRET),
 * never reused from encryption. Verification is constant-time. Per the file's standing note, any
 * change here warrants a second reviewer; the writer is fully unit-tested with an injected client
 * (NO live writes in tests — billing_records is append-only and cannot be cleaned up).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateFee } from "./calculator";

/** The immutable inputs of a billing event (everything the fee + generated columns derive from). */
export interface BillingInput {
  sessionId: string;
  orgId: string;
  originalTokens: number;
  quarantinedTokens: number;
  apiPricePerToken: number;
  pruningLogId?: string;
}

/** Canonical signing payload — field-order-fixed, delimiter-joined; the price is included so a
 *  re-priced row fails verification. (Generated columns are omitted: they're DB-derived from these.) */
function canonical(input: BillingInput): string {
  return [input.orgId, input.sessionId, input.originalTokens, input.quarantinedTokens, input.apiPricePerToken, input.pruningLogId ?? ""].join("");
}

/**
 * HMAC-SHA256 of a billing record's inputs (hex). The only signature ever stored/compared.
 *
 * @param input - the billing inputs.
 * @param secret - the dedicated billing-signing secret (non-empty).
 * @returns the hex signature.
 * @throws {Error} if the secret is empty.
 */
export function signBillingRecord(input: BillingInput, secret: string): string {
  if (secret === "") throw new Error("billing signing secret must not be empty");
  return createHmac("sha256", secret).update(canonical(input), "utf8").digest("hex");
}

/**
 * Constant-time verification that `signedHash` matches the record's inputs (tamper detection).
 *
 * @param input - the inputs read back from the stored row.
 * @param signedHash - the row's stored signed_hash.
 * @param secret - the billing-signing secret.
 * @returns true iff the signature is valid.
 */
export function verifyBillingRecord(input: BillingInput, signedHash: string, secret: string): boolean {
  const expected = signBillingRecord(input, secret);
  if (!/^[0-9a-f]+$/i.test(signedHash) || signedHash.length !== expected.length) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RecorderDeps {
  client: SupabaseClient;
  /** The dedicated billing-signing secret. */
  secret: string;
}

/**
 * Compute the fee, sign the inputs, and append the signed record to billing_records.
 *
 * The generated columns are NOT sent (the DB computes them). The insert can only ever ADD a row
 * (append-only). org/session are trusted FKs.
 *
 * @param deps - a service-role client + the signing secret.
 * @param input - the billing inputs.
 * @returns the new record id + the computed CQ fee.
 * @throws {Error} if the insert fails.
 */
export async function recordBilling(deps: RecorderDeps, input: BillingInput): Promise<{ id: string; cqFeeUsd: number }> {
  const fee = calculateFee(input.originalTokens, input.quarantinedTokens, input.apiPricePerToken);
  const signed = signBillingRecord(input, deps.secret);
  const row = {
    session_id: input.sessionId,
    org_id: input.orgId,
    original_tokens: input.originalTokens,
    quarantined_tokens: input.quarantinedTokens,
    api_price_per_token: input.apiPricePerToken,
    ...(input.pruningLogId !== undefined ? { pruning_log_id: input.pruningLogId } : {}),
    signed_hash: signed,
  };
  const { data, error } = await deps.client.from("billing_records").insert(row).select("id").limit(1);
  if (error) throw new Error(`recordBilling failed: ${error.message}`);
  const id = ((data ?? [])[0] as { id: string } | undefined)?.id ?? "";
  return { id, cqFeeUsd: fee.cqFeeUsd };
}
