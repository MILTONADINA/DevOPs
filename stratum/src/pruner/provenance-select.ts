/**
 * Provenance-gated exchange selection — pure classification + fail-closed
 * core (Phase 2 / v0.4 candidate, cycle 1a of
 * specs/pruner/provenance-gated-selection.md, ADR-0023). SHADOW-MODE, NOT
 * WIRED: this module is never called from the proxy request path; pruning
 * stays disabled everywhere (see pruner.ts's own header).
 *
 * This file implements REQ-1 to REQ-11 of the spec above as ONE pure,
 * synchronous function, `selectWithProvenance`, layered over the unchanged
 * `prune()`. It never talks to a database or an RPC: everything provenance
 * knows is INJECTED as a {@link ProvenanceSnapshot} — a hand-built one in
 * this module's own tests (T2-T6), and later a fixture-derived one
 * (`evals/harness/provenance-fixture.ts`, T7A) or a real RPC adapter's
 * output (cycle 1b, REQ-12, out of scope in this file).
 *
 * ── T2 + T3 implement ────────────────────────────────────────────────────
 *   (a) the five fail-closed guards (REQ-2) that make `selectWithProvenance`
 *       return the base decision unchanged, tagged with exactly one reason
 *       (T2);
 *   (b) `classifyFactRow`, the DEAD/LIVE/INERT + KEYED classifier (REQ-5,
 *       REQ-6's KEYED flag) (T2);
 *   (c) `computeContestedFactIds`, REQ-6's contest rule, feeding
 *       `provenance.contestedFactCount` (T3).
 *
 * ── T4 implements ────────────────────────────────────────────────────────
 *   (d) REQ-7 exclusion (`classifyExcludedExchanges`): an in-window exchange
 *       with >=1 fact row, every one DEAD, loses ALL of its window turns
 *       from the selection, including any the base decision carried. An
 *       exchange with any LIVE or INERT fact, or with no fact row at all, is
 *       never excluded;
 *   (e) REQ-8 successor transfer (`resolveSuccessorTransfers`): an excluded
 *       exchange that was base-selected or holds a DEAD fact with
 *       `queryMatch = true` follows `successorExchangeId` from EACH of its
 *       reviewed-obsolete facts (depth-first, backtracking to a node's next
 *       candidate when one branch dead-ends) — ONE visited set shared
 *       across the WHOLE resolution (every triggering exchange, every
 *       branch, in this call, not reset per chain or per hop) bounds total
 *       hops by the number of in-window exchanges — to the first in-window,
 *       non-excluded, no-failed-write exchange, adding ALL of THAT
 *       exchange's turns. A candidate already visited and already claimed as
 *       ANOTHER triggering exchange's resolved successor is itself a valid
 *       resolution for the CURRENT triggering exchange too (D1): two
 *       different triggering exchanges CAN share one successor when both
 *       independently reach it, and its turns are still only ever added
 *       once. A candidate visited only as an exhausted, unclaimed
 *       pass-through is still never re-entered. When no candidate resolves
 *       or is claimed, the exclusion stands and `droppedWithoutSuccessor`
 *       counts it.
 *
 * ── T5 implements ───────────────────────────────────────────────────────
 *   (f) REQ-9 rescue (`resolveRescue`): an in-window exchange the RAW BASE
 *       decision did not fully select is added WHOLE — every one of its
 *       turns — when it holds no DEAD fact, at least one of its KEYED facts
 *       has `queryMatch = true`, and every one of its KEYED facts is
 *       uncontested. Rescue is strictly set-based (per-exchange, over that
 *       exchange's own fact rows only): it never adds a turn because of its
 *       position relative to another selected/rescued exchange, and it never
 *       reads `decayedScores`/`normalizedScores`. A Todo-only or INERT-only
 *       exchange can never qualify — neither table is ever KEYED
 *       (`classifyFactRow`) — and a MIXED exchange (any DEAD fact alongside
 *       LIVE/INERT ones) is disqualified even though REQ-7 alone would not
 *       exclude it. Eligibility is checked against `base.selectedIndices`
 *       itself (REQ-8's own "was base-selected" notion), so an exchange
 *       REQ-8 already added via successor transfer can ALSO independently
 *       qualify and be counted as rescued — see `resolveRescue`'s own doc
 *       comment for why that is intentional, not a double-add.
 *
 * ── T6 implements ───────────────────────────────────────────────────────
 *   (g) REQ-10 completion: once any turn of a trusted, non-excluded
 *       exchange is in the merged (REQ-7/8/9-adjusted) selection, every
 *       other in-window turn of that exchange is added too — including an
 *       exchange with NO fact row at all, which REQ-7/8/9 never touch
 *       either way (see the fixture's `partner_completion` family, whose
 *       exchanges carry no rows and complete on that basis alone). An
 *       excluded exchange is REQ-10's own stated exception: it never comes
 *       back. `provenance.completedTurnCount` counts only the turns
 *       completion itself newly flips to selected, not every turn of the
 *       completed exchange — see `selectWithProvenance`'s own body for why
 *       that deliberately differs from `excludedTurnCount`'s/
 *       `rescuedTurnCount`'s "every turn of the exchange" convention;
 *   (h) confirming REQ-3 and REQ-4 hold for completion too: both are
 *       already enforced by the `windowIndices`/`turnsByExchangeId`
 *       derivation below (computed once, before any guard or provenance
 *       step runs) — completion reads that SAME structure, so an unbound
 *       turn or an out-of-window exchange can no more reach it than it
 *       could reach exclusion, successor transfer or rescue;
 *   (i) the REQ-1 property test (`test/pruner/provenance-select.test.ts`):
 *       randomized scoped/unscoped histories, a fixed clock and a small
 *       inline seeded PRNG (no property-testing library is a dependency of
 *       this repo) confirm `selectWithProvenance` deep-equals `prune()` on
 *       spans/selectedIndices/prunedIndices/candidateIndices/decayedScores/
 *       normalizedScores/params whenever no snapshot is supplied or no
 *       window turn carries an exchangeId.
 *
 * This function now implements REQ-1 through REQ-11 in full (this cycle's
 * scope, `specs/pruner/provenance-gated-selection.md` "Delivery" §1).
 * REQ-12 (the RPC), REQ-13 (shadow-observer wiring) and everything from
 * REQ-14 on are later work and are not implemented here.
 *
 * ── Signature (fixed here; every later task builds on it) ───────────────
 * `selectWithProvenance(queryEmbedding, history, params, queryScopeId?, snapshot?)`
 * keeps `prune()`'s own four parameters, in the same order, UNCHANGED in
 * type — `history`'s element type only ADDS an optional `exchangeId` (see
 * {@link ProvenanceHistoryTurn}), so any `ProvenanceHistoryTurn[]` is itself
 * a valid `HistoryEmbedding[]` — plus a trailing optional `snapshot`. That is
 * what makes REQ-1's property test direct: the same `(queryEmbedding,
 * history, params, queryScopeId)` can be handed to `prune()` and to
 * `selectWithProvenance()` (with `snapshot` omitted) and must produce an
 * identical spans/selectedIndices/prunedIndices/candidateIndices/
 * decayedScores/normalizedScores/params.
 *
 * ── The injected snapshot (REQ-12's shape, without an RPC) ──────────────
 * {@link ProvenanceFactRow} carries exactly the Definitions section's
 * fact-row fields: exchangeId, factTable, factId, keyHashes[], active,
 * reviewedObsolete, successorExchangeId, auditStatus, queryMatch. It has NO
 * organization/session/project column — REQ-12's RPC returns none either —
 * so at this pure function's boundary a "foreign" row can only mean
 * "exchangeId outside the caller's in-window set" (LOOKUP_INVALID below);
 * true tenant isolation is the RPC's job (cycle 1b).
 *
 * {@link ProvenanceSnapshot} bundles that lookup's outcome with the one
 * signal REQ-12 does NOT carry: per-exchange memory-write settlement. That
 * settlement is the shadow observer's EXISTING `failedExchanges` set (REQ-13,
 * `src/proxy/shadow-observer.ts`) — a set of exchangeIds known to have
 * failed, not a full ok/failed map, so a normal in-window exchange needs no
 * entry at all.
 *
 * {@link ProvenanceLookupResult} is the "lookup-fault input": `{kind:"ok",
 * rows}` on a normal response, or `{kind:"error"}` when the lookup ITSELF
 * rejected or timed out (REQ-2 LOOKUP_ERROR) — never for a row-level
 * problem, which is instead a malformed/duplicate/foreign row INSIDE `rows`
 * (REQ-2 LOOKUP_INVALID; see `isWellFormedRow`). `undefined` for the whole
 * `snapshot` argument models REQ-2's NO_SNAPSHOT.
 *
 * ── Guard precedence ─────────────────────────────────────────────────────
 * This function's own choice (each guard is independently unit-tested, but
 * a hand-built input can trip more than one at once):
 *   NO_SNAPSHOT → NO_EXCHANGE_IDS → WRITE_FAILED → LOOKUP_ERROR → LOOKUP_INVALID
 * WRITE_FAILED is checked before the lookup outcome because REQ-13's real
 * caller (the shadow observer) never even calls the lookup while a write is
 * unsettled ("calling the lookup only while incompleteExchangeCount === 0")
 * — so an unsettled write is reported as the write fault, not a lookup
 * fault, even if a test hands both at once.
 *
 * `ADAPTER_BOUND` (REQ-2's sixth reason) belongs to the RPC adapter (the
 * 1-128 exchange-count bound), a different, not-yet-written module (cycle
 * 1b). {@link ProvenanceReason} below is a CLOSED five-value union with no
 * `ADAPTER_BOUND` member, so this function cannot return it even by
 * mistake.
 */

