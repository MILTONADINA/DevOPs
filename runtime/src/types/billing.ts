/** Nonpayment pruning-log shape; payment types retired by specs/ops/payment-removal.md REQ-7. */
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
