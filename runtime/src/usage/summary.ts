/**
 * Usage summary totals — pure (no I/O), and importing nothing under src/billing/ (specs/ops/payment-removal.md REQ-3).
 *
 * Folds an organization's usage records for a period into the totals the usage summary reports: token totals, pruning
 * effectiveness, the number of distinct sessions and the estimated USD cost difference. The USD figure is an estimate,
 * for information only (REQ-6).
 */

/** The fields of a usage record that the summary needs (a database row or a fixture). */
export interface UsageRecord {
  session_id: string;
  original_tokens: number;
  quarantined_tokens: number;
  cost_delta_usd: number;
}

/** The totals for a set of usage records. */
export interface UsageSummary {
  total_original_tokens: number;
  total_quarantined_tokens: number;
  total_token_delta: number;
  /** Estimated USD cost difference, rounded to cents. */
  total_cost_delta_usd: number;
  total_sessions: number;
  /** The share of original tokens that pruning removed, in percent, rounded to two decimals; 0 when there are no original tokens. */
  average_pruning_effectiveness_pct: number;
}

/** Round to cents. The epsilon nudge counters IEEE-754 representation error at the half-cent boundary (1.275 is stored as 1.2749999… and would otherwise round DOWN to 1.27). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Summarize usage records.
 *
 * The token totals are plain sums and are never rounded. The cost difference and the effectiveness are rounded to two decimals,
 * and the effectiveness is 0 when there are no original tokens (no division by zero).
 *
 * @param records - the organization's usage records for the period.
 * @returns the {@link UsageSummary} totals.
 */
export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const totalOriginalTokens = records.reduce((s, r) => s + r.original_tokens, 0);
  const totalQuarantinedTokens = records.reduce((s, r) => s + r.quarantined_tokens, 0);
  const totalCostDeltaUsd = records.reduce((s, r) => s + r.cost_delta_usd, 0);
  const effectivenessPct = totalOriginalTokens > 0 ? ((totalOriginalTokens - totalQuarantinedTokens) / totalOriginalTokens) * 100 : 0;
  return {
    total_original_tokens: totalOriginalTokens,
    total_quarantined_tokens: totalQuarantinedTokens,
    total_token_delta: totalOriginalTokens - totalQuarantinedTokens,
    total_cost_delta_usd: round2(totalCostDeltaUsd),
    total_sessions: new Set(records.map((r) => r.session_id)).size,
    average_pruning_effectiveness_pct: round2(effectivenessPct),
  };
}
