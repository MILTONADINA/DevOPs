/**
 * Git-Attestation — Tier-1 of the audit engine (Phase 5 / v0.6.x).
 *
 * The audit engine stops CQ's memory from becoming a hallucination amplifier: a
 * stored-then-injected FALSE fact makes the AI worse. Tier-1 is the **deterministic,
 * $0** gate (docs/AUDIT_ENGINE.md): for code-related facts, cross-reference the fact
 * against the project's real commit history and return CONFIRMED / UNVERIFIED /
 * CONFLICT. CONFLICT ⇒ suppress + alert; UNVERIFIED ⇒ escalate to the (gated) Tier-2
 * Llama spot-check; CONFIRMED ⇒ inject with a CONFIRMED tag.
 *
 * STATUS / SCOPE: this is the PURE deterministic decision core — it operates on an
 * in-memory list of {@link CodeChange}s (the git indexer's output), NOT on a live
 * graph/DB, so it is unit-testable with no I/O. Built ahead of the v0.6.x phase gate
 * as preparatory shadow code (the same pattern as the v0.4.x pruner), wired NOWHERE
 * in the request path. DEVIATIONS from docs/AUDIT_ENGINE.md (Neo4j-era): (a) the spec
 * queries Neo4j; per ADR-0013 the graph is on Supabase, and this core is decoupled
 * from storage entirely (takes CodeChange[]); the indexer→store wiring is a later
 * slice. (b) Tier-2 (Llama) + Tier-3 (Opus) escalation are LLM-gated (separate files).
 * (c) `ChangeType` here is the fact enum (deprecated/renamed/signature_changed); the
 * git-diff side uses added/deleted/renamed/modified — mapped below.
 */

import type { AnyFact } from "../types/facts";

/** A structured code change parsed from git history (the indexer's output unit). */
export interface CodeChange {
  /** The symbol touched (function or variable name). */
  entity: string;
  /** What happened to it in this commit. */
  changeType: "added" | "deleted" | "renamed" | "modified";
  /** For a rename: the new name (`entity` renamed → `toEntity`). */
  toEntity?: string;
  commitHash: string;
  message: string;
  /** Commit time (Unix seconds). */
  timestampSeconds: number;
  filePath?: string;
}

export interface AttestationEvidence {
  commitHash: string;
  commitMessage: string;
  timestampSeconds: number;
  filePath?: string;
}

export interface AttestationResult {
  status: "CONFIRMED" | "UNVERIFIED" | "CONFLICT";
  /** The commit that confirms the fact (present when CONFIRMED). */
  evidence?: AttestationEvidence;
  /** Why it conflicts (present when CONFLICT). */
  conflictDetail?: string;
}

/**
 * Is this fact code-related (and thus deterministically attestable)? Per
 * docs/AUDIT_ENGINE.md: FunctionChange, VariableChange, or TechDecision in an
 * infrastructure/database domain.
 *
 * @param fact - the fact.
 * @returns true if Git-Attestation applies.
 */
export function isCodeRelated(fact: AnyFact): boolean {
  if (fact.fact_type === "FunctionChange" || fact.fact_type === "VariableChange") return true;
  if (fact.fact_type === "TechDecision") {
    const d = fact.domain.toLowerCase();
    return d.includes("infra") || d.includes("database") || d === "db";
  }
  return false;
}

