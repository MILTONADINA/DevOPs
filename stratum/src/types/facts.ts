/**
 * Structured Fact Types
 *
 * All long-term memory is stored as typed structured facts,
 * never as natural language summaries.
 *
 * See docs/TECHNICAL_SPEC.md for the authoritative schema.
 */

export type FactType = "FunctionChange" | "TechDecision" | "PolicyUpdate" | "Todo" | "VariableChange";

/**
 * SINGLE SOURCE OF TRUTH for the fact field enums (PB-37). The Zod schemas
 * (schemas.ts), the extraction prompt (extractor.ts), and these TS types all derive
 * from these arrays, so the three layers cannot drift — preventing the enum-mismatch
 * silent-loss class the Session-17 review found. The DB CHECK constraints
 * (supabase/migrations) must be kept in sync manually (SQL has no import); a widen
 * there still requires editing the migration, but these app-layer values are coupled.
 */
export const CHANGE_TYPES = ["deprecated", "renamed", "signature_changed"] as const;
export const POLICY_TYPES = ["security", "compliance", "process"] as const;
export const TODO_STATUSES = ["open", "done", "cancelled"] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];
export type PolicyType = (typeof POLICY_TYPES)[number];
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface BaseFact {
  id: string;
  created_at: string;
  session_id: string;
  developer_id?: string;
  commit_hash?: string;
  confidence: number;
  is_verified: boolean;
  is_suppressed: boolean;
  fact_type: FactType;
}

export interface FunctionChangeFact extends BaseFact {
  fact_type: "FunctionChange";
  old_name: string;
  new_name?: string;
  change_type: ChangeType;
  file_path?: string;
  language?: string;
}

export interface TechDecisionFact extends BaseFact {
  fact_type: "TechDecision";
  decision_text: string;
  domain: string;
  rationale?: string;
  supersedes_id?: string;
}

export interface PolicyUpdateFact extends BaseFact {
  fact_type: "PolicyUpdate";
  policy_name: string;
  old_value?: string;
  new_value: string;
  policy_type: PolicyType;
  effective_date?: string;
}

export interface TodoFact extends BaseFact {
  fact_type: "Todo";
  description: string;
  status: TodoStatus;
  due_date?: string;
  assigned_to?: string;
}

export interface VariableChangeFact extends BaseFact {
  fact_type: "VariableChange";
  var_name: string;
  old_value?: string;
  new_value: string;
  context?: string;
}

export type AnyFact = FunctionChangeFact | TechDecisionFact | PolicyUpdateFact | TodoFact | VariableChangeFact;
