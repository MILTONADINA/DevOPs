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
