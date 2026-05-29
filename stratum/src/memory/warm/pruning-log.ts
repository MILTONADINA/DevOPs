/**
 * Pruning-log persistence (Phase 1 measurement / v0.5.x).
 *
 * Persists a KadaneDial {@link PruneDecision} to the `pruning_logs` table — the
 * audit/measurement record of what the pruner selected vs. dropped for a query,
 * with the dial params it ran under. This is OBSERVATION, not request mutation:
 * pruning stays SHADOW-MODE (off the request path) until the Tier-A eval passes
 * (constitution + ADR-0009); this just durably records the shadow decisions the
 * `shadow-prune` measurement already computes, so they can be analyzed/dashboarded
 * from the DB instead of only locally.
 *
 * The pure mapping (`spanToRange` / `pruneDecisionToRow`) is exported + unit-tested
 * with no client; `createPruningLogStore(client)` wires the insert. `session_id`
 * is a trusted FK supplied by the caller (never derived from untrusted content),
 * mirroring the Tier-2 adapter's forgery-prevention model (ADR-0012).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PruneDecision } from "../../pruner/kadanedial";

/**
 * Format an inclusive span `[start, end]` as a Postgres `int4range` literal.
 * Postgres canonicalizes the inclusive `[s,e]` to the half-open `[s,e+1)` on
 * storage; the inclusive literal is the unambiguous input form.
 *
 * @param span - inclusive `[start, end]` turn-index span.
 * @returns the `int4range` literal string (e.g. `"[1,3]"`).
 */
export function spanToRange(span: [number, number]): string {
  return `[${span[0]},${span[1]}]`;
}

/**
 * Map a {@link PruneDecision} to an insertable `pruning_logs` row.
 *
 * @param sessionId - the trusted sessions(id) FK this decision belongs to.
 * @param decision - the pruner's decision (indices + scores + params).
 * @returns the row object for insert (arrays as JS arrays; spans as int4range literals).
 */
export function pruneDecisionToRow(sessionId: string, decision: PruneDecision): Record<string, unknown> {
  return {
    session_id: sessionId,
    turns_total: decision.selectedIndices.length + decision.prunedIndices.length,
    turns_selected: decision.selectedIndices,
    turns_pruned: decision.prunedIndices,
    relevance_scores: decision.normalizedScores,
    spans_selected: decision.spans.map(spanToRange),
    lambda_used: decision.params.lambda,
    gain_shift_used: decision.params.gainShift,
    theta_used: decision.params.theta,
  };
}

export interface PruningLogStore {
  /**
   * Persist a pruning decision to `pruning_logs`.
   *
   * @param sessionId - the trusted sessions(id) FK.
   * @param decision - the {@link PruneDecision} to record.
   * @returns the new pruning_logs(id).
   * @throws {Error} if the insert fails.
   */
  recordPruning(sessionId: string, decision: PruneDecision): Promise<string>;
}

/**
 * Create a pruning-log store over a Supabase client.
 *
 * @param client - a configured Supabase client (service-role key; bypasses RLS).
 * @returns a {@link PruningLogStore}.
 */
export function createPruningLogStore(client: SupabaseClient): PruningLogStore {
  return {
    async recordPruning(sessionId: string, decision: PruneDecision): Promise<string> {
      const row = pruneDecisionToRow(sessionId, decision);
      const created = await client.from("pruning_logs").insert(row).select("id").single();
      if (created.error || !created.data) throw new Error(`recordPruning failed: ${created.error?.message ?? "no row returned"}`);
      return (created.data as { id: string }).id;
    },
  };
}