import { prune, type HistoryEmbedding } from "./pruner";
import type { KadaneDialParams, PruneDecision } from "./kadanedial";

// ---------------------------------------------------------------------------
// History input (REQ-1: identical to prune()'s, plus an optional exchangeId)
// ---------------------------------------------------------------------------

/**
 * A {@link HistoryEmbedding} plus the trusted exchange it belongs to, if any.
 * An empty string is treated the same as absent (the codebase's existing
 * convention — see e.g. `shadow-observer.ts`'s `turn.exchangeId ? ... : []`).
 * A turn with no exchangeId is "unbound": REQ-3 keeps it untouched by
 * rescue (T5), exclusion or successor transfer (T4, both keyed off a turn's
 * `exchangeId`) or completion (T6).
 */
export interface ProvenanceHistoryTurn extends HistoryEmbedding {
  exchangeId?: string;
}

// ---------------------------------------------------------------------------
// The injected snapshot (REQ-12's shape, no RPC)
// ---------------------------------------------------------------------------

/**
 * The six Postgres fact tables (mirrors `FACT_TABLES`'s values,
 * `src/memory/warm/tier2.ts`) — duplicated here as literals rather than
 * imported, so this pure/offline selection module carries no dependency on
 * memory/warm's Supabase-facing import graph.
 */
export type ProvenanceFactTable = "function_changes" | "tech_decisions" | "policy_updates" | "todos" | "variable_changes" | "operational_references";

export const KNOWN_FACT_TABLES: ReadonlySet<string> = new Set<ProvenanceFactTable>(["function_changes", "tech_decisions", "policy_updates", "todos", "variable_changes", "operational_references"]);

/**
 * One fact row exactly as the Definitions section describes it: "one typed
 * fact from any of the six tables that belongs to a requested exchange."
 * `active`, `reviewedObsolete` and `auditStatus` are already-computed,
 * already-reviewed signals from REQ-12's RPC — this row shape has no field
 * for a raw, unreviewed model-extracted signal (a bare FunctionChange
 * rename pair, an unreviewed Tier-3 `SUPERSEDES` edge —
 * `src/memory/cold/graph.ts` — or a fact's own `is_verified`,
 * `src/types/facts.ts`), so {@link classifyFactRow} has nothing else it
 * COULD read even if it wanted to (REQ-5).
 */
