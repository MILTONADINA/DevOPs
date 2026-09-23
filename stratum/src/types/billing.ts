/**
 * Billing Types
 *
 * See docs/TECHNICAL_SPEC.md for the authoritative schema.
 */

export interface BillingRecord {
  id: string;
  created_at: number;
  session_id: string;
  org_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  token_delta: number;
  api_price_per_token: number;
  cost_delta_usd: number;
  cq_fee_usd: number;
  pruning_log_id: string;
  signed_hash: string;
}

/** Monthly minimum (USD) by plan — the floor below which a customer still pays the minimum
 * (BUSINESS_MODEL.md §Pricing Tiers). Above it, they pay the arbitrage % of savings. */
export const MONTHLY_MINIMUM_USD: Record<string, number> = {
  starter: 0,
  growth: 99,
  enterprise: 499,
  custom: 0, // negotiated — treated as no floor here unless set per-org
};

/** One session's contribution to an invoice. */
export interface InvoiceLineItem {
  sessionId: string;
  originalTokens: number;
  quarantinedTokens: number;
  savingsUsd: number;
  feeUsd: number;
}

/** A computed invoice for one org over a billing period (the CFO-dashboard artifact). */
export interface Invoice {
  orgId: string;
  plan: string;
  periodStart: string;
  periodEnd: string;
  recordCount: number;
  totalOriginalTokens: number;
  totalQuarantinedTokens: number;
  /** Σ cost_delta = the customer's gross savings. */
  totalSavingsUsd: number;
  /** Σ cq_fee = the arbitrage fee (floored at 0). */
  rawFeeUsd: number;
  /** The plan's monthly minimum. */
  monthlyMinimumUsd: number;
  /** What the customer actually owes: max(minimum, rawFee). */
  amountDueUsd: number;
  /** Pruning effectiveness: (original − quarantined) / original, as a %. */
  effectivenessPct: number;
  lineItems: InvoiceLineItem[];
}

export interface PruningLog {
  id: string;
  session_id: string;
  created_at: number;
  turns_total: number;
  turns_selected: number[];
  turns_pruned: number[];
  relevance_scores: number[];
  spans_selected: Array<[number, number]>;
  lambda_used: number;
  gain_shift_used: number;
  theta_used: number;
}
