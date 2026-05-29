/**
 * /understand-codebase — render layer (Phase 3 / v0.5.x).
 *
 * Pure formatting of an {@link EntityUnderstanding} (the query core's output,
 * understand.ts) into a concise human-readable status report — the text a
 * developer sees from `npm run understand-codebase`. No I/O, no model, no DB:
 * fully unit-tested. The CLI (scripts/understand-codebase.ts) wires the live
 * graph/vector store + the local encoder and calls this.
 */

import type { EntityUnderstanding } from "./understand";
import type { VectorMatch } from "./cold/vectors";

/** Join a name list for display, or "—" when empty. */
function names(list: string[]): string {
  return list.length ? list.join(", ") : "—";
}

function renderRelated(related: VectorMatch[]): string[] {
  if (related.length === 0) return ["  Related (semantic): —"];
  const lines = ["  Related (semantic):"];
  for (const m of related) {
    const ref = m.sourceRef ?? "?";
    lines.push(`    • ${m.sourceType}:${ref}  (similarity ${m.similarity.toFixed(2)})`);
  }
  return lines;
}

/**
 * Render an entity's understanding as a status report.
 *
 * @param u - the {@link EntityUnderstanding} from understandEntity.
 * @returns a multi-line human-readable report.
 */
export function renderUnderstanding(u: EntityUnderstanding): string {
  const lines: string[] = [`Entity: ${u.name}`];
  lines.push(`  Status: ${u.isSuperseded ? "SUPERSEDED" : "current"}`);
  if (u.isSuperseded) lines.push(`  Superseded by: ${names(u.supersededBy)}`);
  if (u.supersedes.length) lines.push(`  Supersedes: ${names(u.supersedes)}`);
  if (u.deprecatedBy.length) lines.push(`  Deprecated by: ${names(u.deprecatedBy)}`);
  if (u.referencedBy.length) lines.push(`  Referenced by: ${names(u.referencedBy)}`);

  const hasGraph = u.isSuperseded || u.supersedes.length > 0 || u.deprecatedBy.length > 0 || u.referencedBy.length > 0;
  if (!hasGraph) lines.push("  (no graph relations recorded for this entity)");

  if (u.related !== undefined) lines.push(...renderRelated(u.related));
  return lines.join("\n");
}

/** Render a bare semantic-search result set (query-only mode, no entity). */
export function renderMatches(query: string, matches: VectorMatch[]): string {
  const lines = [`Semantic search: "${query}"`];
  if (matches.length === 0) {
    lines.push("  (no neighbours found — the vector index may be empty for this org)");
    return lines.join("\n");
  }
  for (const m of matches) {
    lines.push(`  • ${m.sourceType}:${m.sourceRef ?? "?"}  (similarity ${m.similarity.toFixed(2)})`);
  }
  return lines.join("\n");
}
