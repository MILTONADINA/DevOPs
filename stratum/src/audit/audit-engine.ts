/**
 * Audit engine — deterministic Tier-1 orchestration (Phase 5 / v0.6.x).
 *
 * Composes the indexer (git-indexer.ts) + attestation (git-attestation.ts) into the
 * runnable deterministic audit: attest each fact against the repo's code changes, and
 * suppress CONFLICT facts and persist evidence in one database call. FREE (no LLM);
 * the Tier-2 Llama / Tier-3 Opus escalation of UNVERIFIED
 * facts are separate gated modules. Built ahead of the v0.6.x gate as shadow code;
 * wired NOWHERE in the request path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
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

/** Stable UUIDv8 for one contradictory observation, scoped to its owning org. */
function conflictId(parts: readonly string[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Persist each deterministic outcome, suppressing CONFLICT facts and inserting
 * their Historical Drift alerts in one database transaction. org/session are
 * trusted FKs (ADR-0012), never derived from the fact.
 *
 * @param client - a configured Supabase client (service-role).
 * @param audited - the audit results.
 * @param ctx - trusted org/session FKs.
 * Replaying the same evidence does not replace an existing acknowledgement.
 * @returns the number of new conflict records inserted.
 * @throws {Error} if suppression or alert persistence fails.
 */
export async function persistAuditResults(client: SupabaseClient, audited: AuditedFact[], ctx: AuditContext): Promise<number> {
  const rows = audited
    .map((a) => {
      const table = tableForFactType(a.fact.fact_type);
      if (a.result.status !== "CONFLICT") return {
        fact_table: table,
        fact_id: a.fact.id,
        status: a.result.status,
        ...(a.result.evidence?.commitHash !== undefined ? { evidence_commit: a.result.evidence.commitHash } : {}),
      };
      const claimed = factToText(a.fact);
      const actual = a.result.conflictDetail ?? "conflict";
      const commit = a.result.conflictCommit ?? "";
      return {
        id: conflictId([ctx.orgId, table, a.fact.id, claimed, actual, commit]),
        fact_table: table,
        fact_id: a.fact.id,
        status: "CONFLICT",
        claimed_state: claimed,
        actual_state: actual,
        ...(a.result.conflictCommit !== undefined ? { conflict_commit: a.result.conflictCommit } : {}),
      };
    });
  if (rows.length === 0) return 0;
  const { data, error } = await client.rpc("persist_audit_results", {
    p_org_id: ctx.orgId, p_session_id: ctx.sessionId, p_rows: rows,
  });
  if (error) throw new Error(`persistAuditResults failed: ${error.message}`);
  return data as number;
}

/** Compatibility entry point for callers that only persist conflicts. */
export async function persistConflicts(client: SupabaseClient, audited: AuditedFact[], ctx: AuditContext): Promise<number> {
  return persistAuditResults(client, audited.filter((a) => a.result.status === "CONFLICT"), ctx);
}
