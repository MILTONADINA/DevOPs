/**
 * Tier-C golden-query checks (Phase 2 / v0.4.x) — deterministic, no judge.
 *
 * A golden query asserts that a specific fact SURVIVES pruning: the pruned
 * context must contain certain substrings (the right answer's anchors) and must
 * NOT contain others (the stale/wrong answer). This is a pure substring check
 * over the pruned context text — no LLM, no dataset beyond the query specs — so
 * it is fully testable now. Per docs/EVAL_FRAMEWORK.md, CRITICAL golden queries
 * must pass 100%; any critical failure rejects the whole run.
 *
 * Matching is CASE-SENSITIVE: golden anchors are typically identifiers
 * (`fetchUser` vs `getUser`) where case carries meaning.
 */

import type { GoldenQuery, GoldenResult } from "./types";

/**
 * Check one golden query against the pruned context text.
 *
 * @param prunedContextText - the context that survived pruning, as text.
 * @param query - the golden query spec.
 * @returns the {@link GoldenResult} (passed iff all required present + none forbidden).
 */
export function checkGoldenQuery(prunedContextText: string, query: GoldenQuery): GoldenResult {
  const missing = query.expectedContains.filter((s) => !prunedContextText.includes(s));
  const leaked = query.expectedNotContains.filter((s) => prunedContextText.includes(s));
  // A query with NO assertions (empty contains AND notContains) must NOT vacuously pass — both
  // .filter()s are empty so missing/leaked are [], which would otherwise PASS a CRITICAL golden that
  // proves nothing. Require at least one assertion (defense-in-depth alongside the loader's reject).
  const hasAssertion = query.expectedContains.length > 0 || query.expectedNotContains.length > 0;
  return { query, passed: hasAssertion && missing.length === 0 && leaked.length === 0, missing, leaked };
}

/** Number of CRITICAL golden queries that failed (the hard gate). */
export function criticalFailures(results: GoldenResult[]): number {
  return results.filter((r) => r.query.critical && !r.passed).length;
}
