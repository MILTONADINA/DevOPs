/**
 * Supersession suppression (ADR-0011 primary fix) — a mechanism ORTHOGONAL to
 * temporal decay.
 *
 * KadaneDial selects CONTIGUOUS spans, so it can over-retain a stale turn adjacent
 * to the relevance peak — the documented `tb-negation` limitation: it keeps a
 * superseded "deploy on AWS Lambda" plan beside the correct "deploy on Cloudflare
 * Workers" decision. Temporal decay (λ) cannot fix this without breaking
 * `tb-dormant` (the two pull λ in OPPOSITE directions — see kadanedial.ts header +
 * ADR-0011). The fix is orthogonal to λ: using the Tier-3 supersession edges
 * (KnowledgeGraph.findSuperseded, built on Supabase in ADR-0013), drop a selected
 * turn whose entity is SUPERSEDED by another entity ALSO present in the selection.
 *
 * This module is PURE (no graph/DB calls) and DEFAULT-OFF — it is NOT wired into
 * the request path. Per ADR-0011 + the constitution, activation as a pruner default
 * awaits a Tier-A faithfulness validation (<5% degradation). It is exercised in
 * tests to show it resolves the synthetic `tb-negation` over-retention (logic-proven).
 */

/** A selected turn that may carry the knowledge-graph entity it concerns. */
export interface SupersedableTurn {
  /** The turn's index (e.g. into the pruner's selection). */
  index: number;
  /** The entity this turn concerns (e.g. a decision name), if known. */
  entity?: string;
}

/** A supersession pair from KnowledgeGraph.findSuperseded (`superseded` ← `supersededBy`). */
export interface SupersessionPair {
  superseded: string;
  supersededBy: string;
}

/**
 * Drop turns whose entity is superseded by an entity ALSO present in the turn set.
 *
 * A turn is suppressed iff: it has an entity `E`; some pair
 * `{superseded: E, supersededBy: S}` exists; AND `S` is the entity of some turn in
 * `turns` (the superseding decision is present in the same context). Turns with no
 * entity — or whose superseding entity is absent — are kept. This is intentionally
 * the "superseding entity is PRESENT" case; the "more recent but absent" case in
 * ADR-0011 needs per-entity timestamps and is a later extension.
 *
 * @param turns - the selected turns (index + optional entity).
 * @param supersessions - supersession pairs (`superseded` ← `supersededBy`).
 * @returns the surviving turn indices, in input order.
 */
export function suppressSuperseded(turns: SupersedableTurn[], supersessions: SupersessionPair[]): number[] {
  const presentEntities = new Set<string>();
  for (const t of turns) if (t.entity !== undefined) presentEntities.add(t.entity);

  // An entity is suppressible only when its superseding entity is also present.
  const suppressible = new Set<string>();
  for (const p of supersessions) {
    if (presentEntities.has(p.supersededBy)) suppressible.add(p.superseded);
  }

  return turns.filter((t) => !(t.entity !== undefined && suppressible.has(t.entity))).map((t) => t.index);
}
