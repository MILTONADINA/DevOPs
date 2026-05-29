/**
 * Tier 2 — Warm Memory (Supabase Structured Facts).
 *
 * Stores ~30 days of typed structured facts extracted from sessions — NEVER
 * summaries (per stratum CLAUDE.md). Each {@link AnyFact} is routed to its own
 * Postgres table (function_changes / tech_decisions / policy_updates / todos /
 * variable_changes) and read back as a typed fact.
 *
 * Design (see docs/decisions/0012-tier2-warm-memory-adapter.md):
 *  - TRUSTED-FK INJECTION. The fact tables require `org_id` + `session_id` as
 *    real FK UUIDs, but an extracted {@link AnyFact} carries no org_id and only a
 *    logical session_id. The caller supplies the resolved DB FKs via
 *    {@link PersistContext}; those ALWAYS override anything on the fact — the same
 *    forgery-prevention principle the extractor enforces (server context wins
 *    over model/derived values). `developer_id` / `supersedes_id` / `assigned_to`
 *    are resolved server-side, never trusted off the fact; the extractor already
 *    strips them, so absent → written as SQL NULL.
 *  - FAIL-CLOSED. Every fact is re-validated (validateFact) before write and on
 *    read; anything that fails the schema is dropped, never persisted/returned.
 *  - The pure projection (tableForFactType / factToRow / rowToFact) is exported
 *    and unit-tested with no live client; createWarmMemory wires it to Supabase.
 *
 * Access is async (~5–50ms), off the request hot path — facts are written on
 * Tier-1 eviction and queried only when Tier-1 is insufficient.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyFact, FactType } from "../../types/facts";
import { validateFact } from "./schemas";

/** fact_type → its Postgres table name. */
export const FACT_TABLES: Record<FactType, string> = {
  FunctionChange: "function_changes",
  TechDecision: "tech_decisions",
  PolicyUpdate: "policy_updates",
  Todo: "todos",
  VariableChange: "variable_changes",
};

/** Reverse of {@link FACT_TABLES}: table name → fact_type (for reads). */
export const TABLE_FACT_TYPES: Record<string, FactType> = Object.fromEntries(
  (Object.entries(FACT_TABLES) as [FactType, string][]).map(([ft, table]) => [table, ft]),
);

/**
 * DB columns that exist on the fact tables but are NOT part of the {@link AnyFact}
 * shape — stripped when reconstructing a fact on read.
 *  - org_id: a write-time trusted FK, not a fact field.
 *  - promoted_to_t3: Tier-3 promotion bookkeeping, set by the promoter.
 */
const NON_FACT_COLUMNS = ["org_id", "promoted_to_t3"] as const;

/**
 * Trusted, server-resolved foreign keys the caller supplies at persist time.
 * These override any org/session value carried on the fact (forgery-safe).
 */
export interface PersistContext {
  /** Real organizations(id) UUID — owns the facts (NOT NULL on every fact table). */
  orgId: string;
  /** Real sessions(id) UUID — the DB session row these facts belong to. */
  sessionId: string;
}

/** Outcome of a {@link WarmMemory.persist} call. */
export interface PersistResult {
  /** Facts written to the DB. */
  persisted: number;
  /** Facts dropped because they failed schema re-validation (FAIL-CLOSED). */
  skipped: number;
  /** Per-table DB errors (the whole table batch failed). */
  errors: { table: string; message: string }[];
}

/** Options for {@link WarmMemory.queryRecent}. */
export interface QueryRecentOptions {
  /** Max facts to return (after merging + sorting all tables). Default 50. */
  limit?: number;
  /** Restrict to a single session (else all of the org's recent facts). */
  sessionId?: string;
}

/** Options for {@link WarmMemory.queryUnpromoted}. */
export interface QueryUnpromotedOptions {
  /** Only facts created strictly before this ISO timestamp (e.g. now − 30d). */
  olderThanIso?: string;
  /** Max facts to return (oldest-first). Default 100. */
  limit?: number;
}