export interface ProvenanceFactRow {
  /** The requested exchange this fact belongs to. */
  exchangeId: string;
  factTable: ProvenanceFactTable;
  factId: string;
  /** md5(lower(btrim(field))) identity-key hashes (REQ-6). Always empty for `todos` — Todo has no identity key. */
  keyHashes: string[];
  /** `NOT is_suppressed`. */
  active: boolean;
  /** The full "has a reviewed, unsuppressed, later successor" predicate (migrations `20260924235700`/`20260924235800`) — never merely "a successor exists". */
  reviewedObsolete: boolean;
  /** Set only when `reviewedObsolete` and the successor exchange is in the same session (REQ-12). */
  successorExchangeId?: string;
  auditStatus: "CONFIRMED" | "UNVERIFIED" | "CONFLICT" | null;
  /** The existing lexical query-to-fact match (`find_query_hot_fact_exchanges`), passed through unchanged. */
  queryMatch: boolean;
}

/**
 * The REQ-12 lookup's outcome, injected directly — this cycle has no RPC
 * adapter (that is cycle 1b). `"error"` models the lookup ITSELF rejecting
 * or timing out (REQ-2 LOOKUP_ERROR) — `cause` is carried through only for
 * a caller's own diagnostics/logging; this function never branches on it.
 * A row-level problem is never `"error"`; it is a malformed, duplicate or
 * foreign row inside `"ok"`'s `rows` (REQ-2 LOOKUP_INVALID).
 */
export type ProvenanceLookupResult = { readonly kind: "ok"; readonly rows: readonly ProvenanceFactRow[] } | { readonly kind: "error"; readonly cause?: "reject" | "timeout" };

/**
 * Everything this function is given about provenance, beyond the base
 * decision's own inputs. The whole `snapshot` argument being `undefined`
 * (not this type) models REQ-2's NO_SNAPSHOT.
 */
