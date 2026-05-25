/**
 * Structured Fact Types
 *
 * All long-term memory is stored as typed structured facts,
 * never as natural language summaries.
 *
 * See docs/TECHNICAL_SPEC.md for the authoritative schema.
 */

export type FactType =
  | "FunctionChange"
  | "TechDecision"
  | "PolicyUpdate"
  | "Todo"
  | "VariableChange";

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
  change_type: "deprecated" | "renamed" | "signature_changed";
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
  policy_type: "security" | "compliance" | "process";
  effective_date?: string;
}

export interface TodoFact extends BaseFact {
  fact_type: "Todo";
  description: string;
  status: "open" | "done" | "cancelled";
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

export type AnyFact =
  | FunctionChangeFact
  | TechDecisionFact
  | PolicyUpdateFact
  | TodoFact
  | VariableChangeFact;
