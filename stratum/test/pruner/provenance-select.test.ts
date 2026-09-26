// T2+T3+T4+T5+T6 of specs/pruner/provenance-gated-selection.md (ADR-0023):
// red-first unit tests for ONLY the things these tasks implement --
//   (a) the five REQ-2 fail-closed guards on `selectWithProvenance` (T2);
//   (b) `classifyFactRow`'s REQ-5 DEAD/LIVE/INERT + REQ-6 KEYED
//       classification (T2);
//   (c) REQ-6's contest rule, feeding `provenance.contestedFactCount` (T3);
//   (d) REQ-7 exclusion (an all-DEAD in-window exchange loses every one of
//       its turns, including any base-carried one; a mixed, INERT-only or
//       fact-less exchange is never excluded) and REQ-8 successor transfer
//       (a base-selected or DEAD+queryMatch excluded exchange follows
//       `successorExchangeId` to the first in-window/non-excluded/
//       no-failed-write exchange over a shared visited set, or else counts
//       `droppedWithoutSuccessor`) (T4);
//   (e) REQ-9 set-based rescue: an in-window exchange the base did not fully
//       select is added WHOLE when it holds no DEAD fact, at least one KEYED
//       fact matches the query, and every KEYED fact is uncontested. A
//       Todo-only or INERT-only exchange can never qualify (neither table is
//       ever KEYED), a single contested KEYED fact blocks the WHOLE exchange,
//       and nothing is ever added merely for sitting between two rescued
//       exchanges (T5);
//   (f) REQ-10 completion: once any turn of a trusted, non-excluded exchange
//       is in the merged selection, every other in-window turn of that
//       exchange is added too -- including an exchange with NO fact row at
//       all, which REQ-7/8/9 never touch either way. An excluded exchange is
//       the one documented exception: it never comes back.
//       `provenance.completedTurnCount` counts only the turns completion
//       itself newly selects, not every turn of the completed exchange (T6);
//   (g) a REQ-1 property test over randomized scoped/unscoped histories,
//       with a fixed clock and a small inline seeded PRNG, confirming
//       `selectWithProvenance` deep-equals `prune()` on
//       spans/selectedIndices/prunedIndices/candidateIndices/decayedScores/
//       normalizedScores/params whenever no snapshot is supplied or no
//       window turn carries an exchangeId (T6).
//
// Hand-written stub inputs only (per the task: "no fixture dependency") --
// nothing here reads evals/datasets/provenance/.

import { describe, test, expect } from "vitest";
import { prune } from "../../src/pruner/pruner";
import { DEFAULT_KADANEDIAL, type KadaneDialParams } from "../../src/pruner/kadanedial";
import { selectWithProvenance, classifyFactRow, KNOWN_FACT_TABLES, type ProvenanceHistoryTurn, type ProvenanceFactRow, type ProvenanceSnapshot } from "../../src/pruner/provenance-select";
import { FACT_TABLES } from "../../src/memory/warm/tier2";

const NOW = 1_000_000;
const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

const params = (over: Partial<KadaneDialParams> = {}): KadaneDialParams => ({
  lambda: DEFAULT_KADANEDIAL.lambda,
  gainShift: DEFAULT_KADANEDIAL.gainShift,
  theta: DEFAULT_KADANEDIAL.theta,
  nowSeconds: NOW,
  ...over,
});

const turn = (over: Partial<ProvenanceHistoryTurn> = {}): ProvenanceHistoryTurn => ({
  embedding: v(1, 0),
  timestampSeconds: NOW,
  ...over,
});

const row = (over: Partial<ProvenanceFactRow> = {}): ProvenanceFactRow => ({
  exchangeId: "exch-1",
  factTable: "tech_decisions",
  factId: "fact-1",
  keyHashes: [],
  active: true,
  reviewedObsolete: false,
  auditStatus: null,
  queryMatch: false,
  ...over,
});

const okSnapshot = (rows: ProvenanceFactRow[] = [], failed: string[] = []): ProvenanceSnapshot => ({
  lookup: { kind: "ok", rows },
  failedExchangeIds: new Set(failed),
});

/** `selectWithProvenance` with a fixed query embedding + dial, reordered so tests read `(history, snapshot, scopeId?)`. */
function run(history: ProvenanceHistoryTurn[], snapshot?: ProvenanceSnapshot, scopeId?: string) {
  return selectWithProvenance(v(1, 0), history, params(), scopeId, snapshot);
}

describe("classifyFactRow — DEAD/LIVE/INERT + KEYED (REQ-5, REQ-6)", () => {
  test("DEAD: reviewedObsolete=true, active=true", () => {
    expect(classifyFactRow(row({ reviewedObsolete: true, active: true })).status).toBe("DEAD");
  });

  test("DEAD: reviewedObsolete=true even when active=false (suppressed) -- DEAD is checked regardless of active/suppressed state", () => {
    expect(classifyFactRow(row({ reviewedObsolete: true, active: false })).status).toBe("DEAD");
  });

  test("DEAD: auditStatus=CONFLICT, active=true", () => {
    expect(classifyFactRow(row({ auditStatus: "CONFLICT", active: true })).status).toBe("DEAD");
  });

  test("DEAD: auditStatus=CONFLICT even when active=false", () => {
    expect(classifyFactRow(row({ auditStatus: "CONFLICT", active: false })).status).toBe("DEAD");
  });

  test("LIVE: active=true, not DEAD, no key hashes -- not KEYED", () => {
    const c = classifyFactRow(row({ active: true, keyHashes: [] }));
    expect(c.status).toBe("LIVE");
    expect(c.keyed).toBe(false);
  });

  test("LIVE + KEYED: active=true, not DEAD, >=1 key hash", () => {
    const c = classifyFactRow(row({ active: true, factTable: "variable_changes", keyHashes: ["abc123"] }));
    expect(c.status).toBe("LIVE");
    expect(c.keyed).toBe(true);
  });

  test("INERT: active=false (suppressed), not DEAD", () => {
    const c = classifyFactRow(row({ active: false, reviewedObsolete: false, auditStatus: "UNVERIFIED" }));
    expect(c.status).toBe("INERT");
    expect(c.keyed).toBe(false);
  });

  test("INERT is never KEYED even when key hashes are present", () => {
    const c = classifyFactRow(row({ active: false, factTable: "policy_updates", keyHashes: ["deadbeef"] }));
    expect(c.status).toBe("INERT");
    expect(c.keyed).toBe(false);
  });

  test("Todo is never KEYED, even (defensively) if keyHashes is non-empty", () => {
    const c = classifyFactRow(row({ active: true, factTable: "todos", keyHashes: ["should-never-be-populated"] }));
    expect(c.status).toBe("LIVE");
    expect(c.keyed).toBe(false);
  });

  test("an unreviewed model-extracted signal alone never makes a row DEAD by itself", () => {
    // The evidence a naive implementation might be tempted to treat as
    // "obsolete" -- a bare FunctionChange rename pair (old+new-name key
    // hashes), an unreviewed Tier-3 SUPERSEDES edge, or a fact's own
    // is_verified -- is exactly REQ-5's forbidden shortcut. This row type
    // has no field for any of those raw signals (see the source header), so
    // the only way to demonstrate the rule at this boundary is: with
    // reviewedObsolete left at its honest `false` and auditStatus never
    // CONFLICT, the row stays LIVE (+KEYED) no matter which audit state
    // (none/unreviewed/confirmed-by-git) accompanies it.
    for (const auditStatus of [null, "UNVERIFIED", "CONFIRMED"] as const) {
      const c = classifyFactRow(
        row({
          factTable: "function_changes",
          keyHashes: ["old-name-hash", "new-name-hash"], // a bare rename pair
          reviewedObsolete: false,
          auditStatus,
          active: true,
        }),
      );
      expect(c.status).toBe("LIVE");
      expect(c.keyed).toBe(true);
    }
  });
});

