/**
 * Monthly Invoice Generator (Phase 6 / v1.0.0).
 *
 * Turns an org's append-only billing_records into the CFO-dashboard artifact
 * (BUSINESS_MODEL.md §The CFO Dashboard): the savings totals, the 20%-of-savings fee with
 * the plan's monthly-minimum floor, itemized per-session line items, and a signed-hash
 * audit-trail CSV. PURE (no I/O) — the runnable (scripts/invoice.ts) reads the records and
 * the Stripe send is a separate, gated seam. Built ahead of the v1.0.0 gate: the engine is
 * ready; an actual paid invoice needs Stripe + a design partner.
 */

import type { Invoice, InvoiceLineItem } from "../types/billing";
import { MONTHLY_MINIMUM_USD } from "../types/billing";

/** The billing_records fields the invoice needs (a DB row or a fixture). */
export interface BillableRecord {
  session_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  cost_delta_usd: number;
  cq_fee_usd: number;
  signed_hash?: string;
}

/** Round to cents. The epsilon nudge counters IEEE-754 representation error at the half-cent
 * boundary (e.g. 1.275 stored as 1.2749999… would otherwise round DOWN to 1.27). NOTE: this is
 * display/summary rounding; production *charging* must accumulate integer cents (or a decimal
 * type), not floats — a follow-up when the request path actually bills (records are empty today). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Generate an invoice for one org over a period from its billing records.
 *
 * The fee is the recorded `cq_fee` sum (the rate was applied at record time), floored at 0;
 * the amount due is max(that, the plan's monthly minimum). Effectiveness is token-based.
 *
 * @param orgId - the org.
 * @param plan - the org's plan (drives the monthly minimum).
 * @param records - the org's billing records for the period.
 * @param periodStart - ISO start (label).
 * @param periodEnd - ISO end (label).
 * @returns the computed {@link Invoice}.
 */
export function generateInvoice(orgId: string, plan: string, records: BillableRecord[], periodStart: string, periodEnd: string): Invoice {
  // Line items carry the RAW per-session values (not round2). Rounding each line independently and then
  // ALSO rounding the total makes Σ(rounded lines) ≠ round2(total) (rounding is not linear), so a customer
  // summing the itemized fees would get a figure that disputes their charged total. Keeping lines raw means
  // Σ(lineItems.feeUsd) === the pre-round fee accumulation, and amountDueUsd === round2 of that — they
  // reconcile. Display layers (the CFO dashboard, renderInvoice) format to 2dp at RENDER time.
  const lineItems: InvoiceLineItem[] = records.map((r) => ({
    sessionId: r.session_id,
    originalTokens: r.original_tokens,
    quarantinedTokens: r.quarantined_tokens,
    savingsUsd: r.cost_delta_usd,
    feeUsd: r.cq_fee_usd,
  }));

  const totalOriginalTokens = records.reduce((s, r) => s + r.original_tokens, 0);
  const totalQuarantinedTokens = records.reduce((s, r) => s + r.quarantined_tokens, 0);
  const totalSavingsUsd = records.reduce((s, r) => s + r.cost_delta_usd, 0);
  const rawFeeUsd = Math.max(
    0,
    records.reduce((s, r) => s + r.cq_fee_usd, 0),
  );
  const monthlyMinimumUsd = MONTHLY_MINIMUM_USD[plan] ?? 0;
  const amountDueUsd = Math.max(monthlyMinimumUsd, rawFeeUsd);
  const effectivenessPct = totalOriginalTokens > 0 ? ((totalOriginalTokens - totalQuarantinedTokens) / totalOriginalTokens) * 100 : 0;

  return {
    orgId,
    plan,
    periodStart,
    periodEnd,
    recordCount: records.length,
    totalOriginalTokens,
    totalQuarantinedTokens,
    totalSavingsUsd: round2(totalSavingsUsd),
    rawFeeUsd: round2(rawFeeUsd),
    monthlyMinimumUsd,
    amountDueUsd: round2(amountDueUsd),
    effectivenessPct: round2(effectivenessPct),
    lineItems,
  };
}

/** Escape a CSV field (quote + double inner quotes) if it contains a comma/quote/newline. */
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The downloadable audit trail: every billing record with its signed hash, so a customer can
 * independently verify each number (BUSINESS_MODEL.md — the dispute-proof artifact).
 *
 * When `invoice` is supplied, a trailing `__SUMMARY__` row is appended carrying the totals AND the
 * plan / monthly-minimum / amount-due. This is REQUIRED for the artifact to be dispute-proof: when the
 * plan minimum floors the charge (rawFee < minimum), Σ(cq_fee_usd) is LESS than the invoiced amount, and
 * without the floor recorded in the CSV a customer summing the fee column would (correctly) compute a
 * smaller number than their invoice — grounds to dispute every floored invoice. The summary row bridges
 * Σ(cq_fee_usd) → rawFee → max(minimum, rawFee) = amount_due, all inside the one artifact.
 *
 * @param records - the billing records.
 * @param invoice - the computed invoice (optional); when present, appends the reconciliation summary row.
 * @returns CSV text (header + one row per record [+ a __SUMMARY__ row]).
 */
export function toAuditCsv(records: BillableRecord[], invoice?: Invoice): string {
  const header = ["session_id", "original_tokens", "quarantined_tokens", "cost_delta_usd", "cq_fee_usd", "signed_hash"];
  const rows = records.map((r) => [r.session_id, r.original_tokens, r.quarantined_tokens, r.cost_delta_usd, r.cq_fee_usd, r.signed_hash ?? ""].map(csvField).join(","));
  if (invoice !== undefined) {
    // Reuse the 6 columns: the 6th carries the floor reconciliation as key=value pairs (so the row is
    // both human-readable and machine-parseable by filtering the `__SUMMARY__` sentinel in column 1).
    const recon = `plan=${invoice.plan};monthly_minimum_usd=${invoice.monthlyMinimumUsd};raw_fee_usd=${invoice.rawFeeUsd};amount_due_usd=${invoice.amountDueUsd}`;
    rows.push([`__SUMMARY__`, invoice.totalOriginalTokens, invoice.totalQuarantinedTokens, invoice.totalSavingsUsd, invoice.rawFeeUsd, recon].map(csvField).join(","));
  }
  return [header.join(","), ...rows].join("\n");
}

/** Render an invoice as a human-readable CFO report (pure). */
export function renderInvoice(inv: Invoice): string {
  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const lines = [
    `Invoice — org ${inv.orgId} (${inv.plan})`,
    `Period: ${inv.periodStart} → ${inv.periodEnd}`,
    "=".repeat(56),
    `  Sessions billed:        ${inv.recordCount}`,
    `  Original tokens:        ${inv.totalOriginalTokens.toLocaleString()}`,
    `  Quarantined tokens:     ${inv.totalQuarantinedTokens.toLocaleString()}`,
    `  Pruning effectiveness:  ${inv.effectivenessPct.toFixed(1)}%`,
    `  Customer savings:       ${usd(inv.totalSavingsUsd)}`,
    "-".repeat(56),
    `  CQ fee (20% of savings):${usd(inv.rawFeeUsd)}`,
    `  Monthly minimum (${inv.plan}):  ${usd(inv.monthlyMinimumUsd)}`,
    `  AMOUNT DUE:             ${usd(inv.amountDueUsd)}`,
  ];
  return lines.join("\n");
}
