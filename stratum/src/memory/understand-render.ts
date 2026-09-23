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

/** ref → resolved fact content (factToText), for content-free vector hits. */
export type ContentByRef = Map<string, string>;

function matchLine(m: VectorMatch, content?: ContentByRef): string {
  const ref = m.sourceRef ?? "?";
  const resolved = m.sourceRef ? content?.get(m.sourceRef) : undefined;
  const tail = resolved ? ` — ${resolved}` : "";
  return `${m.sourceType}:${ref}  (similarity ${m.similarity.toFixed(2)})${tail}`;
}

function renderRelated(related: VectorMatch[], content?: ContentByRef): string[] {
  if (related.length === 0) return ["  Related (semantic): —"];
  const lines = ["  Related (semantic):"];
  for (const m of related) lines.push(`    • ${matchLine(m, content)}`);
  return lines;
}

/**
 * Render an entity's understanding as a status report.
 *
 * @param u - the {@link EntityUnderstanding} from understandEntity.
 * @param content - optional ref → fact-content map to enrich semantic neighbours.
 * @returns a multi-line human-readable report.
 */
export function renderUnderstanding(u: EntityUnderstanding, content?: ContentByRef): string {
  const lines: string[] = [`Entity: ${u.name}`];
  lines.push(`  Status: ${u.isSuperseded ? "SUPERSEDED" : "current"}`);
  if (u.isSuperseded) lines.push(`  Superseded by: ${names(u.supersededBy)}`);
  if (u.supersedes.length) lines.push(`  Supersedes: ${names(u.supersedes)}`);
  if (u.deprecatedBy.length) lines.push(`  Deprecated by: ${names(u.deprecatedBy)}`);
  if (u.referencedBy.length) lines.push(`  Referenced by: ${names(u.referencedBy)}`);

  const hasGraph = u.isSuperseded || u.supersedes.length > 0 || u.deprecatedBy.length > 0 || u.referencedBy.length > 0;
  if (!hasGraph) lines.push("  (no graph relations recorded for this entity)");

  if (u.related !== undefined) lines.push(...renderRelated(u.related, content));
  return lines.join("\n");
}

/**
 * Render a bare semantic-search result set (query-only mode, no entity).
 *
 * @param query - the search text.
 * @param matches - the vector hits.
 * @param content - optional ref → fact-content map (resolves content-free hits).
 * @returns a multi-line human-readable report.
 */
export function renderMatches(query: string, matches: VectorMatch[], content?: ContentByRef): string {
  const lines = [`Semantic search: "${query}"`];
  if (matches.length === 0) {
    lines.push("  (no neighbours found — the vector index may be empty for this org)");
    return lines.join("\n");
  }
  for (const m of matches) lines.push(`  • ${matchLine(m, content)}`);
  return lines.join("\n");
}