export interface WarmMemory {
  /**
   * Persist validated facts to their warm-memory tables.
   *
   * @param facts - extracted facts (re-validated here; invalid ones dropped).
   * @param ctx - trusted org/session FKs (override any value on the fact).
   * @returns counts of persisted/skipped facts + any per-table DB errors.
   */
  persist(facts: AnyFact[], ctx: PersistContext): Promise<PersistResult>;
  /**
   * Read recent facts back as typed {@link AnyFact}s (newest first).
   *
   * @param orgId - the organizations(id) whose facts to read.
   * @param opts - limit + optional session filter.
   * @returns validated facts, newest-first, capped at opts.limit.
   * @throws {Error} if any underlying table read fails (reads must be reliable —
   *   a silent partial would look like "no memory" and mislead the caller).
   */
  queryRecent(orgId: string, opts?: QueryRecentOptions): Promise<AnyFact[]>;
  /**
   * Read facts NOT yet promoted to Tier-3 (`promoted_to_t3 = false`), oldest-first —
   * the nightly Tier-2 → Tier-3 promotion job's input.
   *
   * @param orgId - the organization.
   * @param opts - optional age cutoff (`olderThanIso`) + limit.
   * @returns unpromoted facts (oldest-first), capped at opts.limit.
   * @throws {Error} if any underlying table read fails.
   */
  queryUnpromoted(orgId: string, opts?: QueryUnpromotedOptions): Promise<AnyFact[]>;
  /**
   * Mark facts promoted (`promoted_to_t3 = true`) after Tier-3 promotion — NEVER
   * deletes (the append-only audit trail per CLAUDE.md). Routed to each fact's table
   * by fact_type + id, and SCOPED to `orgId` so a stray id from another org can
   * never be marked (cross-tenant safety; the service-role key bypasses RLS).
   *
   * @param facts - the facts to mark.
   * @param orgId - the trusted owning organization (rows are matched on id AND org_id).
   * @returns the number of rows marked.
   * @throws {Error} if an update fails.
   */
  markPromoted(facts: AnyFact[], orgId: string): Promise<number>;
}

/**
 * Resolve the Postgres table a fact belongs in.
 *
 * @param factType - the fact discriminator.
 * @returns the table name.
 * @throws {Error} if the fact_type has no mapped table (defensive — unreachable
 *   for a validated {@link AnyFact}).
 */
export function tableForFactType(factType: FactType): string {
  const table = FACT_TABLES[factType];
  if (!table) throw new Error(`No warm-memory table for fact_type "${factType}"`);
  return table;
}

/**
 * Project a fact into an insertable DB row: drop the discriminator (not a
 * column), drop undefined optionals (so they become SQL NULL rather than an
 * explicit null), and force org_id/session_id from the trusted context.
 *
 * @param fact - the fact to write.
 * @param ctx - trusted FKs (always win over anything on the fact).
 * @returns the target table + the row object to insert.
 */
export function factToRow(fact: AnyFact, ctx: PersistContext): { table: string; row: Record<string, unknown> } {
  const table = tableForFactType(fact.fact_type);
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fact)) {
    // `fact_type` is the discriminator, not a column. session_id is replaced by
    // the trusted FK below; never trust the fact's own org/session.
    if (k === "fact_type" || k === "session_id" || k === "org_id") continue;
    if (v !== undefined) row[k] = v;
  }
  row["session_id"] = ctx.sessionId; // trusted FK (overrides the fact's logical id)
  row["org_id"] = ctx.orgId; // trusted FK (facts carry none)
  return { table, row };
}

/**
 * Reconstruct a typed fact from a DB row: re-attach the fact_type discriminator,
 * drop non-fact columns (org_id / promoted_to_t3), and coerce SQL NULLs to absent
 * (Zod `.optional()` rejects null), then validate.
 *
 * @param table - the source table (determines the fact_type).
 * @param row - the raw DB row.
 * @returns the validated fact, or null if the row fails the schema (FAIL-CLOSED).
 */
export function rowToFact(table: string, row: Record<string, unknown>): AnyFact | null {
  const factType = TABLE_FACT_TYPES[table];
  if (!factType) return null;
  const candidate: Record<string, unknown> = { fact_type: factType };
  for (const [k, v] of Object.entries(row)) {
    if ((NON_FACT_COLUMNS as readonly string[]).includes(k)) continue;
    if (v === null || v === undefined) continue; // NULL column → absent optional
    candidate[k] = v;
  }
  return validateFact(candidate);
}