function factTimeSeconds(fact: AnyFact): number {
  const ms = Date.parse(fact.created_at);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function asEvidence(c: CodeChange): AttestationEvidence {
  return { commitHash: c.commitHash, commitMessage: c.message, timestampSeconds: c.timestampSeconds, ...(c.filePath !== undefined ? { filePath: c.filePath } : {}) };
}

/** The latest change (after `afterTime`) whose effect concerns `symbol` (touches or renames-to it). */
function latestChangeTo(symbol: string, changes: CodeChange[], afterTime: number): CodeChange | undefined {
  let latest: CodeChange | undefined;
  for (const c of changes) {
    if (c.timestampSeconds <= afterTime) continue;
    if (c.entity === symbol || c.toEntity === symbol) {
      if (!latest || c.timestampSeconds > latest.timestampSeconds) latest = c;
    }
  }
  return latest;
}

/** Does `c` (the latest change to `symbol`) leave `symbol` ABSENT? */
function leavesAbsent(c: CodeChange, symbol: string): boolean {
  if (c.entity === symbol && c.changeType === "deleted") return true;
  if (c.entity === symbol && c.changeType === "renamed") return c.toEntity !== symbol; // renamed away
  return false;
}

/**
 * Attest a fact against indexed git changes (Tier-1, deterministic).
 *
 * @param fact - the fact to verify.
 * @param changes - structured code changes from the git index.
 * @returns the {@link AttestationResult}.
 */
export function attestFact(fact: AnyFact, changes: CodeChange[]): AttestationResult {
  if (!isCodeRelated(fact)) return { status: "UNVERIFIED" };

  if (fact.fact_type === "FunctionChange") {
    // 1) Find a commit that CONFIRMS the asserted change.
    let confirm = changes.find((c) => {
      if (c.entity !== fact.old_name) return false;
      switch (fact.change_type) {
        case "renamed":
          return c.changeType === "renamed" && (fact.new_name === undefined || c.toEntity === fact.new_name);
        case "deprecated":
          return c.changeType === "deleted" || c.changeType === "renamed"; // removed or renamed away
        case "signature_changed":
          return c.changeType === "modified";
        default:
          return false;
      }
    });
    // The indexer does not infer symbol renames; a rename surfaces in diffs as
    // delete-old + add-new. Treat that pair as rename confirmation (the add is the evidence).
    if (!confirm && fact.change_type === "renamed" && fact.new_name !== undefined) {
      const delOld = changes.find((c) => c.entity === fact.old_name && c.changeType === "deleted");
      const addNew = changes.find((c) => c.entity === fact.new_name && c.changeType === "added");
      if (delOld && addNew) confirm = addNew;
    }

    // 2) Determine the symbol whose CURRENT existence the fact asserts, and check
    //    whether a LATER change contradicts that (Historical Drift).
    const anchor = confirm?.timestampSeconds ?? factTimeSeconds(fact);
    // renamed/signature_changed assert a symbol EXISTS now; deprecated asserts old_name is GONE.
    const assertedExists = fact.change_type === "renamed" ? fact.new_name : fact.change_type === "signature_changed" ? fact.old_name : undefined;
    const assertedGone = fact.change_type === "deprecated" ? fact.old_name : undefined;

    if (assertedExists !== undefined) {
      const latest = latestChangeTo(assertedExists, changes, anchor);
      if (latest && leavesAbsent(latest, assertedExists)) {
        return { status: "CONFLICT", conflictDetail: `${assertedExists} was ${latest.changeType} in commit ${latest.commitHash} (${latest.timestampSeconds}) after the claimed change — the memory is stale.` };
      }
    }
    if (assertedGone !== undefined) {
      const latest = latestChangeTo(assertedGone, changes, anchor);
      if (latest && (latest.entity === assertedGone && latest.changeType === "added")) {
        return { status: "CONFLICT", conflictDetail: `${assertedGone} was re-added in commit ${latest.commitHash} (${latest.timestampSeconds}) after being deprecated — the memory is stale.` };
      }
    }

    if (confirm) return { status: "CONFIRMED", evidence: asEvidence(confirm) };
    return { status: "UNVERIFIED" };
  }

  if (fact.fact_type === "VariableChange") {
    const confirm = changes.find((c) => c.entity === fact.var_name && (c.changeType === "modified" || c.changeType === "added"));
    return confirm ? { status: "CONFIRMED", evidence: asEvidence(confirm) } : { status: "UNVERIFIED" };
  }

  // TechDecision (infra/db): no deterministic git evidence for a decision → Tier-2.
  return { status: "UNVERIFIED" };
}
