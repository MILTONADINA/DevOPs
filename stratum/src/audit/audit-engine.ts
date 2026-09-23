/**
 * Audit engine — deterministic Tier-1 orchestration (Phase 5 / v0.6.x).
 *
 * Composes the indexer (git-indexer.ts) + attestation (git-attestation.ts) into the
 * runnable deterministic audit: attest each fact against the repo's code changes, and
 * persist CONFLICTs to `audit_conflicts` (suppressed — the spec's "log conflict +
 * alert" step). FREE (no LLM); the Tier-2 Llama / Tier-3 Opus escalation of UNVERIFIED
 * facts are separate gated modules. Built ahead of the v0.6.x gate as shadow code;
 * wired NOWHERE in the request path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyFact } from "../types/facts";
import { attestFact, type AttestationResult, type CodeChange } from "./git-attestation";
import { tableForFactType } from "../memory/warm/tier2";
import { factToText } from "../memory/promote";

/** A fact paired with its Tier-1 attestation result. */
export interface AuditedFact {
  fact: AnyFact;
  result: AttestationResult;
}

/**
 * Attest each fact against the indexed code changes (pure, deterministic).
 *
 * @param facts - the facts to audit.
 * @param changes - the indexer's code changes (from indexRepository).
 * @returns each fact with its {@link AttestationResult}.
 */
export function auditFacts(facts: AnyFact[], changes: CodeChange[]): AuditedFact[] {
  return facts.map((fact) => ({ fact, result: attestFact(fact, changes) }));
}

/** Counts of each attestation status across an audit run. */
export interface AuditSummary {
  confirmed: number;
  unverified: number;
  conflict: number;
}

/** Tally the audit results by status. */
export function summarizeAudit(audited: AuditedFact[]): AuditSummary {
  const s: AuditSummary = { confirmed: 0, unverified: 0, conflict: 0 };
  for (const a of audited) {
    if (a.result.status === "CONFIRMED") s.confirmed++;
    else if (a.result.status === "CONFLICT") s.conflict++;
    else s.unverified++;
  }
  return s;
}

export interface AuditContext {
  /** Trusted owning organization. */
  orgId: string;
  /** Trusted session this audit ran under. */
  sessionId: string;
}

/**
 * Persist CONFLICT results to `audit_conflicts` (suppressed = true) — the Historical
 * Drift log/alert sink. CONFIRMED / UNVERIFIED are not logged here. org/session are
 * trusted FKs (ADR-0012), never derived from the fact.
 *
 * @param client - a configured Supabase client (service-role).
 * @param audited - the audit results (only CONFLICTs are written).
 * @param ctx - trusted org/session FKs.
 * @returns the number of conflicts recorded.
 * @throws {Error} if the insert fails.
 */
export async function persistConflicts(client: SupabaseClient, audited: AuditedFact[], ctx: AuditContext): Promise<number> {
  const rows = audited
    .filter((a) => a.result.status === "CONFLICT")
    .map((a) => ({
      org_id: ctx.orgId,
      session_id: ctx.sessionId,
      fact_table: tableForFactType(a.fact.fact_type),
      fact_id: a.fact.id,
      claimed_state: factToText(a.fact),
      actual_state: a.result.conflictDetail ?? "conflict",
      ...(a.result.conflictCommit !== undefined ? { conflict_commit: a.result.conflictCommit } : {}),
      suppressed: true,
    }));
  if (rows.length === 0) return 0;
  const { error } = await client.from("audit_conflicts").insert(rows);
  if (error) throw new Error(`persistConflicts failed: ${error.message}`);
  return rows.length;
}