describe("selectWithProvenance — fail-closed guards (REQ-2)", () => {
  test("NO_SNAPSHOT: no snapshot supplied at all", () => {
    const d = run([turn({ exchangeId: "e1" })], undefined);
    expect(d.provenance.reason).toBe("NO_SNAPSHOT");
    expect(d.provenance.applied).toBe(false);
  });

  test("NO_SNAPSHOT takes precedence when no snapshot is supplied AND no turn carries an exchangeId either", () => {
    const d = run([turn({})], undefined);
    expect(d.provenance.reason).toBe("NO_SNAPSHOT");
  });

  test("NO_EXCHANGE_IDS: a snapshot is supplied but no window turn carries an exchangeId", () => {
    const d = run([turn({}), turn({})], okSnapshot());
    expect(d.provenance.reason).toBe("NO_EXCHANGE_IDS");
    expect(d.provenance.applied).toBe(false);
  });

  test("NO_EXCHANGE_IDS: the only exchangeId in history belongs to an out-of-scope turn", () => {
    const history = [
      turn({ exchangeId: "e1", scopeId: "other-scope" }), // has an id, but wrong scope
      turn({ scopeId: "target" }), // in scope, but no exchangeId
    ];
    const d = run(history, okSnapshot(), "target");
    expect(d.provenance.reason).toBe("NO_EXCHANGE_IDS");
  });

  test("WRITE_FAILED: an in-window exchange's write is not ok", () => {
    const d = run([turn({ exchangeId: "e1" })], okSnapshot([], ["e1"]));
    expect(d.provenance.reason).toBe("WRITE_FAILED");
    expect(d.provenance.applied).toBe(false);
  });

  test("WRITE_FAILED does not trigger on a failed exchangeId belonging to an out-of-scope turn", () => {
    const history = [turn({ exchangeId: "failed-elsewhere", scopeId: "other-scope" }), turn({ exchangeId: "e1", scopeId: "target" })];
    const snapshot = okSnapshot([row({ exchangeId: "e1" })], ["failed-elsewhere"]);
    const d = run(history, snapshot, "target");
    expect(d.provenance.reason).toBeNull();
  });

  test("LOOKUP_ERROR: the lookup itself rejected", () => {
    const snapshot: ProvenanceSnapshot = { lookup: { kind: "error", cause: "reject" }, failedExchangeIds: new Set() };
    const d = run([turn({ exchangeId: "e1" })], snapshot);
    expect(d.provenance.reason).toBe("LOOKUP_ERROR");
    expect(d.provenance.applied).toBe(false);
  });

  test("LOOKUP_ERROR: the lookup itself timed out", () => {
    const snapshot: ProvenanceSnapshot = { lookup: { kind: "error", cause: "timeout" }, failedExchangeIds: new Set() };
    const d = run([turn({ exchangeId: "e1" })], snapshot);
    expect(d.provenance.reason).toBe("LOOKUP_ERROR");
  });

  test("WRITE_FAILED takes precedence over a simultaneous LOOKUP_ERROR (REQ-13: the observer never calls the lookup while a write is unsettled)", () => {
    const snapshot: ProvenanceSnapshot = { lookup: { kind: "error", cause: "reject" }, failedExchangeIds: new Set(["e1"]) };
    const d = run([turn({ exchangeId: "e1" })], snapshot);
    expect(d.provenance.reason).toBe("WRITE_FAILED");
  });

  describe("LOOKUP_INVALID (REQ-2)", () => {
    test("a row's exchangeId is outside the caller's in-window set (foreign)", () => {
      const d = run([turn({ exchangeId: "e1" })], okSnapshot([row({ exchangeId: "foreign-exchange" })]));
      expect(d.provenance.reason).toBe("LOOKUP_INVALID");
      expect(d.provenance.applied).toBe(false);
    });

    test("a row naming an out-of-scope turn's exchangeId is still foreign to the in-window set", () => {
      const history = [turn({ exchangeId: "out-of-scope-id", scopeId: "other-scope" }), turn({ exchangeId: "e1", scopeId: "target" })];
      const snapshot = okSnapshot([row({ exchangeId: "out-of-scope-id" })]);
      const d = run(history, snapshot, "target");
      expect(d.provenance.reason).toBe("LOOKUP_INVALID");
    });

    test("a repeated factId (across different exchanges)", () => {
      const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
      const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "dup" }), row({ exchangeId: "e2", factId: "dup" })]);
      const d = run(history, snapshot);
      expect(d.provenance.reason).toBe("LOOKUP_INVALID");
    });

    test("an otherwise malformed row (wrong runtime type, deliberately bypassing the compiler)", () => {
      const malformed = { ...row({ exchangeId: "e1" }), active: "yes" } as unknown as ProvenanceFactRow;
      const d = run([turn({ exchangeId: "e1" })], okSnapshot([malformed]));
      expect(d.provenance.reason).toBe("LOOKUP_INVALID");
    });
  });

  test("guards pass: valid snapshot, well-formed in-window row -> reason is null, applied is true, decision is (still, this task) the unchanged base", () => {
    const history = [turn({ exchangeId: "e1" })];
    const snapshot = okSnapshot([row({ exchangeId: "e1" })]);
    const base = prune(v(1, 0), history, params());
    const d = run(history, snapshot);
    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.applied).toBe(true);
    expect(d.spans).toEqual(base.spans);
    expect(d.selectedIndices).toEqual(base.selectedIndices);
    expect(d.prunedIndices).toEqual(base.prunedIndices);
  });

  test("guards pass with an empty rows array (G3's completion-only shape has no fact rows at all)", () => {
    const d = run([turn({ exchangeId: "e1" })], okSnapshot([]));
    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.applied).toBe(true);
  });
});

describe("selectWithProvenance — contest (REQ-6)", () => {
  // NOTE: `row()`'s defaults are `factTable: "tech_decisions"`,
  // `queryMatch: false`, `keyHashes: []` -- a contest case that forgets to
  // override factTable/keyHashes is silently non-KEYED (or TD-gated off).
  // Non-TechDecision cases below explicitly pick a different factTable.

  test("same factTable + shared key hash, different exchanges: both facts contested", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-x"] }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-x"] }),
    ]);
    const d = run(history, snapshot);
    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.contestedFactCount).toBe(2);
  });

  test("tech_decisions: shared domain hash contests when BOTH facts have queryMatch=true", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", keyHashes: ["domain-x"], queryMatch: true }),
      row({ exchangeId: "e2", factId: "f2", keyHashes: ["domain-x"], queryMatch: true }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(2);
  });

  test("tech_decisions: one fact with queryMatch=false does not contest (query-dependent gate)", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", keyHashes: ["domain-x"], queryMatch: true }),
      row({ exchangeId: "e2", factId: "f2", keyHashes: ["domain-x"], queryMatch: false }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("tech_decisions: both facts with queryMatch=false do not contest", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", keyHashes: ["domain-x"], queryMatch: false }),
      row({ exchangeId: "e2", factId: "f2", keyHashes: ["domain-x"], queryMatch: false }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("a CONFIRMED-vs-UNVERIFIED pair still contests -- auditStatus never resolves a contest", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "policy_updates", keyHashes: ["policy-x"], auditStatus: "CONFIRMED" }),
      row({ exchangeId: "e2", factId: "f2", factTable: "policy_updates", keyHashes: ["policy-x"], auditStatus: "UNVERIFIED" }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(2);
  });

  test("a CONFIRMED-vs-null pair still contests", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "policy_updates", keyHashes: ["policy-y"], auditStatus: "CONFIRMED" }),
      row({ exchangeId: "e2", factId: "f2", factTable: "policy_updates", keyHashes: ["policy-y"], auditStatus: null }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(2);
  });

  test("different turn timestamps and embeddings never resolve a contest -- recency/similarity are never read", () => {
    const history = [turn({ exchangeId: "e1", timestampSeconds: NOW - 5000, embedding: v(1, 0) }), turn({ exchangeId: "e2", timestampSeconds: NOW, embedding: v(0, 1) })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "operational_references", keyHashes: ["subject-x"] }),
      row({ exchangeId: "e2", factId: "f2", factTable: "operational_references", keyHashes: ["subject-x"] }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(2);
  });

  test("two facts in the SAME exchange sharing a key hash never contest", () => {
    const history = [turn({ exchangeId: "e1" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-x"] }),
      row({ exchangeId: "e1", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-x"] }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("identical hash string in a DIFFERENT factTable does not contest", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["shared-hash"] }),
      row({ exchangeId: "e2", factId: "f2", factTable: "policy_updates", keyHashes: ["shared-hash"] }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("a DEAD partner sharing a key hash does not contest -- both facts must be LIVE+KEYED", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-dead"], active: true }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-dead"], reviewedObsolete: true }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("an INERT partner sharing a key hash does not contest", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-inert"], active: true }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-inert"], active: false }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(0);
  });

  test("three LIVE+KEYED facts across three exchanges sharing one hash: all three contested, counted once each", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" }), turn({ exchangeId: "e3" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-z"] }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-z"] }),
      row({ exchangeId: "e3", factId: "f3", factTable: "variable_changes", keyHashes: ["hash-z"] }),
      row({ exchangeId: "e3", factId: "f4", factTable: "variable_changes", keyHashes: ["unrelated-hash"] }),
    ]);
    expect(run(history, snapshot).provenance.contestedFactCount).toBe(3);
  });

  test("contestedFactCount stays 0 when a guard fails, even if the invalid snapshot's rows would otherwise contest", () => {
    const history = [turn({ exchangeId: "e1" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-w"] }),
      row({ exchangeId: "foreign-exchange", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-w"] }),
    ]);
    const d = run(history, snapshot);
    expect(d.provenance.reason).toBe("LOOKUP_INVALID");
    expect(d.provenance.contestedFactCount).toBe(0);
  });

  test("a contest changes only contestedFactCount -- selectedIndices/prunedIndices/spans stay identical to the base decision", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e2" })];
    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", keyHashes: ["hash-v"] }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", keyHashes: ["hash-v"] }),
    ]);
    const base = prune(v(1, 0), history, params());
    const d = run(history, snapshot);
    expect(d.provenance.contestedFactCount).toBe(2);
    expect(d.selectedIndices).toEqual(base.selectedIndices);
    expect(d.prunedIndices).toEqual(base.prunedIndices);
    expect(d.spans).toEqual(base.spans);
  });
});