/**
 * Create a Tier-2 warm-memory adapter over a Supabase client.
 *
 * @param client - a configured Supabase client (service-role key; bypasses RLS).
 * @returns a {@link WarmMemory}.
 */
export function createWarmMemory(client: SupabaseClient): WarmMemory {
  return {
    async persist(facts: AnyFact[], ctx: PersistContext): Promise<PersistResult> {
      // Re-validate (defense in depth) and group surviving rows by table so each
      // table is one batch upsert. All rows in a batch share the trusted FKs, so
      // a batch failure is systemic (bad FK / connection) and applies to the
      // whole group — making per-table error attribution accurate. We UPSERT on the
      // primary key (id, minted by the extractor) rather than insert, so a retry
      // after a transient failure (see MemoryManager.drain) is idempotent — it
      // cannot create duplicate fact rows.
      const byTable = new Map<string, Record<string, unknown>[]>();
      let skipped = 0;
      for (const fact of facts) {
        if (!validateFact(fact)) {
          skipped++;
          continue;
        }
        const { table, row } = factToRow(fact, ctx);
        const bucket = byTable.get(table);
        if (bucket) bucket.push(row);
        else byTable.set(table, [row]);
      }

      let persisted = 0;
      const errors: { table: string; message: string }[] = [];
      for (const [table, rows] of byTable) {
        const { error } = await client.from(table).upsert(rows, { onConflict: "id" });
        if (error) errors.push({ table, message: error.message });
        else persisted += rows.length;
      }
      return { persisted, skipped, errors };
    },

    async queryRecent(orgId: string, opts: QueryRecentOptions = {}): Promise<AnyFact[]> {
      const limit = opts.limit ?? 50;
      const tables = Object.values(FACT_TABLES);
      const results = await Promise.all(
        tables.map(async (table) => {
          let q = client.from(table).select("*").eq("org_id", orgId);
          if (opts.sessionId !== undefined) q = q.eq("session_id", opts.sessionId);
          const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
          return { table, data, error };
        }),
      );

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        const detail = failed.map((r) => `${r.table}: ${r.error?.message}`).join("; ");
        throw new Error(`Tier-2 queryRecent failed: ${detail}`);
      }

      const facts: AnyFact[] = [];
      for (const { table, data } of results) {
        for (const row of (data ?? []) as Record<string, unknown>[]) {
          const fact = rowToFact(table, row);
          if (fact) facts.push(fact);
        }
      }
      // Merge across tables, newest-first, then cap.
      facts.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      return facts.slice(0, limit);
    },

    async queryUnpromoted(orgId: string, opts: QueryUnpromotedOptions = {}): Promise<AnyFact[]> {
      const limit = opts.limit ?? 100;
      const tables = Object.values(FACT_TABLES);
      const results = await Promise.all(
        tables.map(async (table) => {
          let q = client.from(table).select("*").eq("org_id", orgId).eq("promoted_to_t3", false);
          if (opts.olderThanIso !== undefined) q = q.lt("created_at", opts.olderThanIso);
          const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
          return { table, data, error };
        }),
      );
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        throw new Error(`Tier-2 queryUnpromoted failed: ${failed.map((r) => `${r.table}: ${r.error?.message}`).join("; ")}`);
      }
      const facts: AnyFact[] = [];
      for (const { table, data } of results) {
        for (const row of (data ?? []) as Record<string, unknown>[]) {
          const fact = rowToFact(table, row);
          if (fact) facts.push(fact);
        }
      }
      // Oldest-first (promote the longest-resident facts first), then cap.
      facts.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      return facts.slice(0, limit);
    },

    async markPromoted(facts: AnyFact[], orgId: string): Promise<number> {
      let marked = 0;
      for (const fact of facts) {
        const table = tableForFactType(fact.fact_type);
        const { error } = await client.from(table).update({ promoted_to_t3: true }).eq("id", fact.id).eq("org_id", orgId);
        if (error) throw new Error(`markPromoted failed (${table}/${fact.id}): ${error.message}`);
        marked++;
      }
      return marked;
    },
  };
}
