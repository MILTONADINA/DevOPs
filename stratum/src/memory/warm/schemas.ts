/**
 * Zod Schemas for Structured Fact Types (Phase 3 / v0.5.x).
 *
 * Fact-extraction outputs (Tier-2) are validated against these before any write.
 * Per stratum CLAUDE.md ("Invalid data is discarded" / "Extract structured facts
 * only, never summaries"), `validateFact` returns null on a schema miss so the
 * caller drops it — FAIL-CLOSED against malformed extractions. Pure + testable;
 * the Supabase write adapter that consumes validated facts is gated separately.
 *
 * Schemas mirror src/types/facts.ts exactly (a discriminated union on fact_type).
 */

import { z } from "zod";
import type { AnyFact } from "../../types/facts";
import { CHANGE_TYPES, POLICY_TYPES, TODO_STATUSES } from "../../types/facts";

const baseFields = {
  id: z.string().min(1),
  created_at: z.string().min(1),
  session_id: z.string().min(1),
  developer_id: z.string().optional(),
  commit_hash: z.string().optional(),
  confidence: z.number().min(0).max(1),
  is_verified: z.boolean(),
  is_suppressed: z.boolean(),
};

export const functionChangeSchema = z.object({
  ...baseFields,
  fact_type: z.literal("FunctionChange"),
  old_name: z.string().min(1),
  new_name: z.string().optional(),
  change_type: z.enum(CHANGE_TYPES),
  file_path: z.string().optional(),
  language: z.string().optional(),
});

export const techDecisionSchema = z.object({
  ...baseFields,
  fact_type: z.literal("TechDecision"),
  decision_text: z.string().min(1),
  domain: z.string().min(1),
  rationale: z.string().optional(),
  supersedes_id: z.string().optional(),
});

export const policyUpdateSchema = z.object({
  ...baseFields,
  fact_type: z.literal("PolicyUpdate"),
  policy_name: z.string().min(1),
  old_value: z.string().optional(),
  new_value: z.string().min(1),
  policy_type: z.enum(POLICY_TYPES),
  effective_date: z.string().optional(),
});

export const todoSchema = z.object({
  ...baseFields,
  fact_type: z.literal("Todo"),
  description: z.string().min(1),
  status: z.enum(TODO_STATUSES),
  due_date: z.string().optional(),
  assigned_to: z.string().optional(),
});

export const variableChangeSchema = z.object({
  ...baseFields,
  fact_type: z.literal("VariableChange"),
  var_name: z.string().min(1),
  old_value: z.string().optional(),
  new_value: z.string().min(1),
  context: z.string().optional(),
});

/** Discriminated union over all fact types (keyed on fact_type). */
export const factSchema = z.discriminatedUnion("fact_type", [
  functionChangeSchema,
  techDecisionSchema,
  policyUpdateSchema,
  todoSchema,
  variableChangeSchema,
]);

/**
 * Validate an extracted fact, returning it typed or null (discard on miss).
 *
 * @param input - the candidate fact (untrusted extractor output).
 * @returns the validated {@link AnyFact}, or null if it fails the schema.
 */
export function validateFact(input: unknown): AnyFact | null {
  const result = factSchema.safeParse(input);
  return result.success ? (result.data as AnyFact) : null;
}