describe("selectWithProvenance — exclusion (REQ-7)", () => {
  test("an all-DEAD exchange is excluded, removing a turn the base decision carried", () => {
    const history = [turn({ exchangeId: "e1" })]; // matches the query embedding exactly -> base-selects it
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity: the base decision DOES carry this turn

    // DEAD via auditStatus=CONFLICT only (reviewedObsolete left false), so it
    // carries no successorExchangeId -- also exercises the "no successor at
    // all" arm of REQ-8 for this same (base-selected -> triggering) exchange.
    const snapshot = okSnapshot([row({ exchangeId: "e1", auditStatus: "CONFLICT" })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.selectedIndices).toEqual([]);
    expect(d.prunedIndices).toEqual([0]);
    expect(d.spans).toEqual([]);
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.excludedTurnCount).toBe(1);
    expect(d.provenance.successorAddedCount).toBe(0);
    expect(d.provenance.droppedWithoutSuccessor).toBe(1);
  });

  describe("mixed / INERT / fact-less exchanges are protected (never excluded)", () => {
    test("a mixed exchange (one DEAD + one LIVE fact) is not excluded", () => {
      const history = [turn({ exchangeId: "e1" })];
      const base = prune(v(1, 0), history, params());
      const snapshot = okSnapshot([
        row({ exchangeId: "e1", factId: "f1", auditStatus: "CONFLICT" }), // DEAD
        row({ exchangeId: "e1", factId: "f2", factTable: "variable_changes", active: true }), // LIVE
      ]);
      const d = run(history, snapshot);
      expect(d.provenance.reason).toBeNull();
      expect(d.provenance.excludedExchangeCount).toBe(0);
      expect(d.selectedIndices).toEqual(base.selectedIndices);
    });

    test("an INERT-only exchange is not excluded", () => {
      const history = [turn({ exchangeId: "e1" })];
      const base = prune(v(1, 0), history, params());
      const snapshot = okSnapshot([row({ exchangeId: "e1", active: false, reviewedObsolete: false, auditStatus: "UNVERIFIED" })]);
      const d = run(history, snapshot);
      expect(d.provenance.excludedExchangeCount).toBe(0);
      expect(d.selectedIndices).toEqual(base.selectedIndices);
    });

    test("a fact-less exchange (no rows at all) is not excluded", () => {
      const history = [turn({ exchangeId: "e1" })];
      const base = prune(v(1, 0), history, params());
      const d = run(history, okSnapshot([]));
      expect(d.provenance.excludedExchangeCount).toBe(0);
      expect(d.selectedIndices).toEqual(base.selectedIndices);
    });
  });

  test("an excluded exchange that is neither base-selected nor DEAD+queryMatch is still excluded, but never attempts successor resolution", () => {
    // Two turns so the all-DEAD exchange (e1) need not be the one the base
    // selects; e1's orthogonal embedding keeps it out of the base selection.
    const history = [turn({ exchangeId: "e1", embedding: v(0, 1) }), turn({ exchangeId: "e2", embedding: v(1, 0) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).not.toContain(0); // sanity: e1's turn is not base-selected

    const snapshot = okSnapshot([row({ exchangeId: "e1", auditStatus: "CONFLICT", queryMatch: false })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1); // still excluded...
    expect(d.provenance.successorAddedCount).toBe(0);
    expect(d.provenance.droppedWithoutSuccessor).toBe(0); // ...but never a REQ-8 trigger
    expect(d.selectedIndices).toEqual(base.selectedIndices);
  });
});

describe("selectWithProvenance — successor transfer (REQ-8)", () => {
  test("a 2-hop successor chain (A -> B -> C) resolves via the shared visited set", () => {
    const history = [turn({ exchangeId: "A", embedding: v(0, 1) }), turn({ exchangeId: "B", embedding: v(0, 1) }), turn({ exchangeId: "C", embedding: v(0, 1) })];
    const snapshot = okSnapshot([
      // A: all-DEAD, queryMatch=true -> excluded AND a REQ-8 trigger; hops to B.
      row({ exchangeId: "A", factId: "a1", reviewedObsolete: true, successorExchangeId: "B", queryMatch: true }),
      // B: all-DEAD too (a pass-through -- not itself base-selected or queryMatch) -> hops to C.
      row({ exchangeId: "B", factId: "b1", reviewedObsolete: true, successorExchangeId: "C", queryMatch: false }),
      // C: LIVE -> not excluded -> the first eligible stop.
      row({ exchangeId: "C", factId: "c1", active: true, factTable: "variable_changes" }),
    ]);

    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(2); // A and B
    expect(d.provenance.excludedTurnCount).toBe(2);
    expect(d.provenance.successorAddedCount).toBe(1); // one trigger (A) resolved
    expect(d.provenance.droppedWithoutSuccessor).toBe(0);
    expect(d.selectedIndices).toEqual([2]); // only C's turn survives
    expect(d.prunedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual([[2, 2]]);
  });

  test("a dead-end first branch backtracks to a second reviewed-obsolete fact's successor (REQ-8 'each')", () => {
    // A holds TWO reviewed-obsolete facts: a1 -> B (a dead end: B is
    // all-DEAD with no successor of its own) and a2 -> C (LIVE, eligible).
    // Only trying A's FIRST candidate would wrongly drop this exchange.
    const history = [turn({ exchangeId: "A", embedding: v(0, 1) }), turn({ exchangeId: "B", embedding: v(0, 1) }), turn({ exchangeId: "C", embedding: v(0, 1) })];
    const snapshot = okSnapshot([
      row({ exchangeId: "A", factId: "a1", reviewedObsolete: true, successorExchangeId: "B", queryMatch: true }),
      row({ exchangeId: "A", factId: "a2", reviewedObsolete: true, successorExchangeId: "C", queryMatch: true }),
      // B: all-DEAD via CONFLICT (not reviewedObsolete) -- a dead end, no successor to follow.
      row({ exchangeId: "B", factId: "b1", auditStatus: "CONFLICT" }),
      // C: LIVE -> not excluded -> the eligible stop reachable only via A's SECOND fact.
      row({ exchangeId: "C", factId: "c1", active: true, factTable: "variable_changes" }),
    ]);

    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(2); // A and B
    expect(d.provenance.successorAddedCount).toBe(1);
    expect(d.provenance.droppedWithoutSuccessor).toBe(0);
    expect(d.selectedIndices).toEqual([2]); // only C's turn survives
  });

  test("a cycle (A -> B -> A) terminates via the visited set instead of looping forever", () => {
    const history = [turn({ exchangeId: "A", embedding: v(0, 1) }), turn({ exchangeId: "B", embedding: v(0, 1) })];
    const snapshot = okSnapshot([
      row({ exchangeId: "A", factId: "a1", reviewedObsolete: true, successorExchangeId: "B", queryMatch: true }),
      row({ exchangeId: "B", factId: "b1", reviewedObsolete: true, successorExchangeId: "A", queryMatch: false }),
    ]);

    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(2);
    expect(d.provenance.successorAddedCount).toBe(0);
    expect(d.provenance.droppedWithoutSuccessor).toBe(1); // only A triggers; the cycle dies, it does not loop
    expect(d.selectedIndices).toEqual([]);
  });

  test("two independent triggering exchanges whose successors converge DIRECTLY on one eligible exchange both resolve to it (D1: a shared successor is legitimately live and reachable, not dropped)", () => {
    // D and E each point straight at F -- neither chains through the other
    // (contrast the "chain can pass through ANOTHER triggering exchange"
    // test below, which collides via a hop through a second triggering
    // exchange). This isolates the direct-convergence shape D1 fixes: the
    // ONE shared `visited` set must not treat F as exhausted for E's search
    // merely because D's search already claimed it -- F is genuinely live
    // and reachable from both, so both resolve to it.
    const history = [turn({ exchangeId: "D", embedding: v(0, 1) }), turn({ exchangeId: "E", embedding: v(0, 1) }), turn({ exchangeId: "F", embedding: v(0, 1) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: nothing base-selected -- both D and E trigger via DEAD+queryMatch, not base selection

    const snapshot = okSnapshot([
      row({ exchangeId: "D", factId: "d1", reviewedObsolete: true, successorExchangeId: "F", queryMatch: true }),
      row({ exchangeId: "E", factId: "e1", reviewedObsolete: true, successorExchangeId: "F", queryMatch: true }),
      row({ exchangeId: "F", factId: "f1", active: true, factTable: "variable_changes" }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(2); // D and E
    expect(d.provenance.excludedTurnCount).toBe(2);
    expect(d.provenance.successorAddedCount).toBe(1); // F -- the one DISTINCT successor exchange added, claimed by both D and E
    expect(d.provenance.droppedWithoutSuccessor).toBe(0); // BOTH D and E resolve to F -- neither is dropped
    expect(d.selectedIndices).toEqual([2]); // F's turn added exactly once, never duplicated
    expect(d.prunedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual([[2, 2]]);
  });

  describe("droppedWithoutSuccessor", () => {
    test("increments when the successor is foreign -- it never appears anywhere in history", () => {
      const history = [turn({ exchangeId: "A" })];
      const snapshot = okSnapshot([row({ exchangeId: "A", reviewedObsolete: true, successorExchangeId: "nowhere", queryMatch: true })]);
      const d = run(history, snapshot);
      expect(d.provenance.reason).toBeNull();
      expect(d.provenance.excludedExchangeCount).toBe(1);
      expect(d.provenance.successorAddedCount).toBe(0);
      expect(d.provenance.droppedWithoutSuccessor).toBe(1);
      expect(d.selectedIndices).toEqual([]);
    });

    test("increments when the successor exists in history but is scoped outside the window", () => {
      const history = [turn({ exchangeId: "A", scopeId: "target" }), turn({ exchangeId: "outside", scopeId: "other-scope" })];
      const snapshot = okSnapshot([row({ exchangeId: "A", reviewedObsolete: true, successorExchangeId: "outside", queryMatch: true })]);
      const d = run(history, snapshot, "target");
      expect(d.provenance.reason).toBeNull();
      expect(d.provenance.excludedExchangeCount).toBe(1);
      expect(d.provenance.successorAddedCount).toBe(0);
      expect(d.provenance.droppedWithoutSuccessor).toBe(1);
      expect(d.selectedIndices).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Independent tester-added coverage (T4 tester-role verification pass).
// The three describe blocks above (T2/T3/T4's own tests) all use single-turn
// exchanges, so no existing test exercises REQ-7's "ALL of that exchange's
// turns" or REQ-8's "ALL of s's turns" against an exchange with >1 turn, none
// exercises successor transfer under an active query scope, and none exercises
// two DIFFERENT triggering exchanges whose chains can collide on the ONE
// visited set shared across the whole resolution phase. Added independently
// while verifying T4, not part of the coder's own submission.
// ---------------------------------------------------------------------------

describe("selectWithProvenance — tester-added coverage (independent T4 verification)", () => {
  test("exclusion removes ALL turns of a multi-turn exchange, and successor transfer adds ALL turns of a multi-turn successor (REQ-7/REQ-8 turn counts + span merge)", () => {
    const history = [
      turn({ exchangeId: "e1" }), // index 0: matches query -> base-selected
      turn({ exchangeId: "e1" }), // index 1: matches query -> base-selected, SAME exchange as index 0
      turn({ exchangeId: "e2", embedding: v(0, 1) }), // index 2: orthogonal -> not base-selected on its own
      turn({ exchangeId: "e2", embedding: v(0, 1) }), // index 3: orthogonal, SAME exchange as index 2
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0, 1]); // sanity: base carries BOTH e1 turns, neither e2 turn

    const snapshot = okSnapshot([
      // e1: all-DEAD (one row suffices), base-selected -> triggering; its successor is e2.
      row({ exchangeId: "e1", factId: "a1", reviewedObsolete: true, successorExchangeId: "e2", queryMatch: true }),
      // e2: LIVE -> not excluded -> eligible successor.
      row({ exchangeId: "e2", factId: "c1", active: true, factTable: "variable_changes" }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.excludedTurnCount).toBe(2); // BOTH of e1's turns, not just one
    expect(d.provenance.successorAddedCount).toBe(1);
    expect(d.provenance.droppedWithoutSuccessor).toBe(0);
    expect(d.selectedIndices).toEqual([2, 3]); // BOTH of e2's turns replace BOTH of e1's
    expect(d.prunedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual([[2, 3]]); // merged into ONE contiguous span, not two singleton spans
  });

  test("successor transfer resolves under an active query scope, and prunedIndices still includes an out-of-scope turn (matches prune()'s own scoped convention)", () => {
    const history = [
      turn({ exchangeId: "e1", scopeId: "target" }), // index 0: in scope, matches query -> base-selected
      turn({ exchangeId: "e2", scopeId: "target", embedding: v(0, 1) }), // index 1: in scope, orthogonal
      turn({ exchangeId: "out", scopeId: "other-scope" }), // index 2: OUT of scope; would match the query if it were in scope
    ];
    const base = prune(v(1, 0), history, params(), "target");
    expect(base.selectedIndices).toEqual([0]); // sanity
    expect(base.prunedIndices).toEqual([1, 2]); // sanity: base's own prunedIndices already spans the FULL history, incl. the out-of-scope turn

    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "a1", reviewedObsolete: true, successorExchangeId: "e2", queryMatch: true }),
      row({ exchangeId: "e2", factId: "b1", active: true, factTable: "variable_changes" }),
    ]);
    const d = run(history, snapshot, "target");

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.successorAddedCount).toBe(1);
    expect(d.provenance.droppedWithoutSuccessor).toBe(0);
    expect(d.selectedIndices).toEqual([1]);
    expect(d.spans).toEqual([[1, 1]]);
    // The out-of-scope turn (index 2) is never in the window and never selected,
    // so it stays in prunedIndices exactly like it does in the base decision --
    // provenance changes WHICH in-window turns are selected, never the
    // full-history-complement shape of prunedIndices itself.
    expect(d.prunedIndices).toEqual([0, 2]);
  });

  test("a triggering exchange's chain can pass through ANOTHER triggering exchange; the ONE shared visited set lets BOTH claim the same downstream successor (D1)", () => {
    // A (triggering via DEAD+queryMatch) -> D (ALSO triggering via DEAD+queryMatch,
    // and itself excluded) -> F (LIVE, eligible). A is processed first (earlier
    // turn index) and reaches F via a pass-through through D. When D is THEN
    // processed as its own top-level trigger, F is already visited AND already
    // recorded in `successorAddedExchangeIds` (A's chain already resolved TO
    // it), so D resolves to that SAME F too (D1) instead of being dropped --
    // F itself is never re-entered (A's chain already descended from it once,
    // finding it eligible), but the destination that descent found, F, is a
    // valid resolution for D as well: F is genuinely live and reachable from
    // both A and D. F's turns are still only ever added once, since the
    // caller merges every source into one Set.
    const history = [turn({ exchangeId: "A", embedding: v(0, 1) }), turn({ exchangeId: "D", embedding: v(0, 1) }), turn({ exchangeId: "F", embedding: v(0, 1) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: nothing base-selected -- both triggers below fire via DEAD+queryMatch, not base selection

    const snapshot = okSnapshot([
      row({ exchangeId: "A", factId: "a1", reviewedObsolete: true, successorExchangeId: "D", queryMatch: true }),
      row({ exchangeId: "D", factId: "d1", reviewedObsolete: true, successorExchangeId: "F", queryMatch: true }),
      row({ exchangeId: "F", factId: "f1", active: true, factTable: "variable_changes" }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(2); // A and D
    expect(d.provenance.excludedTurnCount).toBe(2);
    expect(d.provenance.successorAddedCount).toBe(1); // F is the one DISTINCT successor exchange added -- claimed by BOTH A and D, not two
    expect(d.provenance.droppedWithoutSuccessor).toBe(0); // D resolves to F too (D1) -- neither triggering exchange is dropped
    // `successorAddedCount` counts DISTINCT successor exchanges added, not
    // distinct resolved triggers, so it no longer sums with
    // `droppedWithoutSuccessor` to the triggering-exchange count now that two
    // triggers (A, D) can legitimately share one successor (F): 1 + 0 = 1,
    // not 2. (The old invariant assumed one claim per successor could only
    // ever come from one trigger -- exactly the assumption D1 corrects.)
    expect(d.selectedIndices).toEqual([2]); // only F's turn survives, added exactly once
    expect(d.prunedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual([[2, 2]]);
  });
});

// ---------------------------------------------------------------------------
// T5: REQ-9 set-based rescue.
//
// "The base did not fully select" is checked against the RAW base decision
// (`base.selectedIndices`, `prune()`'s own output) -- the same notion T4's own
// `wasBaseSelected` already uses for REQ-8's trigger condition, not the
// REQ-7/8-adjusted working selection. One consequence, pinned explicitly
// below rather than left an unverified assumption: an exchange REQ-8 already
// added via successor transfer can ALSO independently satisfy REQ-9 and be
// counted as rescued too -- the two counts describe two independent,
// non-exclusive facts about the exchange (was it a successor target? does it
// separately meet the rescue conditions?), not a partition of exchanges, and
// the exchange's turns are only ever added once to the actual selection.
// ---------------------------------------------------------------------------

describe("selectWithProvenance — rescue (REQ-9)", () => {
  test("a dormant, base-unselected exchange is rescued when its sole KEYED fact matches the query and is uncontested (dormant_sole shape)", () => {
    const history = [turn({ exchangeId: "e1", embedding: v(0, 1) })]; // orthogonal -> base does not select it at all
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: base leaves this exchange out entirely

    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-a"], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(1);
    expect(d.provenance.rescuedTurnCount).toBe(1);
    expect(d.selectedIndices).toEqual([0]);
    expect(d.prunedIndices).toEqual([]);
    expect(d.spans).toEqual([[0, 0]]);
  });

  test("rescue is set-based: an ineligible middle exchange between two rescued exchanges is never carried along merely by position (multi_distinct_keys shape)", () => {
    const history = [
      turn({ exchangeId: "A", embedding: v(0, 1) }), // 0: orthogonal -> base selects nothing
      turn({ exchangeId: "MID", embedding: v(0, 1) }), // 1: orthogonal, sits between A and C
      turn({ exchangeId: "C", embedding: v(0, 1) }), // 2: orthogonal
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: base selects none of the three

    const snapshot = okSnapshot([
      row({ exchangeId: "A", factId: "a1", factTable: "variable_changes", active: true, keyHashes: ["hash-a"], queryMatch: true }),
      // MID holds a LIVE+KEYED fact too, so this is not merely "fact-less" --
      // queryMatch=false is a SUBSTANTIVE REQ-9(b) failure, pinning that a
      // middle exchange's own content, not its position, decides eligibility.
      row({ exchangeId: "MID", factId: "m1", factTable: "variable_changes", active: true, keyHashes: ["hash-mid"], queryMatch: false }),
      row({ exchangeId: "C", factId: "c1", factTable: "variable_changes", active: true, keyHashes: ["hash-c"], queryMatch: true }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(2); // A and C, never MID
    expect(d.provenance.rescuedTurnCount).toBe(2);
    expect(d.selectedIndices).toEqual([0, 2]); // MID (index 1) is never carried
    expect(d.prunedIndices).toEqual([1]);
    expect(d.spans).toEqual([
      [0, 0],
      [2, 2],
    ]); // two disjoint spans, never merged into one [0,2] run
  });

  describe("Todo-only / INERT-only exchanges are never rescue-eligible (falls out of the KEYED+LIVE requirement)", () => {
    test("Todo-only (todo_only shape): never KEYED, so REQ-9(b) can never be satisfied even with queryMatch=true", () => {
      const history = [turn({ exchangeId: "e1", embedding: v(0, 1) })];
      const base = prune(v(1, 0), history, params());
      expect(base.selectedIndices).toEqual([]);

      const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "t1", factTable: "todos", active: true, keyHashes: [], queryMatch: true })]);
      const d = run(history, snapshot);

      expect(d.provenance.reason).toBeNull();
      expect(d.provenance.rescuedExchangeCount).toBe(0);
      expect(d.provenance.rescuedTurnCount).toBe(0);
      expect(d.selectedIndices).toEqual([]);
    });

    test("INERT-only: INERT is never KEYED (classifyFactRow), so REQ-9(b) can never be satisfied", () => {
      const history = [turn({ exchangeId: "e1", embedding: v(0, 1) })];
      const base = prune(v(1, 0), history, params());
      expect(base.selectedIndices).toEqual([]);

      const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "i1", factTable: "variable_changes", active: false, keyHashes: ["hash-i"], queryMatch: true })]);
      const d = run(history, snapshot);

      expect(d.provenance.reason).toBeNull();
      expect(d.provenance.rescuedExchangeCount).toBe(0);
      expect(d.selectedIndices).toEqual([]);
    });
  });

  test("a mixed exchange (one DEAD + one otherwise-qualifying LIVE/KEYED fact) is never rescue-eligible -- REQ-9(a) is 'no DEAD fact anywhere', strictly stronger than REQ-7's 'not EVERY fact DEAD'", () => {
    const history = [turn({ exchangeId: "e1", embedding: v(0, 1) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]);

    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "dead-1", auditStatus: "CONFLICT" }), // DEAD
      row({ exchangeId: "e1", factId: "live-1", factTable: "variable_changes", active: true, keyHashes: ["hash-mixed"], queryMatch: true }), // otherwise perfectly rescue-eligible alone
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(0); // not ALL-DEAD -> REQ-7 does not exclude it
    expect(d.provenance.rescuedExchangeCount).toBe(0); // but REQ-9(a) still blocks rescue
    expect(d.selectedIndices).toEqual([]);
  });

  test("a single contested KEYED fact blocks rescue for the WHOLE exchange, even when another of its facts is uncontested and matches the query", () => {
    const history = [
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // orthogonal -> base does not select
      turn({ exchangeId: "e2" }), // matches query -> base-selected on its own merits
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([1]); // sanity

    const snapshot = okSnapshot([
      // e1 holds two facts: one clean (uncontested + queryMatch, would alone
      // satisfy REQ-9) and one that IS contested with e2's fact sharing a key
      // hash -- REQ-9(c) requires EVERY keyed fact of the exchange uncontested.
      row({ exchangeId: "e1", factId: "clean", factTable: "variable_changes", active: true, keyHashes: ["hash-clean"], queryMatch: true }),
      row({ exchangeId: "e1", factId: "disputed", factTable: "policy_updates", active: true, keyHashes: ["hash-disputed"], queryMatch: true }),
      row({ exchangeId: "e2", factId: "disputed-partner", factTable: "policy_updates", active: true, keyHashes: ["hash-disputed"], queryMatch: true }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.contestedFactCount).toBe(2); // "disputed" + its partner
    expect(d.provenance.rescuedExchangeCount).toBe(0); // e1 is blocked
    expect(d.provenance.rescuedTurnCount).toBe(0);
    expect(d.selectedIndices).toEqual([1]); // only e2 (already base-selected); e1 stays out
  });

  test("two exchanges sharing a contested key hash: NEITHER is rescued, even though each independently matches the query (contested_unattested shape)", () => {
    const history = [turn({ exchangeId: "e1", embedding: v(0, 1) }), turn({ exchangeId: "e2", embedding: v(0, 1) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]);

    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["shared-hash"], queryMatch: true }),
      row({ exchangeId: "e2", factId: "f2", factTable: "variable_changes", active: true, keyHashes: ["shared-hash"], queryMatch: true }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.contestedFactCount).toBe(2);
    expect(d.provenance.rescuedExchangeCount).toBe(0); // neither -- both are contested
    expect(d.selectedIndices).toEqual([]); // sameAsBase
  });

  test("an exchange already fully selected by the base is never counted as rescued, even when it also meets REQ-9's conditions", () => {
    const history = [turn({ exchangeId: "e1" })]; // matches query -> base-selected
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]);

    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-q"], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.rescuedExchangeCount).toBe(0);
    expect(d.provenance.rescuedTurnCount).toBe(0);
    expect(d.selectedIndices).toEqual([0]);
  });

  test("a partially base-selected exchange is completed via rescue when it meets REQ-9's conditions, and rescuedTurnCount counts ALL of its turns (not just the newly-added one)", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange -> base does NOT select this turn
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity: e1 is only PARTIALLY base-selected

    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-p"], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(1);
    expect(d.provenance.rescuedTurnCount).toBe(2); // ALL of e1's turns, matching excludedTurnCount's own convention
    expect(d.selectedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual([[0, 1]]);
  });

  test("rescue outcome does not depend on decay-relevant timestamps -- REQ-9 never reads decayed or normalized scores", () => {
    // similarity = -1 (opposite direction) keeps the single-turn decayed score
    // negative -- below the single-turn gate -- regardless of elapsed time, so
    // the base never selects this turn in EITHER run; only the MAGNITUDE of
    // decay differs between them, which is exactly what this test proves
    // rescue is blind to.
    const oldHistory = [turn({ exchangeId: "e1", embedding: v(-1, 0), timestampSeconds: NOW - 6000 })];
    const freshHistory = [turn({ exchangeId: "e1", embedding: v(-1, 0), timestampSeconds: NOW })];
    const baseOld = prune(v(1, 0), oldHistory, params());
    const baseFresh = prune(v(1, 0), freshHistory, params());
    expect(baseOld.selectedIndices).toEqual([]);
    expect(baseFresh.selectedIndices).toEqual([]);
    // Sanity: decay really did produce different raw scores between the two
    // runs (otherwise this test would not actually exercise anything).
    expect(Math.abs(baseOld.decayedScores[0]! - baseFresh.decayedScores[0]!)).toBeGreaterThan(0.01);

    const makeSnapshot = () => okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-decay"], queryMatch: true })]);
    const dOld = run(oldHistory, makeSnapshot());
    const dFresh = run(freshHistory, makeSnapshot());

    expect(dOld.provenance.rescuedExchangeCount).toBe(1);
    expect(dFresh.provenance.rescuedExchangeCount).toBe(1);
    expect(dOld.selectedIndices).toEqual([0]);
    expect(dFresh.selectedIndices).toEqual([0]);
  });

  test("an exchange added by successor transfer that ALSO independently meets REQ-9's conditions is counted under BOTH mechanisms -- eligibility is checked against the raw base decision (mirroring REQ-8's own 'was base-selected' check), and the two counts are independent, non-exclusive facts, not a partition; the turn itself is only ever added once", () => {
    const history = [turn({ exchangeId: "A", embedding: v(0, 1) }), turn({ exchangeId: "C", embedding: v(0, 1) })];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: base selects neither

    const snapshot = okSnapshot([
      // A: all-DEAD, queryMatch=true -> excluded AND triggering; successor is C.
      row({ exchangeId: "A", factId: "a1", reviewedObsolete: true, successorExchangeId: "C", queryMatch: true }),
      // C: LIVE + KEYED + queryMatch + uncontested -- independently satisfies REQ-9 too.
      row({ exchangeId: "C", factId: "c1", factTable: "variable_changes", active: true, keyHashes: ["hash-succ"], queryMatch: true }),
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.successorAddedCount).toBe(1); // C via REQ-8
    expect(d.provenance.rescuedExchangeCount).toBe(1); // C ALSO via REQ-9 -- both true at once, by design
    expect(d.provenance.rescuedTurnCount).toBe(1);
    expect(d.selectedIndices).toEqual([1]); // C's turn, added exactly once regardless
  });

  test("rescue resolves under an active query scope, and prunedIndices still includes the always-out-of-scope turn (matches prune()'s own scoped convention)", () => {
    const history = [
      turn({ exchangeId: "e1", scopeId: "target", embedding: v(0, 1) }), // in scope, orthogonal -> base does not select
      turn({ exchangeId: "out", scopeId: "other-scope" }), // always out of scope; would match the query if it were in scope
    ];
    const base = prune(v(1, 0), history, params(), "target");
    expect(base.selectedIndices).toEqual([]); // sanity: nothing base-selected within scope

    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-scope"], queryMatch: true })]);
    const d = run(history, snapshot, "target");

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(1);
    expect(d.selectedIndices).toEqual([0]);
    // The out-of-scope turn (index 1) is never in the window and never
    // rescued, so it stays in prunedIndices exactly like it does in the base
    // decision -- rescue changes WHICH in-window turns are selected, never
    // the full-history-complement shape of prunedIndices itself.
    expect(d.prunedIndices).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// T6: REQ-10 completion.
//
// "Once any turn of a trusted exchange is in the merged selection, include
// every in-window turn of that exchange, unless the exchange is excluded
// under REQ-7" (REQ-10). REQ-8/REQ-9 already add EVERY turn of whatever they
// act on, so the only exchanges completion ever has real work to do for are
// ones the base alone partially selected and that neither mechanism
// completed -- including an exchange with NO fact row at all (the fixture's
// `partner_completion` family: "if the base kept any turn of it, completion
// keeps both", AUTHORING.md's "List granularity" section).
// `completedTurnCount` counts only the turns completion itself newly flips
// to selected -- see the source file's own comment, right where it's
// computed, for why that differs from `excludedTurnCount`'s/
// `rescuedTurnCount`'s "every turn of the affected exchange" convention.
// ---------------------------------------------------------------------------

describe("selectWithProvenance — completion (REQ-10)", () => {
  test("a partially base-selected, fact-less exchange is completed to include all of its in-window turns (no fact rows at all -- the fixture's partner_completion shape)", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange -> base does not select this turn
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity: e1 is only partially base-selected

    const d = run(history, okSnapshot([])); // no fact rows at all

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(0);
    expect(d.provenance.rescuedExchangeCount).toBe(0);
    expect(d.provenance.successorAddedCount).toBe(0);
    expect(d.provenance.completedTurnCount).toBe(1); // only turn 1 is newly added
    expect(d.selectedIndices).toEqual([0, 1]);
    expect(d.prunedIndices).toEqual([]);
    expect(d.spans).toEqual([[0, 1]]);
  });

  test("an exchange with none of its turns base-selected, and no qualifying fact, is never touched by completion", () => {
    const history = [
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 0: orthogonal
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: base selects neither turn

    const d = run(history, okSnapshot([]));

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.completedTurnCount).toBe(0);
    expect(d.selectedIndices).toEqual([]);
  });

  test("an already fully base-selected multi-turn exchange has nothing left for completion (completedTurnCount 0)", () => {
    const history = [turn({ exchangeId: "e1" }), turn({ exchangeId: "e1" })]; // both match the query
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0, 1]); // sanity: fully selected already

    const d = run(history, okSnapshot([]));

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.completedTurnCount).toBe(0);
    expect(d.selectedIndices).toEqual([0, 1]);
    expect(d.spans).toEqual(base.spans);
  });

  test("an excluded exchange is never re-added by completion, even though the base originally selected part of it (REQ-10's own stated exception)", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange -> base does not select
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity

    // Both of e1's rows are DEAD -> the WHOLE exchange (all-DEAD, REQ-7) is excluded.
    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", auditStatus: "CONFLICT" }), row({ exchangeId: "e1", factId: "f2", auditStatus: "CONFLICT" })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.excludedTurnCount).toBe(2);
    expect(d.provenance.completedTurnCount).toBe(0); // REQ-10's own exception: excluded stays excluded
    expect(d.selectedIndices).toEqual([]);
  });

  test("a Todo-only exchange (ineligible for REQ-9 rescue) is still completed when the base partially selects it -- REQ-10's only exemption is REQ-7 exclusion, not REQ-9's stricter eligibility", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]);

    const snapshot = okSnapshot([row({ exchangeId: "e1", factTable: "todos", active: true, keyHashes: [], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(0); // Todo is never KEYED -> REQ-9 can't rescue it
    expect(d.provenance.excludedExchangeCount).toBe(0); // LIVE, not DEAD -> REQ-7 doesn't exclude it
    expect(d.provenance.completedTurnCount).toBe(1); // completion still fills the rest
    expect(d.selectedIndices).toEqual([0, 1]);
  });

  test("a MIXED exchange (one DEAD + one LIVE/KEYED/queryMatch fact), disqualified from rescue by REQ-9(a) but not excluded by REQ-7, is still completed when the base partially selects it", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]);

    const snapshot = okSnapshot([
      row({ exchangeId: "e1", factId: "dead-1", auditStatus: "CONFLICT" }), // DEAD
      row({ exchangeId: "e1", factId: "live-1", factTable: "variable_changes", active: true, keyHashes: ["hash-mixed"], queryMatch: true }), // LIVE+KEYED+queryMatch
    ]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(0); // mixed -> not all-DEAD -> REQ-7 doesn't exclude
    expect(d.provenance.rescuedExchangeCount).toBe(0); // REQ-9(a) still blocks rescue (a DEAD fact is present)
    expect(d.provenance.completedTurnCount).toBe(1); // completion is unconditional once not excluded
    expect(d.selectedIndices).toEqual([0, 1]);
  });

  test("completedTurnCount stays 0 when rescue alone already completed the exchange -- no double counting between REQ-9 and REQ-10", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange -> base does NOT select this turn
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity: e1 is only PARTIALLY base-selected

    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-p"], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(1);
    expect(d.provenance.rescuedTurnCount).toBe(2); // T5's own convention: ALL of e1's turns
    expect(d.provenance.completedTurnCount).toBe(0); // nothing left for completion to add
    expect(d.selectedIndices).toEqual([0, 1]);
  });

  test("scope: an out-of-scope turn sharing e1's exchangeId string is never added by completion, even though e1's in-scope turn is selected (REQ-4 applies to completion too)", () => {
    const history = [
      turn({ exchangeId: "e1", scopeId: "target" }), // 0: in scope, matches query -> base-selected
      turn({ exchangeId: "e1", scopeId: "other-scope" }), // 1: SAME exchangeId string, but OUT of the requested scope
    ];
    const base = prune(v(1, 0), history, params(), "target");
    expect(base.selectedIndices).toEqual([0]); // sanity: base only ever sees the in-scope turn

    const d = run(history, okSnapshot([]), "target");

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.completedTurnCount).toBe(0); // "in-window turn of that exchange" excludes index 1 entirely
    expect(d.selectedIndices).toEqual([0]);
    expect(d.prunedIndices).toEqual([1]);
  });

  test("tester-added (independent T6 verification): a 3-turn exchange with TWO missing turns is completed in full -- completedTurnCount counts both, not just the first gap", () => {
    // Every other completion test in this file uses a 2-turn exchange, so at
    // most ONE turn is ever missing from the base selection. That leaves a
    // real gap: a mutant that completes only the FIRST missing turn per
    // exchange (`indices.find(...)` instead of iterating all of `indices`)
    // passes every one of those tests unchanged. This test uses a 3-turn
    // exchange with turns 1 AND 2 both missing from the base selection, so a
    // "first missing turn only" mutant is caught here specifically.
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 1: orthogonal, SAME exchange -> base does not select
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 2: orthogonal, SAME exchange -> base does not select either
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0]); // sanity: e1 is selected for only 1 of its 3 turns

    const d = run(history, okSnapshot([])); // no fact rows at all -- completion is the only mechanism in play

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.completedTurnCount).toBe(2); // BOTH turn 1 and turn 2 are newly added, not just one
    expect(d.selectedIndices).toEqual([0, 1, 2]);
    expect(d.prunedIndices).toEqual([]);
    expect(d.spans).toEqual([[0, 2]]);
  });
});

// ---------------------------------------------------------------------------
// T6: REQ-3 unbound turns, exercised specifically against completion (the
// new T6 mechanism) -- T2-T5's own unbound coverage is folded into the guard
// tests above (e.g. "NO_SNAPSHOT takes precedence ... no turn carries an
// exchangeId either"). An unbound turn is one with no `exchangeId` (or an
// empty string, the codebase's existing "same as absent" convention -- see
// the source file's own `ProvenanceHistoryTurn` doc comment).
// ---------------------------------------------------------------------------

describe("selectWithProvenance — unbound turns stay untouched by completion (REQ-3)", () => {
  test("a base-selected unbound turn stays selected even when it sits right next to an excluded exchange", () => {
    const history = [
      turn({ exchangeId: "e1" }), // 0: matches query -> base-selected, excluded via REQ-7 below
      turn({}), // 1: UNBOUND, matches query -> base-selected, must stay selected (untouched by exclusion)
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0, 1]); // sanity: base selects both (one contiguous span)

    const snapshot = okSnapshot([row({ exchangeId: "e1", auditStatus: "CONFLICT" })]); // e1 all-DEAD -> excluded
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.excludedExchangeCount).toBe(1);
    expect(d.provenance.excludedTurnCount).toBe(1); // only e1's own turn, never the unbound one
    expect(d.selectedIndices).toEqual([1]); // the unbound turn survives untouched
    expect(d.prunedIndices).toEqual([0]);
  });

  test("an unbound turn the base never selected is never pulled in by a neighboring exchange's rescue", () => {
    const history = [
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 0: orthogonal -> base does not select
      turn({ embedding: v(0, 1) }), // 1: UNBOUND, orthogonal -> base does not select either
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 2: SAME exchange as 0, orthogonal
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([]); // sanity: base selects nothing

    // e1 (turns 0 and 2) is rescued: LIVE+KEYED+queryMatch, uncontested.
    const snapshot = okSnapshot([row({ exchangeId: "e1", factId: "f1", factTable: "variable_changes", active: true, keyHashes: ["hash-u"], queryMatch: true })]);
    const d = run(history, snapshot);

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.rescuedExchangeCount).toBe(1);
    expect(d.provenance.rescuedTurnCount).toBe(2);
    expect(d.selectedIndices).toEqual([0, 2]); // the unbound middle turn (1) is never carried along
    expect(d.prunedIndices).toEqual([1]);
  });

  test('exchangeId: "" is treated as unbound, exactly like a missing exchangeId, and never touched by completion', () => {
    const history = [
      turn({ exchangeId: "" }), // 0: empty string -> treated as unbound, matches query -> base-selected
      turn({ exchangeId: "e1" }), // 1: valid, matches query -> base-selected
      turn({ exchangeId: "e1", embedding: v(0, 1) }), // 2: SAME exchange as 1, orthogonal -> base does not select
    ];
    const base = prune(v(1, 0), history, params());
    expect(base.selectedIndices).toEqual([0, 1]); // sanity

    const d = run(history, okSnapshot([]));

    expect(d.provenance.reason).toBeNull();
    expect(d.provenance.completedTurnCount).toBe(1); // only e1's own turn 2 is newly added
    expect(d.selectedIndices).toEqual([0, 1, 2]); // turn 0 (unbound-by-empty-string) stays exactly as the base left it
    expect(d.prunedIndices).toEqual([]);
    expect(d.spans).toEqual([[0, 2]]); // contiguous merge, incidental to span recomputation
  });

  test("a history where the ONLY exchangeId is the empty string has no trusted exchangeId at all (NO_EXCHANGE_IDS), regardless of what a snapshot declares", () => {
    const d = run([turn({ exchangeId: "" })], okSnapshot([]));
    expect(d.provenance.reason).toBe("NO_EXCHANGE_IDS");
    expect(d.provenance.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T6: REQ-1 property test.
//
// "The same (queryEmbedding, history, params, queryScopeId) can be handed to
// prune() and to selectWithProvenance() (with snapshot omitted) and must
// produce an identical spans/selectedIndices/prunedIndices/candidateIndices/
// decayedScores/normalizedScores/params" (the source file's own header).
// This holds not only with `snapshot` omitted, but whenever a REQ-2 guard
// fires for ANY reason -- this test drives the two REQ-1-relevant guards
// (NO_SNAPSHOT, NO_EXCHANGE_IDS) directly, over many randomized histories,
// rather than relying on a handful of hand-picked ones.
//
// No property-testing library (e.g. fast-check) is a dependency of this
// repo (package.json), and none is added here -- this is a small, inline,
// seeded PRNG (mulberry32) driving plain loops, deterministic given a fixed
// numeric seed and a fixed clock (`NOW`, already defined above).
// ---------------------------------------------------------------------------

describe("selectWithProvenance — REQ-1 property test (randomized, seeded)", () => {
  /** mulberry32: a tiny, fast, deterministic 32-bit PRNG. Same seed -> same infinite sequence, every time, on every platform (only integer ops + one division). */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return (): number => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SCOPE_CHOICES = [undefined, "scope-a", "scope-b"] as const;
  const EXCHANGE_CHOICES = [undefined, "ex-1", "ex-2", "ex-3"] as const;

  function pick<T>(rng: () => number, choices: readonly T[]): T {
    return choices[Math.floor(rng() * choices.length)]!;
  }

  /** A random turn count 0..12, random 2-D embedding, an age within 20000s of NOW, and a random scopeId. `forceNoExchangeIds` drives the NO_EXCHANGE_IDS branch of REQ-1 (every turn's exchangeId forced absent). */
  function randomHistory(rng: () => number, forceNoExchangeIds: boolean): ProvenanceHistoryTurn[] {
    const length = Math.floor(rng() * 13); // 0..12 turns
    const history: ProvenanceHistoryTurn[] = [];
    for (let i = 0; i < length; i++) {
      history.push({
        embedding: v(rng() * 2 - 1, rng() * 2 - 1),
        timestampSeconds: NOW - Math.floor(rng() * 20000),
        scopeId: pick(rng, SCOPE_CHOICES),
        exchangeId: forceNoExchangeIds ? undefined : pick(rng, EXCHANGE_CHOICES),
      });
    }
    return history;
  }

  function randomDialParams(rng: () => number): KadaneDialParams {
    return {
      lambda: 0.5 + rng() * 0.5, // (0.5, 1.0], valid per applyTemporalDecay's own (0,1] contract
      gainShift: rng() * 2 - 1, // [-1, 1)
      theta: 0.1 + rng() * 2.9, // (0.1, 3), theta is documented as > 0
      nowSeconds: NOW,
    };
  }

  /** A nonempty scopeId or undefined -- prune() itself throws RangeError on an empty-string scope, which is not what this property test is about. */
  function randomScopeId(rng: () => number): string | undefined {
    return rng() < 0.5 ? undefined : rng() < 0.5 ? "scope-a" : "scope-b";
  }

  const REQ1_SUBFIELDS = ["spans", "selectedIndices", "prunedIndices", "candidateIndices", "decayedScores", "normalizedScores", "params"] as const;

  /** Extract exactly REQ-1's named sub-fields -- never the whole object, which legitimately carries `provenance` (selectWithProvenance) or not (prune()). */
  function pickReq1Fields(decision: object): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const key of REQ1_SUBFIELDS) picked[key] = (decision as Record<string, unknown>)[key];
    return picked;
  }

  test("no snapshot supplied: selectWithProvenance deep-equals prune() on REQ-1's named sub-fields, across 200 randomized scoped/unscoped trials (seed 424242)", () => {
    const rng = mulberry32(424242);
    for (let trial = 0; trial < 200; trial++) {
      const history = randomHistory(rng, false);
      const dialParams = randomDialParams(rng);
      const queryScopeId = randomScopeId(rng);
      const queryEmbedding = v(rng() * 2 - 1, rng() * 2 - 1);

      const expected = prune(queryEmbedding, history, dialParams, queryScopeId);
      const actual = selectWithProvenance(queryEmbedding, history, dialParams, queryScopeId, undefined);

      expect(pickReq1Fields(actual)).toEqual(pickReq1Fields(expected));
    }
  });

  test("snapshot supplied but no turn carries an exchangeId: selectWithProvenance deep-equals prune() on REQ-1's named sub-fields, across 200 randomized scoped/unscoped trials (seed 13371337)", () => {
    const rng = mulberry32(13371337);
    for (let trial = 0; trial < 200; trial++) {
      const history = randomHistory(rng, true); // every turn's exchangeId forced absent
      const dialParams = randomDialParams(rng);
      const queryScopeId = randomScopeId(rng);
      const queryEmbedding = v(rng() * 2 - 1, rng() * 2 - 1);
      // The snapshot's own content is irrelevant: NO_EXCHANGE_IDS fires
      // before checkGuards ever inspects failedExchangeIds or lookup.kind.
      const snapshot: ProvenanceSnapshot = {
        lookup: rng() < 0.8 ? { kind: "ok", rows: [] } : { kind: "error" },
        failedExchangeIds: rng() < 0.3 ? new Set(["some-exchange"]) : new Set(),
      };

      const expected = prune(queryEmbedding, history, dialParams, queryScopeId);
      const actual = selectWithProvenance(queryEmbedding, history, dialParams, queryScopeId, snapshot);

      expect(actual.provenance.reason).toBe("NO_EXCHANGE_IDS"); // confirms this trial actually exercises REQ-1's second clause, not a vacuous pass
      expect(pickReq1Fields(actual)).toEqual(pickReq1Fields(expected));
    }
  });

  test("reproducibility: the same seed produces byte-identical results across two independent runs", () => {
    function runSeeded(): unknown[] {
      const rng = mulberry32(999888777);
      const results: unknown[] = [];
      for (let trial = 0; trial < 30; trial++) {
        const forceNoExchangeIds = trial % 2 === 0;
        const history = randomHistory(rng, forceNoExchangeIds);
        const dialParams = randomDialParams(rng);
        const queryScopeId = randomScopeId(rng);
        const queryEmbedding = v(rng() * 2 - 1, rng() * 2 - 1);
        const snapshot: ProvenanceSnapshot | undefined = forceNoExchangeIds ? { lookup: { kind: "ok", rows: [] }, failedExchangeIds: new Set() } : undefined;

        const actual = selectWithProvenance(queryEmbedding, history, dialParams, queryScopeId, snapshot);
        results.push(pickReq1Fields(actual));
      }
      return results;
    }

    const firstRun = runSeeded();
    const secondRun = runSeeded();
    expect(secondRun).toEqual(firstRun);
    // Pin the PRNG's own first few draws too, so a later edit to mulberry32
    // itself (not just to how it's used) would be caught here rather than
    // only silently reshaping which random cases get exercised.
    const pinned = mulberry32(999888777);
    expect([pinned(), pinned(), pinned()]).toEqual([0.5451790934894234, 0.6698858758900315, 0.17028897907584906]);
  });
});

// ---------------------------------------------------------------------------
// Review concern 11: KNOWN_FACT_TABLES (just made `export`ed above this
// file's own import) is a hand-duplicated literal mirror of FACT_TABLES's
// values (src/memory/warm/tier2.ts) -- by design, so this pure/offline
// module carries no import-graph dependency on memory/warm's Supabase-facing
// code (see provenance-select.ts's own doc comment immediately above the
// KNOWN_FACT_TABLES declaration). A hand-duplicated literal can silently
// drift from its source of truth -- e.g. a 7th fact table lands in
// FACT_TABLES but this file's hand-copied array is never updated -- with
// nothing else in the suite to catch it. This guards exactly that.
// ---------------------------------------------------------------------------

describe("KNOWN_FACT_TABLES (review concern 11) -- stays in sync with FACT_TABLES's values", () => {
  test("equals the set of table names in FACT_TABLES (src/memory/warm/tier2.ts) -- guards against literal-duplicate drift", () => {
    expect(KNOWN_FACT_TABLES, "KNOWN_FACT_TABLES vs new Set(Object.values(FACT_TABLES))").toEqual(new Set(Object.values(FACT_TABLES)));
  });
});