export interface ProvenanceSnapshot {
  readonly lookup: ProvenanceLookupResult;
  /**
   * In-window exchangeIds whose memory write is KNOWN to have failed — the
   * shadow observer's existing `failedExchanges` set (REQ-13), not a REQ-12
   * lookup column (REQ-12's RPC returns no `write` column at all). An
   * in-window exchangeId absent from this set is treated as settled `"ok"`.
   */
  readonly failedExchangeIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Fail-closed reason codes (REQ-2) — ADAPTER_BOUND deliberately absent
// ---------------------------------------------------------------------------

export type ProvenanceReason = "NO_SNAPSHOT" | "NO_EXCHANGE_IDS" | "WRITE_FAILED" | "LOOKUP_ERROR" | "LOOKUP_INVALID";

// ---------------------------------------------------------------------------
// REQ-11's decision record + the overall return type
// ---------------------------------------------------------------------------

/**
 * REQ-11's provenance record. `applied`/`reason`/`baseSelectedIndices` and
 * the λ/g/θ fields are always meaningful; every count (`contestedFactCount`
 * through `completedTurnCount`) is real once every REQ-2 guard passes and
 * stays 0 when a guard fails (REQ-2 returns the untouched base decision).
 *
 * The counts' exact semantics:
 *   (a) `excludedTurnCount` and `rescuedTurnCount` each count EVERY turn of
 *       their exchanges, not the net change to `selectedIndices` — REQ-7
 *       exclusion and REQ-9 rescue are both whole-exchange yes/no
 *       decisions (see `classifyExcludedExchanges`'s and `resolveRescue`'s
 *       own doc comments for the rule itself), so counting every turn
 *       describes the decision itself — see `selectWithProvenance`'s own
 *       body, at the completion step below, for that counting rationale.
 *   (b) `completedTurnCount` (REQ-10) counts only the turns the completion
 *       step itself newly flips to selected, NOT every turn of a completed
 *       exchange — see `selectWithProvenance`'s own body for why that
 *       deliberately differs from (a)'s "every turn of the exchange"
 *       convention.
 *   (c) `successorAddedCount` and `rescuedExchangeCount`/`rescuedTurnCount`
 *       are NOT a partition of exchanges: `resolveRescue` checks fullness
 *       against `base.selectedIndices` itself, not the REQ-7/8-adjusted
 *       working set, so an exchange REQ-8 already added via successor
 *       transfer can ALSO independently satisfy REQ-9 and be counted as
 *       rescued too — the two counts describe two independent,
 *       non-exclusive facts about the exchange (was it a successor
 *       target? does it separately meet the rescue conditions?), never a
 *       partition (see `resolveRescue`'s own doc comment for why that is
 *       intentional, not a double-add). An EXCLUDED exchange can never
 *       also be rescued (REQ-9(a) needs no DEAD fact; every excluded
 *       exchange is all-DEAD) or itself be a successor-transfer target
 *       (`resolveSuccessorTransfers` excludes it from eligibility), so
 *       this overlap is only ever between successor-added and rescued.
 *       Either way, a turn lands in the actual selection at most once —
 *       the caller merges every source into one `Set`.
 *   (d) `successorAddedCount` counts DISTINCT successor exchanges added,
 *       not distinct resolved triggering exchanges (D1 — see
 *       `resolveSuccessorTransfers`'s own doc comment): two different
 *       triggering exchanges can converge on and legitimately share one
 *       successor, which is added once and counted once for both. So
 *       `successorAddedCount + droppedWithoutSuccessor` need not equal
 *       the triggering-exchange count once that convergence happens —
 *       this record carries no triggering-exchange count of its own, so
 *       that gap is not recoverable from it after the fact.
 */
export interface ProvenanceRecord {
  /** `true` iff every REQ-2 guard passed (the overlay ran) — independent of whether the selection actually changed from the base. */
  applied: boolean;
  /** Set (non-null) iff `applied` is `false`: the one REQ-2 reason a guard fired. */
  reason: ProvenanceReason | null;
  baseSelectedIndices: number[];
  rescuedExchangeCount: number;
  rescuedTurnCount: number;
  excludedExchangeCount: number;
  excludedTurnCount: number;
  successorAddedCount: number;
  droppedWithoutSuccessor: number;
  completedTurnCount: number;
  contestedFactCount: number;
  lambda: number;
  gainShift: number;
  theta: number;
}

/** The base {@link PruneDecision} plus its {@link ProvenanceRecord}. */
export interface ProvenanceDecision extends PruneDecision {
  provenance: ProvenanceRecord;
}

// ---------------------------------------------------------------------------
// Classification (REQ-5, REQ-6's KEYED flag)
// ---------------------------------------------------------------------------

export type ProvenanceRowStatus = "DEAD" | "LIVE" | "INERT";

export interface ClassifiedProvenanceRow extends ProvenanceFactRow {
  status: ProvenanceRowStatus;
  /**
   * LIVE with >=1 identity-key hash (REQ-6). Never true for DEAD/INERT, and
   * never true for `todos` even if `keyHashes` is (incorrectly) non-empty —
   * Todo has no identity key (Definitions section). This is a defensive,
   * explicit check: upstream (the RPC / a fixture translator) is contracted
   * to never populate `keyHashes` for a Todo row, but KEYED never depends
   * on that contract holding.
   */
  keyed: boolean;
}

/**
 * Classify one fact row into DEAD / LIVE / INERT (+ KEYED). Precedence:
 * DEAD first — `reviewedObsolete === true` OR `auditStatus === "CONFLICT"`,
 * regardless of `active` — else LIVE when `active` — else INERT (suppressed,
 * not DEAD). See the file header + REQ-5 for why an unreviewed
 * model-extracted signal alone can never make `reviewedObsolete` (or
 * `auditStatus`) read as DEAD here: this function only ever sees those two
 * already-reviewed fields, never a raw rename pair, a SUPERSEDES edge or
 * `is_verified`.
 */
export function classifyFactRow(row: ProvenanceFactRow): ClassifiedProvenanceRow {
  if (row.reviewedObsolete === true || row.auditStatus === "CONFLICT") {
    return { ...row, status: "DEAD", keyed: false };
  }
  if (row.active) {
    return { ...row, status: "LIVE", keyed: row.factTable !== "todos" && row.keyHashes.length > 0 };
  }
  return { ...row, status: "INERT", keyed: false };
}

// ---------------------------------------------------------------------------
// Contest (REQ-6) — feeds ProvenanceRecord.contestedFactCount
// ---------------------------------------------------------------------------

/**
 * REQ-6: the `factId`s of every LIVE+KEYED fact that is CONTESTED — it
 * shares its `factTable` and at least one identity-key hash with another
 * LIVE+KEYED fact in a DIFFERENT exchange. For `tech_decisions`, the shared
 * `domain` hash contests only when BOTH facts have `queryMatch = true`: a
 * row with `queryMatch = false` can never satisfy "both true" no matter
 * what it is paired with, so it is excluded up front rather than gated
 * per-pair.
 *
 * A contest, once found, stays a contest — this function takes only
 * {@link ProvenanceFactRow}s, never `history` or a turn's `timestampSeconds`
 * / `embedding`, and it never reads `auditStatus` to decide a contest:
 * `CONFLICT` enters only through `classifyFactRow`'s DEAD classification,
 * which removes the fact from KEYED before grouping, so a `CONFIRMED` fact
 * (a git commit touched the symbol, not that the fact is current) is
 * grouped exactly like an `UNVERIFIED` or unaudited one. Exchange recency,
 * fact `created_at`, turn text and embedding similarity have no code path
 * here at all. Two facts in the same exchange never contest each other,
 * even when every other condition holds.
 *
 * Rows are grouped by `factTable\0hash` rather than compared pairwise (a
 * group is contested iff it names >=2 distinct exchanges) so this stays
 * linear in the row count, for REQ-17's latency budget.
 */
function computeContestedFactIds(rows: readonly ProvenanceFactRow[]): ReadonlySet<string> {
  const byTableAndHash = new Map<string, Array<{ factId: string; exchangeId: string }>>();
  for (const row of rows) {
    if (!classifyFactRow(row).keyed) continue;
    if (row.factTable === "tech_decisions" && !row.queryMatch) continue;
    for (const hash of row.keyHashes) {
      const groupKey = `${row.factTable}\0${hash}`;
      const entry = { factId: row.factId, exchangeId: row.exchangeId };
      const group = byTableAndHash.get(groupKey);
      if (group) group.push(entry);
      else byTableAndHash.set(groupKey, [entry]);
    }
  }
  const contested = new Set<string>();
  for (const group of byTableAndHash.values()) {
    const exchangeIds = new Set(group.map((entry) => entry.exchangeId));
    if (exchangeIds.size < 2) continue; // same-exchange-only sharing never contests
    for (const entry of group) contested.add(entry.factId);
  }
  return contested;
}

// ---------------------------------------------------------------------------
// Row well-formedness (backs LOOKUP_INVALID's "otherwise malformed")
// ---------------------------------------------------------------------------

/**
 * Runtime structural check backing LOOKUP_INVALID's "otherwise malformed"
 * (REQ-2). Takes `unknown` (not {@link ProvenanceFactRow}) because a
 * TypeScript-typed test cannot construct an actually-invalid row under the
 * strict row type without deliberately bypassing the compiler — exactly
 * what a malformed-row test does.
 */
function isWellFormedRow(row: unknown): row is ProvenanceFactRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.exchangeId === "string" &&
    r.exchangeId.length > 0 &&
    typeof r.factId === "string" &&
    r.factId.length > 0 &&
    typeof r.factTable === "string" &&
    KNOWN_FACT_TABLES.has(r.factTable) &&
    Array.isArray(r.keyHashes) &&
    r.keyHashes.every((h) => typeof h === "string" && h.length > 0) &&
    typeof r.active === "boolean" &&
    typeof r.reviewedObsolete === "boolean" &&
    (r.successorExchangeId === undefined || (typeof r.successorExchangeId === "string" && r.successorExchangeId.length > 0)) &&
    (r.auditStatus === null || r.auditStatus === "CONFIRMED" || r.auditStatus === "UNVERIFIED" || r.auditStatus === "CONFLICT") &&
    typeof r.queryMatch === "boolean"
  );
}

