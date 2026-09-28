/**
 * Core Session Types
 *
 * See docs/TECHNICAL_SPEC.md for the authoritative schema.
 */

export interface Session {
  id: string;
  org_id: string;
  developer_id: string;
  created_at: number;
  model: string;
  config: SessionConfig;
}

export interface SessionConfig {
  lambda: number;
  gain_shift: number;
  theta: number;
  embedding_model: string;
  audit_enabled: boolean;
  zk_enabled: boolean;
}

export interface Turn {
  id: string;
  session_id: string;
  timestamp: number;
  role: "user" | "assistant" | "tool";
  content: string;
  token_count: number;
  embedding: Float32Array;
  tool_name?: string;
  tool_call_id?: string;
}