/**
 * REQ-2's three LOOKUP_INVALID conditions: a row's `exchangeId` outside
 * `windowExchangeIds` (foreign), a repeated `factId` (checked across the
 * WHOLE row set, not per table or per exchange), or an otherwise-malformed
 * row. An empty `rows` array is valid — not invalid — since a
 * completion-only snapshot legitimately carries no fact rows at all.
 */
function hasInvalidRow(rows: readonly unknown[], windowExchangeIds: ReadonlySet<string>): boolean {
  const seenFactIds = new Set<string>();
  for (const candidate of rows) {
    if (!isWellFormedRow(candidate)) return true;
    if (!windowExchangeIds.has(candidate.exchangeId)) return true;
    if (seenFactIds.has(candidate.factId)) return true;
    seenFactIds.add(candidate.factId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fail-closed guards (REQ-2)
// ---------------------------------------------------------------------------

/** See the file header's "Guard precedence" section for why the order below is fixed. */
function checkGuards(windowExchangeIds: ReadonlySet<string>, snapshot: ProvenanceSnapshot | undefined): ProvenanceReason | null {
  if (snapshot === undefined) return "NO_SNAPSHOT";
  if (windowExchangeIds.size === 0) return "NO_EXCHANGE_IDS";
  for (const id of windowExchangeIds) {
    if (snapshot.failedExchangeIds.has(id)) return "WRITE_FAILED";
  }
  if (snapshot.lookup.kind === "error") return "LOOKUP_ERROR";
  if (hasInvalidRow(snapshot.lookup.rows, windowExchangeIds)) return "LOOKUP_INVALID";
  return null;
}

// ---------------------------------------------------------------------------
// Exclusion (REQ-7) + successor transfer (REQ-8)
// ---------------------------------------------------------------------------

/** Well-formed, in-window fact rows (guard-validated), grouped by `exchangeId`. */
type RowsByExchangeId = ReadonlyMap<string, ProvenanceFactRow[]>;

function groupRowsByExchangeId(rows: readonly ProvenanceFactRow[]): RowsByExchangeId {
  const byExchangeId = new Map<string, ProvenanceFactRow[]>();
  for (const row of rows) {
    const bucket = byExchangeId.get(row.exchangeId);
    if (bucket) bucket.push(row);
    else byExchangeId.set(row.exchangeId, [row]);
  }
  return byExchangeId;
}

/**
 * REQ-7: an in-window exchange is EXCLUDED iff it has >=1 fact row and every
 * one of them classifies DEAD (via {@link classifyFactRow} — this never
 * re-derives DEAD/LIVE/INERT itself). An exchange absent from
 * `rowsByExchangeId` (no fact row at all) or holding any LIVE/INERT row is
 * never excluded. Exclusion applies uniformly to every such exchange,
 * whether or not it is later found to be a REQ-8 trigger.
 *
 * Also computes REQ-8's trigger condition for each excluded exchange: it was
 * base-selected (any of its window turns is in `baseSelectedIndices`, i.e.
 * `prune()`'s own `selectedIndices` before any provenance change) or it
 * holds a DEAD fact with `queryMatch = true`. Only a triggering exchange
 * attempts successor transfer; a non-triggering excluded exchange still
 * loses its turns, but `droppedWithoutSuccessor` is never incremented for it
 * (there was nothing to resolve).
 */
function classifyExcludedExchanges(
  rowsByExchangeId: RowsByExchangeId,
  turnsByExchangeId: ReadonlyMap<string, number[]>,
  baseSelectedIndices: readonly number[],
): { excludedExchangeIds: ReadonlySet<string>; triggeringExchangeIds: ReadonlySet<string> } {
  const excludedExchangeIds = new Set<string>();
  for (const [exchangeId, rows] of rowsByExchangeId) {
    if (rows.length > 0 && rows.every((row) => classifyFactRow(row).status === "DEAD")) {
      excludedExchangeIds.add(exchangeId);
    }
  }

  const baseSelectedSet = new Set(baseSelectedIndices);
  const triggeringExchangeIds = new Set<string>();
  for (const exchangeId of excludedExchangeIds) {
    const wasBaseSelected = (turnsByExchangeId.get(exchangeId) ?? []).some((index) => baseSelectedSet.has(index));
    const hasDeadQueryMatch = (rowsByExchangeId.get(exchangeId) ?? []).some((row) => row.queryMatch === true && classifyFactRow(row).status === "DEAD");
    if (wasBaseSelected || hasDeadQueryMatch) triggeringExchangeIds.add(exchangeId);
  }

  return { excludedExchangeIds, triggeringExchangeIds };
}

/**
 * REQ-8: for each triggering excluded exchange (processed in ascending
 * first-window-turn-index order, for determinism), follow
 * `successorExchangeId` from EACH of its reviewed-obsolete facts (in row
 * order — a fact row never carries a successor unless `reviewedObsolete`,
 * {@link ProvenanceFactRow.successorExchangeId}'s own contract) to the first
 * candidate that is either already CLAIMED as another triggering exchange's
 * resolved successor (D1, below) or itself in the window, not excluded, and
 * has no failed write — adding ALL of that exchange's turns.
 *
 * A candidate that fails eligibility (excluded, has a failed write, or is
 * not in the window at all — so it has no rows to continue from) is itself
 * a pass-through: the search descends into ITS reviewed-obsolete facts
 * before trying the CURRENT exchange's NEXT candidate — depth-first with
 * backtracking, so an exchange with two DEAD facts pointing at two
 * different successors still finds a live one behind a dead first branch.
 *
 * ONE visited set is shared across the WHOLE resolution in this call (never
 * reset per exchange, per branch or per hop): an exchange, reached AS A
 * CANDIDATE (the target of some `successorExchangeId` edge), is entered at
 * most once (its edges are descended from at most once) — "at most one hop
 * per in-window exchange" as a bound on the WHOLE phase's total work
 * (REQ-17's latency budget) — regardless of how many different triggering
 * exchanges' searches reach it. A chain never re-descends into a candidate
 * any other chain — or its own earlier branch — already visited, which also
 * prevents cycles.
 *
 * That single walk's OUTCOME is shareable, though (D1): when a later chain
 * reaches a candidate that is both visited AND already recorded in
 * `successorAddedExchangeIds` (an earlier chain's search already resolved TO
 * it), the current chain resolves to that SAME candidate too, instead of
 * being dropped — two different triggering exchanges CAN legitimately share
 * one successor, since it is genuinely live and reachable from both, and the
 * shared candidate's turns are still only ever added once
 * (`successorAddedExchangeIds` is a `Set`; the caller iterates its members,
 * never a per-trigger list). A candidate that is visited but NOT in
 * `successorAddedExchangeIds` was only ever an exhausted, unclaimed
 * pass-through on that earlier walk, so it is still never re-entered — this
 * remains true even on the rare trail where that earlier walk went on to
 * resolve something live further along: only the node actually resolved TO
 * is ever recorded and shareable, not every pass-through node an earlier
 * chain happened to walk through on the way there. When no candidate
 * resolves or is claimed, the exclusion stands and the caller counts
 * `droppedWithoutSuccessor`.
 */
function resolveSuccessorTransfers(
  triggeringExchangeIdsInOrder: readonly string[],
  turnsByExchangeId: ReadonlyMap<string, number[]>,
  rowsByExchangeId: RowsByExchangeId,
  excludedExchangeIds: ReadonlySet<string>,
  failedExchangeIds: ReadonlySet<string>,
): { successorAddedExchangeIds: ReadonlySet<string>; droppedWithoutSuccessor: number } {
  const visited = new Set<string>();
  const successorAddedExchangeIds = new Set<string>();

  // Depth-first over the successorExchangeId edges out of `exchangeId`'s OWN
  // reviewed-obsolete rows, in row order, backtracking to the next candidate
  // when a branch's entire reachable trail dead-ends. `visited` is the ONE
  // set shared across every call (every triggering exchange, every branch,
  // every depth) — see this function's own doc comment for why. D1: a
  // visited candidate already claimed as another chain's resolved successor
  // (`successorAddedExchangeIds`) resolves the CURRENT chain too; a visited
  // candidate NOT in `successorAddedExchangeIds` was only ever an exhausted,
  // unclaimed pass-through, and stays un-re-enterable exactly as before.
  function resolveFrom(exchangeId: string): string | undefined {
    for (const row of rowsByExchangeId.get(exchangeId) ?? []) {
      if (row.reviewedObsolete !== true || row.successorExchangeId === undefined) continue;
      const candidate = row.successorExchangeId;
      if (visited.has(candidate)) {
        if (successorAddedExchangeIds.has(candidate)) return candidate; // D1: share an already-claimed successor
        continue; // an exhausted, unclaimed pass-through -- never re-enter it
      }
      visited.add(candidate);
      const eligible = turnsByExchangeId.has(candidate) && !excludedExchangeIds.has(candidate) && !failedExchangeIds.has(candidate);
      if (eligible) return candidate;
      const deeper = resolveFrom(candidate); // pass-through: descend before trying the next candidate
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  }

  let droppedWithoutSuccessor = 0;
  for (const startId of triggeringExchangeIdsInOrder) {
    visited.add(startId); // an exchange can never chain back to its own start
    const resolved = resolveFrom(startId);
    // `Set.add` is idempotent: a candidate already claimed by an earlier
    // chain (D1) does not grow `successorAddedExchangeIds` a second time, so
    // the caller -- which iterates this Set to add turns -- still adds that
    // shared candidate's turns exactly once.
    if (resolved !== undefined) successorAddedExchangeIds.add(resolved);
    else droppedWithoutSuccessor++;
  }

  return { successorAddedExchangeIds, droppedWithoutSuccessor };
}

// ---------------------------------------------------------------------------
// Rescue (REQ-9) — feeds ProvenanceRecord.rescuedExchangeCount/rescuedTurnCount
// ---------------------------------------------------------------------------

/**
 * REQ-9: an in-window exchange the RAW BASE DECISION (`baseSelectedIndices`)
 * did not fully select is RESCUED — all of its turns are added — when:
 *   (a) it holds no DEAD fact (via {@link classifyFactRow}) — a MIXED
 *       exchange (some DEAD, some LIVE/INERT) is disqualified here even
 *       though REQ-7 alone would not exclude it: REQ-9(a) is "no DEAD fact
 *       anywhere", strictly stronger than REQ-7's "not EVERY fact DEAD";
 *   (b) at least one of its KEYED facts has `queryMatch = true` — a Todo or
 *       INERT fact is never KEYED ({@link classifyFactRow}), so a Todo-only
 *       or INERT-only exchange fails this condition with no separate
 *       carve-out needed — it falls straight out of the classifier;
 *   (c) every one of its KEYED facts is uncontested (`contestedFactIds`,
 *       REQ-6) — a single contested KEYED fact blocks the WHOLE exchange
 *       even when another of its facts independently matches.
 *
 * "The base did not fully select" is checked against `baseSelectedIndices`
 * (`base.selectedIndices`, `prune()`'s own output) — the same notion REQ-8's
 * own `wasBaseSelected` (in {@link classifyExcludedExchanges}) already uses
 * for its trigger condition — NOT the REQ-7/8-adjusted working selection the
 * caller builds afterward. One consequence, deliberate rather than
 * overlooked (see this file's tests, "counted under BOTH mechanisms"): an
 * exchange REQ-8 already added via successor transfer can ALSO independently
 * satisfy REQ-9 and be counted as rescued too — the two counts describe two
 * independent, non-exclusive facts about the exchange (was it a successor
 * target? does it separately meet the rescue conditions?), never a partition
 * of exchanges. The turn itself is still only ever added once to the actual
 * selection, since the caller merges every source into one `Set`.
 *
 * Rescue is evaluated per-exchange against that exchange's OWN fact rows
 * only — never against `history`'s ordering, another exchange's selection
 * state, or any decayed/normalized score — so it is inherently set-based:
 * nothing here ever adds a turn because it sits between two selected or
 * rescued exchanges.
 *
 * Candidates are `rowsByExchangeId`'s keys (in-window exchanges that hold
 * >=1 fact row — post-guard, every key is validated in-window, the same
 * assumption {@link classifyExcludedExchanges} already relies on), walked in
 * ascending first-window-turn-index order for determinism (the same
 * convention `triggeringExchangeIdsInOrder` uses). An exchange with no fact
 * row at all can never satisfy (b) either way, so restricting candidates to
 * exchanges that HAVE rows loses no eligible exchange. Rescue never chains
 * or hops between exchanges, so this order never changes WHICH exchanges are
 * rescued — only the (irrelevant) iteration order.
 */
function resolveRescue(
  rescueCandidateIdsInOrder: readonly string[],
  turnsByExchangeId: ReadonlyMap<string, number[]>,
  rowsByExchangeId: RowsByExchangeId,
  contestedFactIds: ReadonlySet<string>,
  baseSelectedIndices: readonly number[],
): ReadonlySet<string> {
  const baseSelectedSet = new Set(baseSelectedIndices);
  const rescuedExchangeIds = new Set<string>();
  for (const exchangeId of rescueCandidateIdsInOrder) {
    const turns = turnsByExchangeId.get(exchangeId) ?? [];
    if (turns.length > 0 && turns.every((index) => baseSelectedSet.has(index))) continue; // the base already fully selected this exchange -- nothing to rescue

    const classifiedRows = (rowsByExchangeId.get(exchangeId) ?? []).map((r) => ({ row: r, classified: classifyFactRow(r) }));
    const holdsNoDeadFact = classifiedRows.every(({ classified }) => classified.status !== "DEAD"); // REQ-9(a)
    const keyedRows = classifiedRows.filter(({ classified }) => classified.keyed).map(({ row }) => row);
    const hasQueryMatchedKeyedFact = keyedRows.some((r) => r.queryMatch === true); // REQ-9(b)
    const everyKeyedFactUncontested = keyedRows.every((r) => !contestedFactIds.has(r.factId)); // REQ-9(c)

    if (holdsNoDeadFact && hasQueryMatchedKeyedFact && everyKeyedFactUncontested) rescuedExchangeIds.add(exchangeId);
  }
  return rescuedExchangeIds;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Provenance-gated exchange selection over the unchanged KadaneDial base
 * decision. See the file header for the full contract: the fail-closed
 * guards, classification, the contest count, REQ-7 exclusion, REQ-8
 * successor transfer, REQ-9 rescue and REQ-10 completion are all real — see
 * the header's "T2"/"T4"/"T5"/"T6 implements" sections for exactly what
 * each covers.
 *
 * @param queryEmbedding - identical to `prune()`'s.
 * @param history - identical to `prune()`'s `HistoryEmbedding[]`, plus each
 *   turn's optional trusted `exchangeId`.
 * @param params - identical to `prune()`'s.
 * @param queryScopeId - identical to `prune()`'s; applied first (REQ-4), so
 *   "in-window" below always means AFTER this scope filter.
 * @param snapshot - the injected REQ-12 lookup result + write-settlement
 *   signal. Omitted (or explicitly `undefined`) models NO_SNAPSHOT.
 * @returns the base {@link PruneDecision} with REQ-7/8/9/10 already applied
 *   (unchanged when none of exclusion, successor transfer, rescue or
 *   completion fired), plus a {@link ProvenanceRecord}. Every REQ-2 guard
 *   failure returns the untouched base decision exactly.
 */
export function selectWithProvenance(
  queryEmbedding: Float32Array,
  history: ProvenanceHistoryTurn[],
  params: KadaneDialParams,
  queryScopeId?: string,
  snapshot?: ProvenanceSnapshot,
): ProvenanceDecision {
  const base = prune(queryEmbedding, history, params, queryScopeId);

  // "Window" (Definitions): the in-scope history candidates after prune()'s
  // OWN REQ-4 scope filter — reuse its already-computed candidateIndices
  // rather than re-deriving the scopeId comparison here.
  const windowIndices = queryScopeId !== undefined ? (base.candidateIndices ?? []) : history.map((_, i) => i);
  const windowExchangeIds = new Set<string>();
  const turnsByExchangeId = new Map<string, number[]>();
  for (const i of windowIndices) {
    const exchangeId = history[i]?.exchangeId;
    if (!exchangeId) continue;
    windowExchangeIds.add(exchangeId);
    const bucket = turnsByExchangeId.get(exchangeId);
    if (bucket) bucket.push(i);
    else turnsByExchangeId.set(exchangeId, [i]);
  }

  const reason = checkGuards(windowExchangeIds, snapshot);

  // REQ-6/7/8/9/10: computed only once every guard has passed. A guard
  // failure returns the base decision exactly (REQ-2), so every count below
  // (including `completedTurnCount`) stays 0 — never computed from an
  // unvalidated (possibly malformed) snapshot.
  let contestedFactCount = 0;
  let excludedExchangeCount = 0;
  let excludedTurnCount = 0;
  let successorAddedCount = 0;
  let droppedWithoutSuccessor = 0;
  let rescuedExchangeCount = 0;
  let rescuedTurnCount = 0;
  let completedTurnCount = 0;
  let selectedIndices = base.selectedIndices;
  let prunedIndices = base.prunedIndices;
  let spans = base.spans;

  if (reason === null && snapshot !== undefined && snapshot.lookup.kind === "ok") {
    const rows = snapshot.lookup.rows;
    const contestedFactIds = computeContestedFactIds(rows);
    contestedFactCount = contestedFactIds.size;

    const rowsByExchangeId = groupRowsByExchangeId(rows);
    const { excludedExchangeIds, triggeringExchangeIds } = classifyExcludedExchanges(rowsByExchangeId, turnsByExchangeId, base.selectedIndices);
    // turnsByExchangeId's keys were inserted in ascending window-turn order,
    // so filtering them gives a deterministic ascending-by-first-occurrence
    // processing order for the shared visited-set walk below.
    const triggeringExchangeIdsInOrder = [...turnsByExchangeId.keys()].filter((id) => triggeringExchangeIds.has(id));
    const { successorAddedExchangeIds, droppedWithoutSuccessor: dropped } = resolveSuccessorTransfers(
      triggeringExchangeIdsInOrder,
      turnsByExchangeId,
      rowsByExchangeId,
      excludedExchangeIds,
      snapshot.failedExchangeIds,
    );

    excludedExchangeCount = excludedExchangeIds.size;
    for (const exchangeId of excludedExchangeIds) excludedTurnCount += (turnsByExchangeId.get(exchangeId) ?? []).length;
    successorAddedCount = successorAddedExchangeIds.size;
    droppedWithoutSuccessor = dropped;

    // REQ-9 rescue: candidates are in-window exchanges holding >=1 fact row
    // (rowsByExchangeId's keys), in the same deterministic ascending order
    // used above for successor transfer. See `resolveRescue`'s own doc
    // comment for exactly what "the base did not fully select" is checked
    // against, and why.
    const rescueCandidateIdsInOrder = [...turnsByExchangeId.keys()].filter((id) => rowsByExchangeId.has(id));
    const rescuedExchangeIds = resolveRescue(rescueCandidateIdsInOrder, turnsByExchangeId, rowsByExchangeId, contestedFactIds, base.selectedIndices);
    rescuedExchangeCount = rescuedExchangeIds.size;
    for (const exchangeId of rescuedExchangeIds) rescuedTurnCount += (turnsByExchangeId.get(exchangeId) ?? []).length;

    // Merge every source into ONE working set: base minus REQ-7 exclusions,
    // plus REQ-8's successor turns, plus REQ-9's rescued turns. REQ-10
    // completion (below) reads and extends this SAME set, so a turn a
    // successor transfer or rescue already added is never double-added or
    // double-counted by completion.
    const working = new Set(base.selectedIndices);
    for (const exchangeId of excludedExchangeIds) {
      for (const index of turnsByExchangeId.get(exchangeId) ?? []) working.delete(index);
    }
    for (const exchangeId of successorAddedExchangeIds) {
      for (const index of turnsByExchangeId.get(exchangeId) ?? []) working.add(index);
    }
    for (const exchangeId of rescuedExchangeIds) {
      for (const index of turnsByExchangeId.get(exchangeId) ?? []) working.add(index);
    }

    // REQ-10 completion: walk EVERY trusted, in-window exchange —
    // `turnsByExchangeId`'s own keys, not `rowsByExchangeId`'s, so an
    // exchange with ZERO fact rows is still eligible (the fixture's
    // `partner_completion` family carries no rows at all and completes on
    // that basis alone). Skip an excluded exchange outright: REQ-10's own
    // stated exception is that once REQ-7 removes it, it stays removed. For
    // every other exchange, if the merged selection above already holds
    // SOME but not ALL of its in-window turns, add the rest. REQ-8/REQ-9
    // already add every turn of whatever they touch, so by the time this
    // runs, the only exchanges left partially selected are ones the base
    // alone picked part of and that neither mechanism completed — exactly
    // REQ-10's remaining case.
    //
    // `completedTurnCount` counts only the turns THIS step newly flips from
    // unselected to selected — the turns it fills in — not every turn of a
    // completed exchange. That deliberately differs from `excludedTurnCount`/
    // `rescuedTurnCount`'s "every turn of the affected exchange" convention:
    // exclusion and rescue are whole-exchange yes/no decisions, so counting
    // every turn describes the decision itself. Completion instead patches a
    // gap in an already-partial selection, so its natural unit is the turn
    // it adds, not the exchange the turn happens to belong to.
    for (const [exchangeId, indices] of turnsByExchangeId) {
      // REQ-10's own stated exception, made explicit rather than left as an
      // emergent property: an excluded exchange always has >=1 DEAD fact
      // (REQ-7's own definition), which always fails REQ-9(a)'s "no DEAD
      // fact anywhere", and it can never be a successor-transfer TARGET
      // either (eligibility there requires `!excludedExchangeIds.has`) — so
      // `selectedCount` below is already provably 0 for it by the time this
      // runs, and `continue` here never changes behavior today. It stays as
      // a defensive, self-documenting guard: it is what protects this
      // exception if a future change to REQ-8/REQ-9's own eligibility rules
      // ever breaks that invariant.
      if (excludedExchangeIds.has(exchangeId)) continue;
      const selectedCount = indices.reduce((count, index) => count + (working.has(index) ? 1 : 0), 0);
      if (selectedCount === 0 || selectedCount === indices.length) continue; // nothing to complete
      for (const index of indices) {
        if (!working.has(index)) {
          working.add(index);
          completedTurnCount++;
        }
      }
    }

    // Recompute the output whenever exclusion, successor transfer, rescue or
    // completion actually changed something — otherwise selectedIndices/
    // prunedIndices/spans stay the base's own values, exactly as REQ-1
    // requires whenever nothing provenance-driven applies.
    if (excludedExchangeIds.size > 0 || successorAddedExchangeIds.size > 0 || rescuedExchangeIds.size > 0 || completedTurnCount > 0) {
      selectedIndices = [...working].sort((a, b) => a - b);
      const selectedSet = new Set(selectedIndices);
      prunedIndices = history.map((_, index) => index).filter((index) => !selectedSet.has(index));
      // Maximal runs of consecutive indices — reimplemented inline here
      // (rather than imported from pruner.ts, which stays byte-identical
      // this cycle): the same recomputation prune() itself already does for
      // a scoped decision (REQ-11).
      const recomputedSpans: Array<[number, number]> = [];
      for (const index of selectedIndices) {
        const last = recomputedSpans[recomputedSpans.length - 1];
        if (last && last[1] === index - 1) last[1] = index;
        else recomputedSpans.push([index, index]);
      }
      spans = recomputedSpans;
    }
  }

  const provenance: ProvenanceRecord = {
    applied: reason === null,
    reason,
    baseSelectedIndices: [...base.selectedIndices],
    rescuedExchangeCount,
    rescuedTurnCount,
    excludedExchangeCount,
    excludedTurnCount,
    successorAddedCount,
    droppedWithoutSuccessor,
    completedTurnCount,
    contestedFactCount,
    lambda: params.lambda,
    gainShift: params.gainShift,
    theta: params.theta,
  };
  return { ...base, spans, selectedIndices, prunedIndices, provenance };
}
